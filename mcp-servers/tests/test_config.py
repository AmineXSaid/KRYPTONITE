"""Startup validation. The rule is: refuse to start, and name the variable.

A server that starts half-configured and 401s on every call is worse than one
that refuses to start, because the failure surfaces later and looks like an
instance problem rather than a missing line in a config file. Each test below
asserts the error names the specific variable at fault - "configuration error"
on its own sends someone reading source code.
"""

from __future__ import annotations

import pytest

from readonly_client import redaction
from readonly_client.config import (
    DEFAULT_MAX_RESULTS,
    HARD_MAX_RESULTS,
    ConfigError,
    load_config,
)

BEARER_ENV = {
    "JIRA_BASE_URL": "https://jira.test.internal",
    "ATLASSIAN_AUTH_MODE": "bearer",
    "ATLASSIAN_TOKEN": "a-token-long-enough-to-register",
}


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch):
    for var in (
        "JIRA_BASE_URL", "CONFLUENCE_BASE_URL", "ATLASSIAN_AUTH_MODE",
        "ATLASSIAN_TOKEN", "ATLASSIAN_USER",
        "ATLASSIAN_CA_BUNDLE", "ATLASSIAN_MAX_RESULTS_CAP",
        "ATLASSIAN_CONNECT_TIMEOUT", "ATLASSIAN_READ_TIMEOUT",
        "GITLAB_BASE_URL", "GITLAB_AUTH_MODE", "GITLAB_TOKEN",
        "JENKINS_BASE_URL", "JENKINS_AUTH_MODE", "JENKINS_USER", "JENKINS_TOKEN",
        # The estate-wide fallbacks. A stray MCP_* value would otherwise make
        # a "not set" test pass for the wrong reason.
        "MCP_CA_BUNDLE", "MCP_MAX_RESULTS_CAP",
        "MCP_CONNECT_TIMEOUT", "MCP_READ_TIMEOUT",
    ):
        monkeypatch.delenv(var, raising=False)
    redaction.clear_secrets()
    yield
    redaction.clear_secrets()


def setenv(monkeypatch: pytest.MonkeyPatch, **kw: str) -> None:
    for k, v in kw.items():
        monkeypatch.setenv(k, v)


# ── missing variables are named ────────────────────────────────────────────


def test_missing_base_url_names_it(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "JIRA_BASE_URL is not set" in str(exc.value)


def test_missing_auth_mode_names_it_and_explains_both(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, JIRA_BASE_URL="https://jira.test.internal")
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    msg = str(exc.value)
    assert "ATLASSIAN_AUTH_MODE is not set" in msg
    assert "bearer" in msg and "basic" in msg


def test_missing_pat_in_bearer_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, JIRA_BASE_URL="https://jira.test.internal", ATLASSIAN_AUTH_MODE="bearer")
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "ATLASSIAN_TOKEN is not set" in str(exc.value)


def test_missing_email_in_basic_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, JIRA_BASE_URL="https://x.atlassian.net", ATLASSIAN_AUTH_MODE="basic")
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "ATLASSIAN_USER is not set" in str(exc.value)


def test_missing_api_token_in_basic_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(
        monkeypatch,
        JIRA_BASE_URL="https://x.atlassian.net",
        ATLASSIAN_AUTH_MODE="basic",
        ATLASSIAN_USER="u@corp.example",
    )
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "ATLASSIAN_TOKEN is not set" in str(exc.value)


def test_blank_is_treated_as_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """`export ATLASSIAN_TOKEN=` is a common way to be 'configured' with nothing."""
    setenv(
        monkeypatch,
        JIRA_BASE_URL="https://jira.test.internal",
        ATLASSIAN_AUTH_MODE="bearer",
        ATLASSIAN_TOKEN="   ",
    )
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "ATLASSIAN_TOKEN is not set" in str(exc.value)


# ── malformed values ───────────────────────────────────────────────────────


