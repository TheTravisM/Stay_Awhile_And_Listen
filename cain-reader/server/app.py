import sys
import threading
import time

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from engines import get_engine

app = FastAPI()

engine = get_engine()
_synthesis_lock = threading.Lock()


def _warm_up() -> None:
    if engine.name != "cain":
        return
    try:
        with _synthesis_lock:
            engine.synthesize("Stay awhile and listen.", 1.0)
    except Exception as e:
        print(f"cain warmup failed: {e}", file=sys.stderr)


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
