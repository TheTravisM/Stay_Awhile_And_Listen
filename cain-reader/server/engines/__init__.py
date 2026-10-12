import os

from .base import Engine
from .stub import StubEngine

_ENGINES = {
    "stub": StubEngine,
}


def get_engine(name: str = os.environ.get("CAIN_ENGINE", "stub")) -> Engine:
    try:
        return _ENGINES[name]()
    except KeyError:
        raise ValueError(f"unknown engine: {name!r}") from None
