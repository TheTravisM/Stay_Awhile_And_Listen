from typing import Protocol


class Engine(Protocol):
    name: str

    def synthesize(self, text: str, speed: float) -> bytes:
        ...
