import io
import wave

import numpy as np
from faster_whisper import WhisperModel

_model = None


def get_model():
    global _model
    if _model is None:
        _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


def transcribe_audio(wav_bytes: bytes) -> str:
    # The browser sends a 16 kHz mono 16-bit WAV, so we can read it directly
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        frames = wf.readframes(wf.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

    segments, _ = get_model().transcribe(audio, beam_size=5)
    return " ".join(seg.text.strip() for seg in segments).strip()