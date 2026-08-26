"""Configuration, read from the environment once at startup.

Two rules shape this module.

**Fail loudly, at startup, naming the variable.** A half-configured server that
starts and then 401s on every call is worse than one that refuses to start: the
failure surfaces later, further from its cause, and looks like an auth problem
with the instance rather than a missing line in a config file. So every
required variable is checked before the server binds, and the message names the
exact variable and the mode that made it required.

**The token is a secret from the moment it is read.** It is registered with the
redaction module here, before it is used for anything, so that any later failure
- including one raised while building the auth header - cannot echo it.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .redaction import register_secret

AuthMode = Literal["bearer", "basic"]

# The task specifies 50/100. The cap is enforced in two places for different
# reasons: DEFAULT_MAX_RESULTS is what a caller gets when it does not ask, and
# HARD_MAX_RESULTS is the ceiling no caller can exceed however loudly it asks.
DEFAULT_MAX_RESULTS = 50
HARD_MAX_RESULTS = 100

DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 30.0


class ConfigError(RuntimeError):
    """Raised at startup for missing or contradictory configuration."""


@dataclass(frozen=True)
class AtlassianConfig:
    """Resolved, validated configuration for one Atlassian product."""

    base_url: str
    auth_mode: AuthMode
    # Exactly one of these is populated, per auth_mode.
    pat: str | None = None
    email: str | None = None
    api_token: str | None = None

    ca_bundle: str | None = None
    max_results_cap: int = DEFAULT_MAX_RESULTS
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT
    read_timeout: float = DEFAULT_READ_TIMEOUT

    # Which product this is, used only for error text ("Jira" / "Confluence").
    product: str = "Atlassian"
    # The env var the base URL came from, so errors can name it precisely.
    base_url_var: str = "BASE_URL"

    def auth_header(self) -> str:
        """The value for the ``Authorization`` header.

        Data Center takes a Personal Access Token as a bearer credential.
        Cloud takes email + API token as HTTP Basic. These are not
        interchangeable: sending a PAT as Basic, or a Cloud API token as
        Bearer, produces a 401 that looks exactly like a bad token.
        """
        if self.auth_mode == "bearer":
            return f"Bearer {self.pat}"
        blob = base64.b64encode(f"{self.email}:{self.api_token}".encode()).decode()
        return f"Basic {blob}"

    def clamp_max_results(self, requested: int | None) -> int:
        """Bring a caller's requested page size inside the configured ceiling.

        Silently clamping rather than erroring is the right call for a tool a
        model drives: a model that asks for 500 wants "as many as I can get",
        and failing the call teaches it nothing it can act on. The response
        carries the count actually returned, so nothing is hidden.
        """
        if requested is None:
            return min(25, self.max_results_cap)
        try:
            n = int(requested)
        except (TypeError, ValueError):
            return min(25, self.max_results_cap)
        return max(1, min(n, self.max_results_cap))


def _require(name: str, why: str) -> str:
    raw = os.environ.get(name, "")
    # Blank is treated as missing on purpose. `EXPORT ATLASSIAN_PAT=` in a
    # shell profile is a common way to end up "configured" with nothing.
    if not raw.strip():
        raise ConfigError(f"{name} is not set. {why}")
    return raw.strip()


def _resolve_ca_bundle() -> str | None:
    """Validate ATLASSIAN_CA_BUNDLE points at a readable file, if set.

    Checked at startup rather than at first request because an unreadable CA
    bundle otherwise surfaces as a TLS error on the first call, which is the
    error we most want to be able to attribute precisely.
    """
    raw = os.environ.get("ATLASSIAN_CA_BUNDLE", "").strip()
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_file():
        raise ConfigError(
            f"ATLASSIAN_CA_BUNDLE points at {p}, which is not a readable file. "
            "It must be a PEM bundle containing your corporate root CA."
        )
    return str(p)


def _resolve_cap() -> int:
    raw = os.environ.get("MAX_RESULTS_CAP", "").strip()
    if not raw:
        return DEFAULT_MAX_RESULTS
    try:
        n = int(raw)
    except ValueError:
        raise ConfigError(
            f"MAX_RESULTS_CAP must be an integer, got {raw!r}."
        ) from None
    if n < 1:
        raise ConfigError(f"MAX_RESULTS_CAP must be at least 1, got {n}.")
    if n > HARD_MAX_RESULTS:
        raise ConfigError(
            f"MAX_RESULTS_CAP is {n}, above the hard ceiling of "
            f"{HARD_MAX_RESULTS}. Lower it; the ceiling is not configurable."
        )
    return n


def _resolve_timeout(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a number of seconds, got {raw!r}.") from None
    if v <= 0:
        raise ConfigError(f"{name} must be greater than zero, got {v}.")
    return v


def load_config(base_url_var: str, product: str) -> AtlassianConfig:
    """Read and validate configuration for one product.

    ``base_url_var`` is ``JIRA_BASE_URL`` or ``CONFLUENCE_BASE_URL``. Auth is
    shared between the two products because a corporate instance issues one
    credential per user that works against both.
    """
    base_url = _require(
        base_url_var,
        f"Set it to the root of your {product} instance, "
        f"e.g. https://{product.lower()}.company.internal (no trailing path).",
    ).rstrip("/")

    if not base_url.startswith(("http://", "https://")):
        raise ConfigError(
            f"{base_url_var} must start with http:// or https://, got {base_url!r}."
        )
    # A base URL carrying an API path is a common paste error, and it produces
    # doubled paths like /rest/api/2/rest/api/2/search that 404 confusingly.
    if "/rest/" in base_url:
        raise ConfigError(
            f"{base_url_var} should be the instance root only, not an API path. "
            f"Got {base_url!r}. Drop everything from /rest onward."
        )

    mode_raw = os.environ.get("ATLASSIAN_AUTH_MODE", "").strip().lower()
    if not mode_raw:
        raise ConfigError(
            "ATLASSIAN_AUTH_MODE is not set. Use 'bearer' for Data Center "
            "(Personal Access Token) or 'basic' for Cloud (email + API token)."
        )
    if mode_raw not in ("bearer", "basic"):
        raise ConfigError(
            f"ATLASSIAN_AUTH_MODE must be 'bearer' or 'basic', got {mode_raw!r}."
        )
    auth_mode: AuthMode = mode_raw  # type: ignore[assignment]

    pat = email = api_token = None
    if auth_mode == "bearer":
        pat = _require(
            "ATLASSIAN_PAT",
            "Bearer mode uses a Personal Access Token. Generate one in your "
            "Atlassian profile under Personal Access Tokens.",
        )
        register_secret(pat)
    else:
        email = _require(
            "ATLASSIAN_EMAIL", "Basic mode uses your account email plus an API token."
        )
        api_token = _require(
            "ATLASSIAN_API_TOKEN",
            "Basic mode uses an API token from id.atlassian.com.",
        )
        register_secret(api_token)
        # The base64 blob is a different string from the token but carries it
        # verbatim. Registering both means neither form can leak.
        register_secret(
            base64.b64encode(f"{email}:{api_token}".encode()).decode()
        )

    cfg = AtlassianConfig(
        base_url=base_url,
        auth_mode=auth_mode,
        pat=pat,
        email=email,
        api_token=api_token,
        ca_bundle=_resolve_ca_bundle(),
        max_results_cap=_resolve_cap(),
        connect_timeout=_resolve_timeout("ATLASSIAN_CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT),
        read_timeout=_resolve_timeout("ATLASSIAN_READ_TIMEOUT", DEFAULT_READ_TIMEOUT),
        product=product,
        base_url_var=base_url_var,
    )
    # Registering the assembled header covers the case where a library renders
    # the header value rather than the token it was built from.
    register_secret(cfg.auth_header())
    return cfg
