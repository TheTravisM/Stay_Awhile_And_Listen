from typing import Protocol


class Engine(Protocol):
    name: str
    # True when the engine pays a one-time setup cost at startup and should be
    # warmed up once by the server (see ``app._warm_up``). The server reads this
    # flag from whichever class the registry resolves, so a new engine never
    # needs an ``app.py`` edit.
    warm_up_at_startup: bool
    # True once the engine holds a loaded model. The stub engine never does.
    model_loaded: bool
    # True when the engine is running its compiled/optimized path. Only the
    # streaming engine has one; the stub and cain engines are never optimized.
    optimized: bool

    def synthesize(self, text: str, speed: float) -> bytes:
        ...
