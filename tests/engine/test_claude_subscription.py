"""Tests for the Claude subscription (Claude Code CLI) engine."""

from openjarvis.core.types import Message, Role
from openjarvis.engine.claude_subscription import (
    MODEL_ALIASES,
    ClaudeSubscriptionEngine,
    _render_prompt,
)
from openjarvis.server.cloud_router import is_cloud_model


def test_model_ids_are_not_mistaken_for_cloud_models():
    # Cloud-looking IDs are hidden from the local model picker.
    for model_id in MODEL_ALIASES:
        assert not is_cloud_model(model_id)


def test_single_user_message_is_sent_as_is():
    system, prompt = _render_prompt(
        [Message(role=Role.SYSTEM, content="Be brief."), Message(role=Role.USER, content="hi")]
    )
    assert system == "Be brief."
    assert prompt == "hi"


def test_history_is_rendered_and_last_message_answered():
    system, prompt = _render_prompt(
        [
            Message(role=Role.USER, content="My name is Shu."),
            Message(role=Role.ASSISTANT, content="Nice to meet you."),
            Message(role=Role.USER, content="What is my name?"),
        ]
    )
    assert system  # default system prompt
    assert "[User]\nMy name is Shu." in prompt
    assert "[Assistant]\nNice to meet you." in prompt
    assert prompt.rstrip().endswith("What is my name?")


def test_no_cli_means_unhealthy_and_no_models():
    engine = ClaudeSubscriptionEngine(cli_path="")
    engine._cli = None
    assert not engine.health()
    assert engine.list_models() == []
    assert engine.can_serve("Claude（サブスク）")
    assert not engine.can_serve("gpt-4o")
