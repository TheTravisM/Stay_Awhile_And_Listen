import threading

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from engines import get_engine

app = FastAPI()

engine = get_engine()
_synthesis_lock = threading.Lock()


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


@app.get("/health")
def health():
    return {"ok": True, "engine": engine.name, "voice": "cain"}


@app.post("/tts")
def tts(req: TTSRequest):
    try:
        with _synthesis_lock:
            wav = engine.synthesize(req.text, req.speed)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
    return Response(content=wav, media_type="audio/wav")
