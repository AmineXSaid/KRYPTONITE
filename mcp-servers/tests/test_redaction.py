"""Token redaction, including the paths a secret takes without being asked.

A credential does not usually leak because someone printed it. It leaks because
it was inside an object that something else printed - an exception's repr, a
request's headers, a config dump added while debugging. These tests cover the
derived forms as well as the literal token, because redacting only the literal
leaves the base64 Basic blob, which carries the same secret.
"""

from __future__ import annotations

import base64

import pytest

from readonly_client import redaction
from readonly_client.config import ServiceConfig, load_config
from readonly_client.redaction import (
    PLACEHOLDER,
    register_secret,
    safe_exception_text,
    scrub,
)

TOKEN = "NjkyMTk4OTQ1NDU2Onc0h6vT0PLm5ExampleTokenValue"


@pytest.fixture(autouse=True)
def _clean_secrets():
    redaction.clear_secrets()
    yield
    redaction.clear_secrets()


def test_registered_token_is_scrubbed() -> None:
    register_secret(TOKEN)
    assert TOKEN not in scrub(f"Request failed with Authorization: Bearer {TOKEN}")
    assert PLACEHOLDER in scrub(f"token={TOKEN}")


def test_scrub_handles_repeated_occurrences() -> None:
    register_secret(TOKEN)
    out = scrub(f"{TOKEN} and again {TOKEN}")
    assert TOKEN not in out
    assert out.count(PLACEHOLDER) == 2


def test_authorization_header_is_scrubbed_even_when_unregistered() -> None:
    """The belt-and-braces path: a header rendered by a library we do not control."""
    out = scrub("headers={'authorization': 'Bearer abc.def.ghi'}")
    assert "abc.def.ghi" not in out
    assert PLACEHOLDER in out


def test_basic_header_is_scrubbed_even_when_unregistered() -> None:
    out = scrub("Authorization: Basic dXNlckBjb3JwOnNlY3JldA==")
    assert "dXNlckBjb3JwOnNlY3JldA==" not in out


def test_longest_secret_is_replaced_first() -> None:
    """A short secret inside a long one must not leave fragments of the long one.

    Replacing "abcdefgh" first inside "abcdefghIJKLMNOP" would leave "IJKLMNOP"
    exposed beside the placeholder.
    """
    short = "abcdefgh"
    long = short + "IJKLMNOPQRST"
    register_secret(short)
    register_secret(long)
    out = scrub(f"value={long}")
    assert "IJKLMNOP" not in out
    assert short not in out


def test_short_values_are_not_registered() -> None:
    """Redacting a 3-character string would blank half of any output."""
    register_secret("abc")
    assert scrub("abc def") == "abc def"


def test_none_and_empty_are_safe() -> None:
    register_secret(None)
    register_secret("")
    assert scrub("nothing to do here") == "nothing to do here"


def test_safe_exception_text_redacts_and_omits_traceback() -> None:
    """Exception text is scrubbed, and carries no frame data.

    A rendered traceback can hold the token in frame locals, and there is no
    reliable way to scrub one without destroying what makes it useful.
    """
    register_secret(TOKEN)
    exc = ValueError(f"bad credential {TOKEN} supplied")
    text = safe_exception_text(exc)
    assert TOKEN not in text
    assert text.startswith("ValueError:")
    assert "Traceback" not in text
    assert "File \"" not in text


# ── the config layer registers every form of the secret ────────────────────


def test_bearer_config_registers_pat_and_header(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JIRA_BASE_URL", "https://jira.test.internal")
    monkeypatch.setenv("ATLASSIAN_AUTH_MODE", "bearer")
    monkeypatch.setenv("ATLASSIAN_TOKEN", TOKEN)
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))

    assert TOKEN not in scrub(f"boom {TOKEN}")
    # The assembled header is a different string; it must also be covered.
    for value in cfg.auth_headers().values():
        assert TOKEN not in scrub(f"header {value}")


def test_basic_config_registers_the_base64_blob(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Basic blob is not the token, but it contains it verbatim."""
    email, token = "user@corp.example", "cloud-api-token-value-1234"
    monkeypatch.setenv("CONFLUENCE_BASE_URL", "https://x.atlassian.net/wiki")
    monkeypatch.setenv("ATLASSIAN_AUTH_MODE", "basic")
    monkeypatch.setenv("ATLASSIAN_USER", email)
    monkeypatch.setenv("ATLASSIAN_TOKEN", token)
    load_config("CONFLUENCE_BASE_URL", "Confluence", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))

    blob = base64.b64encode(f"{email}:{token}".encode()).decode()
    out = scrub(f"Authorization: Basic {blob}")
    # The blob is a DIFFERENT string from the token but carries it verbatim -
    # which is exactly why registering only the token would not be enough.
    assert token in base64.b64decode(blob).decode()
    assert blob not in out
    assert token not in scrub(f"token {token}")
    assert PLACEHOLDER in out


def test_config_repr_does_not_expose_token_via_scrub(monkeypatch: pytest.MonkeyPatch) -> None:
    """A dataclass repr holds the token; anything that formats it must scrub."""
    monkeypatch.setenv("JIRA_BASE_URL", "https://jira.test.internal")
    monkeypatch.setenv("ATLASSIAN_AUTH_MODE", "bearer")
    monkeypatch.setenv("ATLASSIAN_TOKEN", TOKEN)
    cfg: ServiceConfig = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))

    # The raw repr does contain it - that is exactly why every outbound path
    # goes through scrub() rather than relying on the object being safe.
    assert TOKEN in repr(cfg)
    assert TOKEN not in scrub(repr(cfg))