def test_bad_auth_mode_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(
        monkeypatch,
        JIRA_BASE_URL="https://jira.test.internal",
        ATLASSIAN_AUTH_MODE="oauth",
    )
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "must be 'bearer' or 'basic'" in str(exc.value)


def test_base_url_needs_a_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, JIRA_BASE_URL="jira.test.internal", ATLASSIAN_AUTH_MODE="bearer",
           ATLASSIAN_TOKEN="x" * 20)
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "http://" in str(exc.value)


def test_base_url_carrying_a_rest_path_is_caught(monkeypatch: pytest.MonkeyPatch) -> None:
    """A frequent paste error that produces doubled, confusingly-404ing paths."""
    setenv(monkeypatch, JIRA_BASE_URL="https://jira.test.internal/rest/api/2",
           ATLASSIAN_AUTH_MODE="bearer", ATLASSIAN_TOKEN="x" * 20)
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "instance root only" in str(exc.value)


def test_trailing_slash_is_stripped(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("JIRA_BASE_URL", "https://jira.test.internal/")
    assert load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic")).base_url == "https://jira.test.internal"


def test_unreadable_ca_bundle_is_caught_at_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    """Checked here so a TLS error later can be attributed precisely."""
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("ATLASSIAN_CA_BUNDLE", "/no/such/bundle.pem")
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "ATLASSIAN_CA_BUNDLE" in str(exc.value)


# ── the result cap ─────────────────────────────────────────────────────────


def test_cap_defaults_to_50(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, **BEARER_ENV)
    assert load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic")).max_results_cap == DEFAULT_MAX_RESULTS


def test_cap_above_the_hard_ceiling_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """100 is a ceiling, not a default - it cannot be raised by configuration."""
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("ATLASSIAN_MAX_RESULTS_CAP", str(HARD_MAX_RESULTS + 1))
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "hard ceiling" in str(exc.value)


def test_non_numeric_cap_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("ATLASSIAN_MAX_RESULTS_CAP", "lots")
    with pytest.raises(ConfigError):
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))


def test_requests_are_clamped_not_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A model asking for 500 means "as many as possible"; erroring teaches it nothing."""
    setenv(monkeypatch, **BEARER_ENV)
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert cfg.clamp_max_results(500) == DEFAULT_MAX_RESULTS
    assert cfg.clamp_max_results(10) == 10
    assert cfg.clamp_max_results(0) == 1
    assert cfg.clamp_max_results(-5) == 1
    assert cfg.clamp_max_results(None) == 25
    assert cfg.clamp_max_results("nonsense") == 25  # type: ignore[arg-type]


# ── auth header construction ───────────────────────────────────────────────


def test_bearer_header_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, **BEARER_ENV)
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert cfg.auth_headers() == {
        "Authorization": f"Bearer {BEARER_ENV['ATLASSIAN_TOKEN']}"
    }


def test_basic_header_is_base64_of_email_colon_token(monkeypatch: pytest.MonkeyPatch) -> None:
    import base64

    setenv(
        monkeypatch,
        JIRA_BASE_URL="https://x.atlassian.net",
        ATLASSIAN_AUTH_MODE="basic",
        ATLASSIAN_USER="u@corp.example",
        ATLASSIAN_TOKEN="cloud-token-value-abcdef",
    )
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    expected = base64.b64encode(b"u@corp.example:cloud-token-value-abcdef").decode()
    assert cfg.auth_headers() == {"Authorization": f"Basic {expected}"}


def test_timeouts_default_to_10_and_30(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, **BEARER_ENV)
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert (cfg.connect_timeout, cfg.read_timeout) == (10.0, 30.0)


def test_timeouts_are_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("ATLASSIAN_CONNECT_TIMEOUT", "5")
    monkeypatch.setenv("ATLASSIAN_READ_TIMEOUT", "60")
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert (cfg.connect_timeout, cfg.read_timeout) == (5.0, 60.0)


# ── the third auth mode, and the estate-wide fallback ──────────────────────


def test_header_mode_uses_the_products_own_header_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitLab's case. `Authorization: Bearer <pat>` is a 401 on self-managed
    instances that accept the identical token as `PRIVATE-TOKEN`, so the header
    name has to be a per-product fact rather than a constant in the client."""
    setenv(
        monkeypatch,
        GITLAB_BASE_URL="https://gitlab.test.internal",
        GITLAB_AUTH_MODE="header",
        GITLAB_TOKEN="glpat-example-token-value",
    )
    cfg = load_config(
        "GITLAB_BASE_URL",
        "GitLab",
        env_prefix="GITLAB",
        auth_modes=("header",),
        default_auth_mode="header",
        auth_header_name="PRIVATE-TOKEN",
    )
    assert cfg.auth_headers() == {"PRIVATE-TOKEN": "glpat-example-token-value"}
    # And nothing leaks into the header every other product uses.
    assert "Authorization" not in cfg.auth_headers()


