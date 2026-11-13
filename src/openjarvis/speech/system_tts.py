"""System TTS -- the operating system's built-in voices, no extra installs.

* Windows: SAPI via PowerShell ``System.Speech`` (e.g. "Microsoft Haruka").
* macOS:   ``say`` (e.g. "Kyoko" for Japanese).
* Linux:   ``espeak-ng`` / ``espeak`` when installed.

When no ``voice_id`` is given the voice follows the text: Japanese text gets a
Japanese voice if one is installed, everything else the system default.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from typing import List

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult

logger = logging.getLogger(__name__)

_JA_RE = re.compile(r"[぀-ヿ㐀-鿿]")
_TIMEOUT = 120

# Reads text from a UTF-8 file so no user text ever touches a command line.
_PS_SCRIPT = r"""
param([string]$TextFile, [string]$OutFile, [string]$Voice, [int]$Rate, [string]$Culture)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice) { $s.SelectVoice($Voice) }
elseif ($Culture) {
  $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $Culture } | Select-Object -First 1
  if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }
}
$s.Rate = $Rate
$s.SetOutputToWaveFile($OutFile)
$name = $s.Voice.Name
$s.Speak([System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8))
$s.Dispose()
Write-Output $name
"""


def _is_japanese(text: str) -> bool:
    return bool(_JA_RE.search(text))


@TTSRegistry.register("system")
class SystemTTSBackend(TTSBackend):
    """Built-in OS speech synthesis (Windows SAPI, macOS say, Linux espeak)."""

    backend_id = "system"

    def __init__(self) -> None:
        self._platform = sys.platform
        self._tool = self._find_tool()

    def _find_tool(self) -> str | None:
        if self._platform == "win32":
            return shutil.which("powershell") or shutil.which("pwsh")
        if self._platform == "darwin":
            return shutil.which("say") or ("/usr/bin/say" if Path("/usr/bin/say").exists() else None)
        return shutil.which("espeak-ng") or shutil.which("espeak")

    def health(self) -> bool:
        return self._tool is not None

    def available_voices(self) -> List[str]:
        if not self._tool:
            return []
        try:
            if self._platform == "win32":
                out = subprocess.run(
                    [self._tool, "-NoProfile", "-Command",
                     "Add-Type -AssemblyName System.Speech;"
                     "(New-Object System.Speech.Synthesis.SpeechSynthesizer)"
                     ".GetInstalledVoices() | % { $_.VoiceInfo.Name }"],
                    capture_output=True, text=True, timeout=30,
                ).stdout
                return [v.strip() for v in out.splitlines() if v.strip()]
            if self._platform == "darwin":
                out = subprocess.run([self._tool, "-v", "?"], capture_output=True,
                                     text=True, timeout=30).stdout
                return [line.split("  ")[0].strip() for line in out.splitlines() if line.strip()]
        except Exception:
            logger.debug("Listing system voices failed", exc_info=True)
        return []

    def _mac_ja_voice(self) -> str:
        voices = self.available_voices()
        for name in ("Kyoko (Enhanced)", "Kyoko", "Otoya", "Hattori", "O-ren"):
            if name in voices:
                return name
        for v in voices:
            if "ja_JP" in v:
                return v.split()[0]
        return ""

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "",
        speed: float = 1.0,
        output_format: str = "wav",
    ) -> TTSResult:
        if not self._tool:
            raise RuntimeError("No system speech synthesizer available")
        japanese = _is_japanese(text)
        with tempfile.TemporaryDirectory(prefix="oj-tts-") as tmp:
            text_file = Path(tmp) / "text.txt"
            out_file = Path(tmp) / "out.wav"
            text_file.write_text(text, encoding="utf-8")
            kwargs = {}
            if self._platform == "win32":
                kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
                script = Path(tmp) / "tts.ps1"
                script.write_text(_PS_SCRIPT, encoding="utf-8-sig")
                rate = max(-10, min(10, round((speed - 1.0) * 10)))
                cmd = [self._tool, "-NoProfile", "-ExecutionPolicy", "Bypass",
                       "-File", str(script), "-TextFile", str(text_file),
                       "-OutFile", str(out_file), "-Voice", voice_id,
                       "-Rate", str(rate), "-Culture", "ja-JP" if japanese else ""]
            elif self._platform == "darwin":
                voice = voice_id or (self._mac_ja_voice() if japanese else "")
                cmd = [self._tool, "-o", str(out_file), "--data-format=LEI16@22050",
                       "-r", str(int(185 * speed)), "-f", str(text_file)]
                if voice:
                    cmd[1:1] = ["-v", voice]
            else:
                voice = voice_id or ("ja" if japanese else "")
                cmd = [self._tool, "-w", str(out_file), "-s", str(int(170 * speed)),
                       "-f", str(text_file)]
                if voice:
                    cmd[1:1] = ["-v", voice]

            proc = subprocess.run(cmd, capture_output=True, timeout=_TIMEOUT, **kwargs)
            if proc.returncode != 0 or not out_file.exists():
                err = proc.stderr.decode("utf-8", errors="replace")[-500:]
                raise RuntimeError(f"System TTS failed: {err}")
            audio = out_file.read_bytes()
            used_voice = voice_id or proc.stdout.decode("utf-8", errors="replace").strip()

        sample_rate, duration = 22050, 0.0
        try:
            import io

            with wave.open(io.BytesIO(audio)) as w:
                sample_rate = w.getframerate()
                duration = w.getnframes() / float(sample_rate or 1)
        except Exception:
            pass
        return TTSResult(
            audio=audio,
            format="wav",
            duration_seconds=duration,
            voice_id=used_voice,
            sample_rate=sample_rate,
        )


__all__ = ["SystemTTSBackend"]
