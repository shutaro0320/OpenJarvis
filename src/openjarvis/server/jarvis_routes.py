"""JARVIS voice HUD -- pluggable "brain" configuration and chat relay.

The HUD (frontend ``/jarvis``) is the body: microphone, clap / wake-word
detection, speech-to-text and text-to-speech. The *brain* that decides what
to say is any OpenAI-compatible chat endpoint:

* OpenJarvis itself (e.g. the "Claude（サブスク）" models)  -- default
* Hermes Agent  (``API_SERVER_ENABLED=true`` -> http://127.0.0.1:8642/v1)
* OpenClaw      (``gateway.http.endpoints.chatCompletions.enabled: true``
                 -> http://<host>:18789/v1, model ``openclaw/default``)

Requests are relayed through this server so a brain on another machine (for
example OpenClaw on a Mac mini) works without browser CORS issues, and its API
key never has to live in the browser. Config is stored in
``~/.openjarvis/jarvis.json``.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

jarvis_router = APIRouter(prefix="/v1/jarvis", tags=["jarvis"])

DEFAULT_PERSONA = (
    "あなたは「ジャービス（JARVIS）」、ユーザー専属の有能なAI執事です。"
    "落ち着いた丁寧な口調（です・ます調）で、ときに控えめで品のあるユーモアを交えて話します。"
    "これは音声会話で、返答はそのまま音声で読み上げられます。"
    "要点を短く、通常は1〜3文の自然な話し言葉で答えてください。"
    "Markdown、箇条書き、表、コード、URL、絵文字、記号の羅列は使わないでください。"
    "ユーザーが英語で話した場合は英語で答えてください。"
)

PRESETS: Dict[str, Dict[str, Any]] = {
    "openjarvis": {
        "label": "OpenJarvis（このPCのモデル）",
        "base_url": "",  # empty = this server
        "model": "Claude（サブスク・Haiku）",
        "extra_body": {"direct": True},
    },
    "hermes": {
        "label": "Hermes Agent",
        "base_url": "http://127.0.0.1:8642/v1",
        "model": "hermes-agent",
        "extra_body": {},
    },
    "openclaw": {
        "label": "OpenClaw",
        "base_url": "http://127.0.0.1:18789/v1",
        "model": "openclaw/default",
        "extra_body": {},
    },
    "custom": {
        "label": "その他（OpenAI互換）",
        "base_url": "http://127.0.0.1:8000/v1",
        "model": "",
        "extra_body": {},
    },
}


def _config_path() -> Path:
    from openjarvis.core.config import get_config_dir

    return Path(get_config_dir()) / "jarvis.json"


def _default_config() -> Dict[str, Any]:
    p = PRESETS["openjarvis"]
    return {
        "brain": {
            "preset": "openjarvis",
            "base_url": p["base_url"],
            "model": p["model"],
            "api_key": "",
            "extra_body": dict(p["extra_body"]),
            "send_persona": True,
        },
        "persona": DEFAULT_PERSONA,
        "wake": {"clap": True, "word": True, "words": ["ジャービス", "Jarvis"]},
        "history_turns": 10,
    }


def load_jarvis_config() -> Dict[str, Any]:
    cfg = _default_config()
    path = _config_path()
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return cfg
    except Exception:
        logger.warning("Ignoring unreadable %s", path, exc_info=True)
        return cfg
    for key, value in saved.items():
        if isinstance(value, dict) and isinstance(cfg.get(key), dict):
            cfg[key].update(value)
        else:
            cfg[key] = value
    return cfg


def _public(cfg: Dict[str, Any]) -> Dict[str, Any]:
    out = json.loads(json.dumps(cfg))
    key = out["brain"].pop("api_key", "")
    out["brain"]["has_api_key"] = bool(key)
    out["presets"] = PRESETS
    return out


class BrainUpdate(BaseModel):
    preset: Optional[str] = None
    base_url: Optional[str] = None
    model: Optional[str] = None
    # None keeps the stored key; "" clears it.
    api_key: Optional[str] = None
    extra_body: Optional[Dict[str, Any]] = None
    send_persona: Optional[bool] = None


class JarvisConfigUpdate(BaseModel):
    brain: Optional[BrainUpdate] = None
    persona: Optional[str] = None
    wake: Optional[Dict[str, Any]] = None
    history_turns: Optional[int] = Field(default=None, ge=0, le=50)


class JarvisChatRequest(BaseModel):
    messages: List[Dict[str, Any]]


@jarvis_router.get("/config")
async def get_jarvis_config() -> Dict[str, Any]:
    return _public(load_jarvis_config())


@jarvis_router.put("/config")
async def put_jarvis_config(update: JarvisConfigUpdate) -> Dict[str, Any]:
    cfg = load_jarvis_config()
    if update.brain is not None:
        for field, value in update.brain.model_dump(exclude_none=True).items():
            cfg["brain"][field] = value
        url = cfg["brain"].get("base_url", "")
        if url and not url.startswith(("http://", "https://")):
            raise HTTPException(status_code=400, detail="base_url must start with http:// or https://")
    if update.persona is not None:
        cfg["persona"] = update.persona
    if update.wake is not None:
        cfg["wake"].update(update.wake)
    if update.history_turns is not None:
        cfg["history_turns"] = update.history_turns
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(path, 0o600)  # holds the brain's API key
    except OSError:
        pass
    return _public(cfg)


@jarvis_router.post("/chat")
async def jarvis_chat(body: JarvisChatRequest, request: Request) -> StreamingResponse:
    """Relay one streaming chat turn to the configured brain (SSE passthrough)."""
    import httpx

    cfg = load_jarvis_config()
    brain = cfg["brain"]
    base = (brain.get("base_url") or "").rstrip("/")
    if not base:
        base = str(request.base_url).rstrip("/") + "/v1"  # this OpenJarvis server
    messages = list(body.messages)
    if brain.get("send_persona", True) and cfg.get("persona"):
        messages = [{"role": "system", "content": cfg["persona"]}] + [
            m for m in messages if m.get("role") != "system"
        ]
    payload: Dict[str, Any] = {
        "model": brain.get("model", ""),
        "messages": messages,
        "stream": True,
        "user": "jarvis-voice",  # lets session-aware brains keep context
    }
    payload.update(brain.get("extra_body") or {})
    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    if brain.get("api_key"):
        headers["Authorization"] = f"Bearer {brain['api_key']}"
    elif not brain.get("base_url"):
        # Calling ourselves: forward the caller's auth if the server is key-protected.
        auth = request.headers.get("authorization")
        if auth:
            headers["Authorization"] = auth

    client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))
    try:
        upstream = await client.send(
            client.build_request("POST", f"{base}/chat/completions", json=payload, headers=headers),
            stream=True,
        )
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"頭脳（{base}）に接続できません: {exc}") from exc
    if upstream.status_code >= 400:
        detail = (await upstream.aread()).decode("utf-8", errors="replace")[:500]
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=502, detail=f"頭脳がエラーを返しました（{upstream.status_code}）: {detail}")

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


__all__ = ["jarvis_router", "load_jarvis_config", "DEFAULT_PERSONA", "PRESETS"]