def test_a_mode_the_product_cannot_use_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Offering a mode that cannot work is offering a choice that can only be
    a mistake, and it fails as a 401 rather than as a config error."""
    setenv(
        monkeypatch,
        GITLAB_BASE_URL="https://gitlab.test.internal",
        GITLAB_AUTH_MODE="bearer",
        GITLAB_TOKEN="glpat-example-token-value",
    )
    with pytest.raises(ConfigError) as exc:
        load_config(
            "GITLAB_BASE_URL",
            "GitLab",
            env_prefix="GITLAB",
            auth_modes=("header",),
            auth_header_name="PRIVATE-TOKEN",
        )
    assert "GITLAB_AUTH_MODE" in str(exc.value)
    assert "'header'" in str(exc.value)


def test_shared_prefix_covers_a_product_that_sets_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One corporate root CA signs all four instances. Making the user set the
    same path under four names is how three of them go stale."""
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("MCP_READ_TIMEOUT", "45")
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert cfg.read_timeout == 45.0


def test_the_specific_variable_beats_the_shared_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("MCP_READ_TIMEOUT", "45")
    monkeypatch.setenv("ATLASSIAN_READ_TIMEOUT", "90")
    cfg = load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert cfg.read_timeout == 90.0


def test_a_bad_shared_value_names_the_shared_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The whole point of naming the variable is naming the RIGHT one. An error
    that says ATLASSIAN_MAX_RESULTS_CAP sends the user to edit a line they
    never wrote."""
    setenv(monkeypatch, **BEARER_ENV)
    monkeypatch.setenv("MCP_MAX_RESULTS_CAP", "9999")
    with pytest.raises(ConfigError) as exc:
        load_config("JIRA_BASE_URL", "Jira", env_prefix="ATLASSIAN",
                       auth_modes=("bearer", "basic"))
    assert "MCP_MAX_RESULTS_CAP" in str(exc.value)
    assert "ATLASSIAN_MAX_RESULTS_CAP" not in str(exc.value)


def test_a_base_url_carrying_a_non_atlassian_api_path_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`/rest/` was the only marker checked. GitLab and Jenkins paste errors
    look different and produced the same doubled-path 404."""
    for bad in (
        "https://gitlab.test.internal/api/v4",
        "https://jenkins.test.internal/api/json",
    ):
        monkeypatch.setenv("GITLAB_BASE_URL", bad)
        monkeypatch.setenv("GITLAB_AUTH_MODE", "header")
        monkeypatch.setenv("GITLAB_TOKEN", "glpat-example-token-value")
        with pytest.raises(ConfigError) as exc:
            load_config("GITLAB_BASE_URL", "GitLab", env_prefix="GITLAB",
                        auth_modes=("header",), auth_header_name="PRIVATE-TOKEN")
        assert "instance root only" in str(exc.value)
