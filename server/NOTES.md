# Server Setup Notes

## 1. PyTorch Installation Command

The PyTorch installation command supplied for this project is:

```powershell
.\.venv\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu132
```

Run this from the `server` directory so the packages install into this project's virtual environment. Do not use bare `pip` or `pip3`.

## 2. Official Qwen3-TTS Voice Clone Documentation

Source: [QwenLM/Qwen3-TTS README — Voice Clone](https://github.com/QwenLM/Qwen3-TTS/blob/main/README.md#voice-clone)

### Voice Clone

For the voice clone model (`Qwen3-TTS-12Hz-1.7B/0.6B-Base`), to clone a voice and synthesize new content, you just need to provide a reference audio clip (`ref_audio`) along with its transcript (`ref_text`). `ref_audio` can be a local file path, a URL, a base64 string, or a `(numpy_array, sample_rate)` tuple. If you set `x_vector_only_mode=True`, only the speaker embedding is used so `ref_text` is not required, but cloning quality may be reduced.

```python
import torch
import soundfile as sf
from qwen_tts import Qwen3TTSModel

model = Qwen3TTSModel.from_pretrained(
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    device_map="cuda:0",
    dtype=torch.bfloat16,
    attn_implementation="flash_attention_2",
)

ref_audio = "https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3-TTS-Repo/clone.wav"
ref_text  = "Okay. Yeah. I resent you. I love you. I respect you. But you know what? You blew it! And thanks to you."

wavs, sr = model.generate_voice_clone(
    text="I am solving the equation: x = [-b ± √(b²-4ac)] / 2a? Nobody can — it's a disaster (◍•͈⌔•͈◍), very sad!",
    language="English",
    ref_audio=ref_audio,
    ref_text=ref_text,
)
sf.write("output_voice_clone.wav", wavs[0], sr)
```

If you need to reuse the same reference prompt across multiple generations (to avoid recomputing prompt features), build it once with `create_voice_clone_prompt` and pass it via `voice_clone_prompt`.

```python
prompt_items = model.create_voice_clone_prompt(
    ref_audio=ref_audio,
    ref_text=ref_text,
    x_vector_only_mode=False,
)
wavs, sr = model.generate_voice_clone(
    text=["Sentence A.", "Sentence B."],
    language=["English", "English"],
    voice_clone_prompt=prompt_items,
)
sf.write("output_voice_clone_1.wav", wavs[0], sr)
sf.write("output_voice_clone_2.wav", wavs[1], sr)
```

For more examples of reusable voice clone prompts, batch cloning, and batch inference, refer to the [official example codes](https://github.com/QwenLM/Qwen3-TTS/tree/main/examples). The examples and the `generate_voice_clone` function description cover more advanced usage patterns.

## 3. Project Probe Status

Do not treat the Qwen3-TTS probe as verified until it has been run on the target machine, its output has been reviewed, and the generated WAV has been played back and checked. Record the actual installed package versions, selected device, generation time, and exact API call after the probe has been completed.
