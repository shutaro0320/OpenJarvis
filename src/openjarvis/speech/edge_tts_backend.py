"""Edge neural TTS -- Microsoft's natural-sounding online voices, no API key.

Uses the ``edge-tts`` package (``pip install edge-tts``). Needs an internet
connection; when synthesis fails (offline, service change) it falls back to
the OS voices from :mod:`openjarvis.speech.system_tts` so voice output keeps
working.

Voices are chosen by text language unless ``voice_id`` is given:
  Japanese -> ``OPENJARVIS_EDGE_VOICE_JA`` (default ja-JP-KeitaNeural, male)
  other    -> ``OPENJARVIS_EDGE_VOICE``    (default en-GB-RyanNeural, British male)
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import List

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult

logger = logging.getLogger(__name__)

import edge_tts  # noqa: E402  -- ImportError keeps this backend unregistered

_JA_RE = re.compile(r"[぀-ヿ㐀-鿿]")
_DEFAULT_JA = "ja-JP-KeitaNeural"
_DEFAULT_OTHER = "en-GB-RyanNeural"


def _pick_voice(text: str, voice_id: str) -> str:
    # Only Edge voice names ("xx-YY-NameNeural") are meaningful here; anything
    # else (e.g. another backend's configured voice) falls back to the default.
    if voice_id and voice_id.endswith("Neural"):
        return voice_id
    if _JA_RE.search(text):
        return os.environ.get("OPENJARVIS_EDGE_VOICE_JA", _DEFAULT_JA)
    return os.environ.get("OPENJARVIS_EDGE_VOICE", _DEFAULT_OTHER)


async def _synthesize(text: str, voice: str, rate: str) -> bytes:
    audio = bytearray()
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio":
            audio.extend(chunk["data"])
    return bytes(audio)


def _mp3_to_wav(mp3: bytes) -> bytes | None:
    """Decode MP3 to 16-bit mono WAV with PyAV (installed with the speech extra)."""
    try:
        import io
        import wave

        import av

        pcm = bytearray()
        rate = 24000
        with av.open(io.BytesIO(mp3)) as container:
            resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame):
                    pcm.extend(out.to_ndarray().tobytes())
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(pcm))
        return buf.getvalue()
    except Exception:
        logger.debug("MP3->WAV conversion failed; returning MP3", exc_info=True)
        return None


@TTSRegistry.register("edge")
class EdgeTTSBackend(TTSBackend):
    """Microsoft Edge neural voices via ``edge-tts`` (online, free)."""

    backend_id = "edge"

    def health(self) -> bool:
        return True  # import succeeded; network problems fall back at synth time

    def available_voices(self) -> List[str]:
        try:
            voices = asyncio.run(edge_tts.list_voices())
            return [v["ShortName"] for v in voices]
        except Exception:
            return [_DEFAULT_JA, _DEFAULT_OTHER]

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "",
        speed: float = 1.0,
        output_format: str = "mp3",
    ) -> TTSResult:
        voice = _pick_voice(text, voice_id)
        pct = round((speed - 1.0) * 100)
        rate = f"{pct:+d}%"
        try:
            audio = asyncio.run(_synthesize(text, voice, rate))
            if not audio:
                raise RuntimeError("empty audio")
            if output_format == "wav":
                wav = _mp3_to_wav(audio)
                if wav is not None:
                    return TTSResult(audio=wav, format="wav", voice_id=voice, sample_rate=24000)
            return TTSResult(audio=audio, format="mp3", voice_id=voice, sample_rate=24000)
        except Exception as exc:
            logger.warning("Edge TTS failed (%s); falling back to system voice", exc)
            from openjarvis.speech.system_tts import SystemTTSBackend

            fallback = SystemTTSBackend()
            if not fallback.health():
                raise
            return fallback.synthesize(text, speed=speed, output_format="wav")


__all__ = ["EdgeTTSBackend"]
