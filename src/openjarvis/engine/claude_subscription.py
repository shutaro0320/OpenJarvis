"""Claude subscription engine -- chat through the locally logged-in Claude Code CLI.

Uses ``claude -p`` (Claude Code's print mode) so requests are billed to the
user's Claude Pro/Max subscription instead of an API key.  Works on Windows,
macOS and Linux as long as Claude Code is installed and logged in
(run ``claude`` once and ``/login``).

Environment overrides:
  OPENJARVIS_CLAUDE_CLI      Absolute path to the ``claude`` executable.
  OPENJARVIS_CLAUDE_TIMEOUT  Per-request timeout in seconds (default 600).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from collections.abc import AsyncIterator, Iterator, Sequence
from pathlib import Path
from typing import Any, Dict, List

from openjarvis.core.registry import EngineRegistry
from openjarvis.core.types import Message, Role
from openjarvis.engine._base import (
    EngineConnectionError,
    InferenceEngine,
    estimate_prompt_tokens,
)

logger = logging.getLogger(__name__)

# Display ID shown in the model picker -> Claude Code model alias.
# IDs deliberately avoid a "claude-" prefix and "/" so OpenJarvis does not
# mistake them for direct-API cloud models and hide them from the picker.
MODEL_ALIASES: Dict[str, str] = {
    "Claude（サブスク）": "sonnet",
    "Claude（サブスク・Opus）": "opus",
    "Claude（サブスク・Haiku）": "haiku",
}

_DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."


def _candidate_paths() -> List[Path]:
    home = Path.home()
    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
        return [
            home / ".local" / "bin" / "claude.exe",
            appdata / "npm" / "claude.cmd",
        ]
    return [
        home / ".local" / "bin" / "claude",
        home / ".claude" / "local" / "claude",
        Path("/opt/homebrew/bin/claude"),
        Path("/usr/local/bin/claude"),
        home / ".npm-global" / "bin" / "claude",
    ]


def find_claude_cli() -> str | None:
    """Locate the Claude Code executable on any OS.

    GUI-launched servers (e.g. the macOS desktop app) often have a minimal
    PATH, so common install locations are checked as well.
    """
    override = os.environ.get("OPENJARVIS_CLAUDE_CLI")
    if override and Path(override).is_file():
        return override
    found = shutil.which("claude")
    paths = ([Path(found)] if found else []) + _candidate_paths()
    for p in paths:
        if not p.is_file():
            continue
        # On Windows, npm installs a claude.cmd shim around a native
        # claude.exe. Call the .exe directly to avoid cmd.exe quoting rules.
        if p.suffix.lower() in (".cmd", ".ps1", ""):
            exe = p.parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
            if sys.platform == "win32" and exe.is_file():
                return str(exe)
            if sys.platform == "win32" and p.suffix == "":
                continue  # bash shim, unusable from CreateProcess
        return str(p)
    return None


def _render_prompt(messages: Sequence[Message]) -> tuple[str, str]:
    """Split messages into (system_prompt, user_prompt) for ``claude -p``."""
    system_parts: List[str] = []
    turns: List[Message] = []
    for m in messages:
        if m.role == Role.SYSTEM:
            if m.content:
                system_parts.append(m.content)
        else:
            turns.append(m)
    system = "\n\n".join(system_parts) or _DEFAULT_SYSTEM_PROMPT

    if len(turns) == 1 and turns[0].role == Role.USER:
        return system, turns[0].content or ""

    labels = {Role.USER: "User", Role.ASSISTANT: "Assistant", Role.TOOL: "Tool result"}
    lines = ["<conversation_history>"]
    for m in turns[:-1]:
        lines.append(f"[{labels.get(m.role, m.role.value)}]\n{m.content or ''}\n")
    lines.append("</conversation_history>\n")
    last = turns[-1] if turns else None
    if last is not None:
        lines.append(
            "Continue the conversation above. Reply to this latest "
            f"{labels.get(last.role, 'message').lower()} message:\n\n"
            f"{last.content or ''}"
        )
    return system, "\n".join(lines)


@EngineRegistry.register("claude_subscription")
class ClaudeSubscriptionEngine(InferenceEngine):
    """Chat via the user's Claude subscription through the Claude Code CLI."""

    engine_id = "claude_subscription"
    is_cloud = True

    def __init__(self, cli_path: str | None = None, timeout: float | None = None) -> None:
        self._cli = cli_path or find_claude_cli()
        self._timeout = timeout or float(os.environ.get("OPENJARVIS_CLAUDE_TIMEOUT", "600"))
        self._workdir = Path(tempfile.gettempdir()) / "openjarvis-claude-sub"

    # ------------------------------------------------------------------ helpers
    def _command(self, model: str, system_file: Path) -> List[str]:
        if not self._cli:
            raise EngineConnectionError(
                "Claude Code CLI not found. Install Claude Code and run `claude` "
                "once to log in, or set OPENJARVIS_CLAUDE_CLI."
            )
        return [
            self._cli,
            "-p",
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model", MODEL_ALIASES.get(model, model),
            "--tools", "",
            "--strict-mcp-config",
            "--setting-sources", "",
            "--no-session-persistence",
            "--system-prompt-file", str(system_file),
        ]

    def _events(self, messages: Sequence[Message], model: str) -> Iterator[Dict[str, Any]]:
        """Run the CLI and yield its stream-json events."""
        system, prompt = _render_prompt(messages)
        self._workdir.mkdir(parents=True, exist_ok=True)
        fd, sys_path = tempfile.mkstemp(suffix=".txt", dir=self._workdir)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(system)

        env = os.environ.copy()
        # Force subscription (OAuth) auth rather than API-key billing.
        env.pop("ANTHROPIC_API_KEY", None)
        kwargs: Dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW

        try:
            proc = subprocess.Popen(
                self._command(model, Path(sys_path)),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(self._workdir),
                env=env,
                **kwargs,
            )
        except OSError as exc:
            os.unlink(sys_path)
            raise EngineConnectionError(f"Failed to start Claude Code CLI: {exc}") from exc

        timer = threading.Timer(self._timeout, proc.kill)
        timer.start()
        try:
            assert proc.stdin and proc.stdout and proc.stderr
            proc.stdin.write(prompt.encode("utf-8"))
            proc.stdin.close()
            for raw in proc.stdout:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line.startswith("{"):
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
            rc = proc.wait()
            if rc != 0:
                err = proc.stderr.read().decode("utf-8", errors="replace").strip()
                if err:
                    raise EngineConnectionError(f"Claude Code CLI exited {rc}: {err[-800:]}")
        finally:
            timer.cancel()
            if proc.poll() is None:
                proc.kill()
            try:
                os.unlink(sys_path)
            except OSError:
                pass

    @staticmethod
    def _check_result(event: Dict[str, Any]) -> None:
        if event.get("is_error") or event.get("subtype") not in (None, "success"):
            msg = event.get("result") or "; ".join(event.get("errors") or []) or "unknown error"
            if "login" in str(msg).lower() or "auth" in str(msg).lower():
                msg += " — run `claude` in a terminal and use /login."
            raise EngineConnectionError(f"Claude subscription error: {msg}")

    # --------------------------------------------------------------- interface
    def generate(
        self,
        messages: Sequence[Message],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 1024,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        text_parts: List[str] = []
        result: Dict[str, Any] | None = None
        for ev in self._events(messages, model):
            if ev.get("type") == "result":
                result = ev
            elif ev.get("type") == "assistant":
                for block in (ev.get("message") or {}).get("content") or []:
                    if block.get("type") == "text":
                        text_parts.append(block.get("text", ""))
        if result is not None:
            self._check_result(result)
        content = (result or {}).get("result") or "".join(text_parts)
        usage = (result or {}).get("usage") or {}
        prompt_tokens = int(
            usage.get("input_tokens", 0)
            + usage.get("cache_read_input_tokens", 0)
            + usage.get("cache_creation_input_tokens", 0)
        ) or estimate_prompt_tokens(messages)
        completion_tokens = int(usage.get("output_tokens", 0)) or max(1, len(content) // 4)
        return {
            "content": content,
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            "model": model,
            "finish_reason": "stop",
        }

    async def stream(
        self,
        messages: Sequence[Message],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 1024,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        # Run the blocking subprocess in a thread (works with any event loop,
        # including Windows selector loops that lack subprocess support).
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue = asyncio.Queue()
        done = object()

        def worker() -> None:
            try:
                for ev in self._events(messages, model):
                    loop.call_soon_threadsafe(queue.put_nowait, ev)
            except BaseException as exc:  # noqa: BLE001 - forwarded to caller
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, done)

        threading.Thread(target=worker, daemon=True).start()
        streamed = False
        while True:
            item = await queue.get()
            if item is done:
                break
            if isinstance(item, BaseException):
                raise item
            etype = item.get("type")
            if etype == "stream_event":
                delta = (item.get("event") or {}).get("delta") or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    streamed = True
                    yield delta["text"]
            elif etype == "result":
                self._check_result(item)
                if not streamed and item.get("result"):
                    yield item["result"]

    def list_models(self) -> List[str]:
        return list(MODEL_ALIASES) if self._cli else []

    def health(self) -> bool:
        return bool(self._cli)

    def can_serve(self, model: str) -> bool:
        return model in MODEL_ALIASES


__all__ = ["ClaudeSubscriptionEngine", "MODEL_ALIASES", "find_claude_cli"]
