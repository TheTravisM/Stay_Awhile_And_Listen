import base64
import json
import sys
import threading
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from engines import get_engine

app = FastAPI()

engine = get_engine()
_synthesis_lock = threading.Lock()


# Engines that pay a one-time setup cost declare ``warm_up_at_startup = True``
# on their class, so the registry decides who is warmed up instead of a list
# kept here. The streaming engine also provides ``warm_up()``: on its compiled
# path (CAIN_STREAMING_OPTIMIZE=1) the first generations are what build the
# torch.compile kernels, so that cost must be paid at startup rather than on the
# user's first read. ``cain`` keeps the plain one-sentence warm-up below.
WARMUP_TEXT = "Stay awhile and listen."


def _warm_up() -> None:
    # ``getattr`` keeps third-party engines that predate the flag working.
    if not getattr(engine, "warm_up_at_startup", False):
        return
    try:
        with _synthesis_lock:
            warm_up = getattr(engine, "warm_up", None)
            if callable(warm_up):
                warm_up()
            else:
                engine.synthesize(WARMUP_TEXT, 1.0)
    except Exception as e:
        print(f"{engine.name} warmup failed: {e}", file=sys.stderr)


_warm_up()


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
def health():
    return {"ok": True, "engine": engine.name, "voice": "cain"}


@app.post("/tts")
def tts(req: TTSRequest):
    started = time.perf_counter()
    try:
        with _synthesis_lock:
            wav = engine.synthesize(req.text, req.speed)
    except Exception as e:
        print(f"tts timing: request={time.perf_counter() - started:.3f}s (error)", file=sys.stderr)
        return JSONResponse(status_code=500, content={"error": str(e)})
    print(f"tts timing: request={time.perf_counter() - started:.3f}s", file=sys.stderr)
    return Response(content=wav, media_type="audio/wav")


# --- Streaming endpoint (T12.2) ---------------------------------------------
# Wire format: newline-delimited JSON (NDJSON, UTF-8), exactly one JSON object
# per line, each terminated by "\n". Records:
#
#   {"type":"chunk","index":0,"sample_rate":24000,"channels":1,
#    "encoding":"pcm_s16le","samples":1920,"audio":"<base64>"}
#   {"type":"done","chunks":N,"samples":M,"sample_rate":24000,"duration_s":S}
#   {"type":"error","error":"<message>"}
#
# `audio` is base64 of raw little-endian signed 16-bit MONO PCM at the
# `sample_rate` carried on every chunk record. Chunks are emitted as soon as the
# engine produces them (nothing is buffered first), so the first record already
# tells the client the sample rate and encoding; `index` is 0-based and strictly
# increasing. A final `done` record closes a successful stream; an `error`
# record replaces `done` if generation fails part-way or produces no audio
# (HTTP status is already 200 by then, so failures are reported in-band).
# Engines without a `stream()` method get HTTP 501; request values the engine
# rejects (e.g. speed != 1.0) get HTTP 400 before any audio is sent.
STREAM_MEDIA_TYPE = "application/x-ndjson"
STREAM_PCM_ENCODING = "pcm_s16le"


def _ndjson(payload: dict) -> str:
    return json.dumps(payload, separators=(",", ":")) + "\n"


def _close_stream(gen) -> None:
    """Close a streamed generator whose client may have gone away.

    Starlette wraps a synchronous body iterator in ``iterate_in_threadpool`` and
    never closes it, so a client that aborts mid-stream (the extension's Stop)
    leaves the generator suspended at its ``yield`` with ``_synthesis_lock``
    held; the lock would then be released only whenever CPython happens to
    finalise the generator, and until then every later ``/tts`` and
    ``/tts/stream`` request blocked and produced no audio. Background tasks run
    on disconnect too, so closing here ties the lock to the response lifetime.
    """
    try:
        gen.close()
    except Exception as e:  # pragma: no cover - close must not fail the request
        print(f"tts stream close failed: {e}", file=sys.stderr)


@app.post("/tts/stream")
def tts_stream(req: TTSRequest):
    """Stream synthesis as NDJSON audio-chunk records (format documented above)."""
    stream = getattr(engine, "stream", None)
    if not callable(stream):
        return JSONResponse(
            status_code=501,
            content={"error": f"engine {engine.name!r} does not support streaming"},
        )
    try:
        # Validation is eager in the streaming engine, so bad input is rejected
        # here (HTTP 400) instead of inside an already-started 200 response.
        chunks = stream(req.text, req.speed)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    def generate():
        started = time.perf_counter()
        first_chunk_s = None
        sent = 0
        samples = 0
        sample_rate = None
        try:
            # Same lock as POST /tts: one generation at a time, held for the
            # whole stream and released on completion, error or disconnect.
            with _synthesis_lock:
                for pcm, chunk_rate in chunks:
                    if first_chunk_s is None:
                        first_chunk_s = time.perf_counter() - started
                    sample_rate = int(chunk_rate)
                    chunk_samples = len(pcm) // 2
                    samples += chunk_samples
                    yield _ndjson(
                        {
                            "type": "chunk",
                            "index": sent,
                            "sample_rate": sample_rate,
                            "channels": 1,
                            "encoding": STREAM_PCM_ENCODING,
                            "samples": chunk_samples,
                            "audio": base64.b64encode(pcm).decode("ascii"),
                        }
                    )
                    sent += 1

            if sent == 0:
                yield _ndjson({"type": "error", "error": "streaming produced no audio"})
                return

            yield _ndjson(
                {
                    "type": "done",
                    "chunks": sent,
                    "samples": samples,
                    "sample_rate": sample_rate,
                    "duration_s": (samples / sample_rate) if sample_rate else 0.0,
                }
            )
        except Exception as exc:
            print(
                f"tts timing: stream={time.perf_counter() - started:.3f}s (error)",
                file=sys.stderr,
            )
            yield _ndjson({"type": "error", "error": str(exc)})
        finally:
            # Early cancellation: close the engine's generator so it can release
            # its own resources immediately instead of waiting for GC.
            close = getattr(chunks, "close", None)
            if callable(close):
                close()

        print(
            f"tts timing: stream={time.perf_counter() - started:.3f}s "
            f"first_chunk={(first_chunk_s or 0.0):.3f}s chunks={sent}",
            file=sys.stderr,
        )

    gen = generate()
    return StreamingResponse(
        gen,
        media_type=STREAM_MEDIA_TYPE,
        background=BackgroundTask(_close_stream, gen),
    )
