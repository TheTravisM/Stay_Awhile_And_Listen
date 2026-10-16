import os

from .base import Engine
from .stub import StubEngine

_ENGINES = {
    "stub": StubEngine,
}


def _engine_class(name: str):
    if name == "cain":
        from .cain import CainEngine

        return CainEngine
    return _ENGINES.get(name)


def get_engine(name: str = os.environ.get("CAIN_ENGINE", "stub")) -> Engine:
    cls = _engine_class(name)
    if cls is None:
        raise ValueError(f"unknown engine: {name!r}")
    return cls()
