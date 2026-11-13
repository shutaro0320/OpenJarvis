"""Tests for the JARVIS HUD brain configuration routes."""

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import jarvis_routes


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(jarvis_routes, "_config_path", lambda: tmp_path / "jarvis.json")
    app = FastAPI()
    app.include_router(jarvis_routes.jarvis_router)
    return TestClient(app), tmp_path / "jarvis.json"


def test_defaults_to_openjarvis_brain(client):
    c, _ = client
    cfg = c.get("/v1/jarvis/config").json()
    assert cfg["brain"]["preset"] == "openjarvis"
    assert cfg["brain"]["base_url"] == ""
    assert cfg["brain"]["has_api_key"] is False
    assert {"openjarvis", "hermes", "openclaw", "custom"} <= set(cfg["presets"])
    assert cfg["wake"]["clap"] and cfg["wake"]["word"]


def test_api_key_is_stored_but_never_returned(client):
    c, path = client
    r = c.put(
        "/v1/jarvis/config",
        json={"brain": {"preset": "openclaw", "base_url": "http://10.0.0.5:18789/v1",
                        "model": "openclaw/default", "api_key": "secret-token"}},
    )
    assert r.status_code == 200
    assert "secret-token" not in r.text
    assert r.json()["brain"]["has_api_key"] is True
    assert json.loads(path.read_text(encoding="utf-8"))["brain"]["api_key"] == "secret-token"

    # Omitting api_key keeps it; an empty string clears it.
    c.put("/v1/jarvis/config", json={"brain": {"model": "openclaw/main"}})
    assert c.get("/v1/jarvis/config").json()["brain"]["has_api_key"] is True
    c.put("/v1/jarvis/config", json={"brain": {"api_key": ""}})
    assert c.get("/v1/jarvis/config").json()["brain"]["has_api_key"] is False


def test_rejects_non_http_brain_url(client):
    c, _ = client
    r = c.put("/v1/jarvis/config", json={"brain": {"base_url": "file:///etc/passwd"}})
    assert r.status_code == 400


def test_unreachable_brain_gives_clear_error(client):
    c, _ = client
    c.put("/v1/jarvis/config", json={"brain": {"base_url": "http://127.0.0.1:9/v1"}})
    r = c.post("/v1/jarvis/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 502
    assert "接続できません" in r.json()["detail"]
