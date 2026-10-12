import io
import wave
import numpy as np


class StubEngine:
    name: str = "stub"

    def synthesize(self, text: str, speed: float = 1.0) -> bytes:
        sample_rate = 22050
        duration = min(0.05 * len(text), 10.0)
        num_samples = int(sample_rate * duration)

        if num_samples == 0:
            audio = np.empty(0, dtype=np.int16)
        else:
            t = np.arange(num_samples) / sample_rate
            waveform = np.sin(2.0 * np.pi * 440.0 * t)

            fade_duration = 0.01  # 10 ms
            fade_samples = int(sample_rate * fade_duration)
            if fade_samples > 0 and num_samples >= 2 * fade_samples:
                fade_in = np.linspace(0.0, 1.0, fade_samples, endpoint=False)
                fade_out = np.linspace(1.0, 0.0, fade_samples, endpoint=False)
                waveform[:fade_samples] *= fade_in
                waveform[-fade_samples:] *= fade_out

            audio = (waveform * 32767.0).astype(np.int16)

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sample_rate)
            wav_file.writeframes(audio.tobytes())

        return buffer.getvalue()
