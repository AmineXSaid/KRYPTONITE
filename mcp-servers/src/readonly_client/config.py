"""Configuration, read from the environment once at startup.

Three rules shape this module.

**Fail loudly, at startup, naming the variable.** A half-configured server that
starts and then 401s on every call is worse than one that refuses to start: the
failure surfaces later, further from its cause, and looks like an auth problem
with the instance rather than a missing line in a config file. So every
required variable is checked before the server binds, and the message names the
exact variable and the mode that made it required.

**The token is a secret from the moment it is read.** It is registered with the
redaction module here, before it is used for anything, so that any later failure
- including one raised while building the auth header - cannot echo it.

**Every product gets its own variables, with an estate-wide fallback.** Four
services on one corporate network share one root CA but not one credential, so
each setting is looked up as ``<PREFIX>_NAME`` first and ``MCP_NAME`` second.
Setting ``MCP_CA_BUNDLE`` once covers all four; ``JENKINS_READ_TIMEOUT`` still
wins for the one service whose console fetches are slow.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Mapping

from .redaction import register_secret

# bearer  Authorization: Bearer <token>            Jira/Confluence DC PAT
# basic   Authorization: Basic base64(user:token)  Atlassian Cloud, Jenkins
# header  <name>: <token>                          GitLab's PRIVATE-TOKEN
#
# `header` exists because GitLab is the odd one out: self-managed instances
# have historically answered `Authorization: Bearer <PAT>` with a 401 while
# accepting the identical token as `PRIVATE-TOKEN`. That is not something a
# bearer/basic dichotomy can express, and hard-coding GitLab's header name into
# the client would put a product detail in the shared core.
AuthMode = Literal["bearer", "basic", "header"]

AUTH_MODES: tuple[AuthMode, ...] = ("bearer", "basic", "header")

# The task specifies 50/100. The cap is enforced in two places for different
# reasons: DEFAULT_MAX_RESULTS is what a caller gets when it does not ask, and
# HARD_MAX_RESULTS is the ceiling no caller can exceed however loudly it asks.
DEFAULT_MAX_RESULTS = 50
HARD_MAX_RESULTS = 100

DEFAULT_CONNECT_TIMEOUT = 10.0
DEFAULT_READ_TIMEOUT = 30.0

# Estate-wide fallback prefix. `<PREFIX>_X` wins; `MCP_X` applies to every
# server that has no specific value.
SHARED_PREFIX = "MCP"


class ConfigError(RuntimeError):
    """Raised at startup for missing or contradictory configuration."""


@dataclass(frozen=True)
class ServiceConfig:
    """Resolved, validated configuration for one service.

    One type for Jira, Confluence, GitLab and Jenkins. What differs between
    them - the header a credential travels in, the extra headers an instance
    needs, which POST paths are searches rather than writes - is data on this
    object, not a branch inside the client.
    """

    base_url: str
    auth_mode: AuthMode
    # Exactly one group is populated, per auth_mode.
    #   bearer: token
    #   basic:  username + token
    #   header: auth_header_name + token
    token: str | None = None
    username: str | None = None
    auth_header_name: str = "Authorization"

    ca_bundle: str | None = None
    max_results_cap: int = DEFAULT_MAX_RESULTS
    connect_timeout: float = DEFAULT_CONNECT_TIMEOUT
    read_timeout: float = DEFAULT_READ_TIMEOUT

    # Which product this is, used only for error text ("Jira" / "Jenkins").
    product: str = "service"
    # The env var the base URL came from, so errors can name it precisely.
    base_url_var: str = "BASE_URL"
    # The prefix its other variables carry, so errors can name those too.
    env_prefix: str = "MCP"

    # Headers this product needs on every request beyond auth and Accept.
    # Atlassian DC needs X-Atlassian-Token; nothing else does.
    extra_headers: Mapping[str, str] = field(default_factory=dict)

    # One sentence about what a wrong API root looks like for THIS product,
    # appended to the HTML-404 message. Jira's answer ("DC uses /rest/api/2,
    # Cloud uses /rest/api/3") is useless to a Jenkins user, so the knowledge
    # travels with the product rather than living in errors.py.
    wrong_path_hint: str = ""

    # The exact paths this client may POST to. POST is a write everywhere
    # except a handful of search endpoints that take a body, and the set of
    # those is a property of the product, so it travels with the config rather
    # than living as a module global the guard reads for every client.
    #
    # Empty by default: a config that says nothing gets GET and only GET.
    search_post_allowlist: tuple[str, ...] = ()

    def auth_headers(self) -> dict[str, str]:
        """The header(s) that carry the credential.

        A dict rather than a single ``Authorization`` value because not every
        product uses that header. Sending the wrong shape produces a 401 that
        looks exactly like a bad token, which is the most expensive way for
        this to be wrong.
        """
        if self.auth_mode == "bearer":
            return {"Authorization": f"Bearer {self.token}"}
        if self.auth_mode == "basic":
            blob = base64.b64encode(f"{self.username}:{self.token}".encode()).decode()
            return {"Authorization": f"Basic {blob}"}
        return {self.auth_header_name: str(self.token)}

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


def env_lookup(prefix: str, name: str) -> tuple[str, str]:
    """Resolve ``name`` for ``prefix``, falling back to the shared prefix.

    Returns ``(value, var_name)`` so the caller can report which variable it
    actually read - naming ``MCP_CA_BUNDLE`` in an error when that is where the
    bad value came from, rather than the ``JIRA_CA_BUNDLE`` the user never set.
    Value is ``""`` when neither is set; ``var_name`` is then the specific one,
    because that is the one to tell the user to set.
    """
    specific = f"{prefix}_{name}"
    raw = os.environ.get(specific, "")
    if raw.strip():
        return raw.strip(), specific
    if prefix != SHARED_PREFIX:
        shared = f"{SHARED_PREFIX}_{name}"
        raw = os.environ.get(shared, "")
        if raw.strip():
            return raw.strip(), shared
    return "", specific


def _require(name: str, why: str) -> str:
    raw = os.environ.get(name, "")
    # Blank is treated as missing on purpose. `export JIRA_TOKEN=` in a shell
    # profile is a common way to end up "configured" with nothing.
    if not raw.strip():
        raise ConfigError(f"{name} is not set. {why}")
    return raw.strip()


def _require_prefixed(prefix: str, name: str, why: str) -> str:
    value, var = env_lookup(prefix, name)
    if not value:
        raise ConfigError(f"{var} is not set. {why}")
    return value


def _resolve_ca_bundle(prefix: str) -> str | None:
    """Validate the CA bundle path points at a readable file, if set.

    Checked at startup rather than at first request because an unreadable CA
    bundle otherwise surfaces as a TLS error on the first call, which is the
    error we most want to be able to attribute precisely.
    """
    raw, var = env_lookup(prefix, "CA_BUNDLE")
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_file():
        raise ConfigError(
            f"{var} points at {p}, which is not a readable file. "
            "It must be a PEM bundle containing your corporate root CA."
        )
    return str(p)


def _resolve_cap(prefix: str) -> int:
    raw, var = env_lookup(prefix, "MAX_RESULTS_CAP")
    if not raw:
        return DEFAULT_MAX_RESULTS
    try:
        n = int(raw)
    except ValueError:
        raise ConfigError(f"{var} must be an integer, got {raw!r}.") from None
    if n < 1:
        raise ConfigError(f"{var} must be at least 1, got {n}.")
    if n > HARD_MAX_RESULTS:
        raise ConfigError(
            f"{var} is {n}, above the hard ceiling of {HARD_MAX_RESULTS}. "
            "Lower it; the ceiling is not configurable."
        )
    return n


def _resolve_timeout(prefix: str, name: str, default: float) -> float:
    raw, var = env_lookup(prefix, name)
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ConfigError(f"{var} must be a number of seconds, got {raw!r}.") from None
    if v <= 0:
        raise ConfigError(f"{var} must be greater than zero, got {v}.")
    return v


def _resolve_base_url(base_url_var: str, product: str) -> str:
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
    for marker in ("/rest/", "/api/v4", "/api/json"):
        if marker in base_url:
            raise ConfigError(
                f"{base_url_var} should be the instance root only, not an API path. "
                f"Got {base_url!r}. Drop everything from {marker.rstrip('/')} onward."
            )
    return base_url


def _resolve_auth(
    prefix: str,
    mode_var: str,
    allowed: tuple[AuthMode, ...],
    default_mode: AuthMode | None,
) -> AuthMode:
    raw = os.environ.get(mode_var, "").strip().lower()
    if not raw:
        if default_mode is not None:
            return default_mode
        raise ConfigError(
            f"{mode_var} is not set. Use "
            + " or ".join(f"'{m}'" for m in allowed)
            + "."
        )
    if raw not in allowed:
        raise ConfigError(
            f"{mode_var} must be "
            + " or ".join(f"'{m}'" for m in allowed)
            + f", got {raw!r}."
        )
    return raw  # type: ignore[return-value]


def load_config(
    base_url_var: str,
    product: str,
    *,
    env_prefix: str,
    auth_mode_var: str | None = None,
    auth_modes: tuple[AuthMode, ...] = AUTH_MODES,
    default_auth_mode: AuthMode | None = None,
    auth_header_name: str = "Authorization",
    extra_headers: Mapping[str, str] | None = None,
    search_post_allowlist: tuple[str, ...] = (),
    wrong_path_hint: str = "",
) -> ServiceConfig:
    """Read and validate configuration for one service.

    ``env_prefix`` names the variable family - ``ATLASSIAN``, ``GITLAB``,
    ``JENKINS`` - so that four servers on one machine do not fight over one set
    of names. Jira and Confluence share the ``ATLASSIAN`` prefix deliberately:
    a corporate instance issues one credential per user that works against
    both, and making the user paste it twice under two names invites the two
    copies to drift.

    ``auth_modes`` narrows what the mode variable will accept, because offering
    a mode a product cannot use is offering a choice that can only be a
    mistake - GitLab has no Basic form worth using, and Jenkins has no PAT.
    """
    base_url = _resolve_base_url(base_url_var, product)

    mode_var = auth_mode_var or f"{env_prefix}_AUTH_MODE"
    auth_mode = _resolve_auth(env_prefix, mode_var, auth_modes, default_auth_mode)

    token: str | None = None
    username: str | None = None

    if auth_mode == "bearer":
        token = _require_prefixed(
            env_prefix,
            "TOKEN",
            "Bearer mode sends it as `Authorization: Bearer <token>`. On "
            "Atlassian Data Center this is a Personal Access Token, generated "
            "in your profile under Personal Access Tokens.",
        )
        register_secret(token)
    elif auth_mode == "basic":
        username = _require_prefixed(
            env_prefix,
            "USER",
            "Basic mode needs a username as well as a token. On Atlassian "
            "Cloud that is your account email; on Jenkins it is your login.",
        )
        token = _require_prefixed(
            env_prefix,
            "TOKEN",
            "Basic mode pairs the username with an API token - from "
            "id.atlassian.com for Atlassian Cloud, or from your user page on "
            "Jenkins. Do not use your password.",
        )
        register_secret(token)
        # The base64 blob is a different string from the token but carries it
        # verbatim. Registering both means neither form can leak.
        register_secret(base64.b64encode(f"{username}:{token}".encode()).decode())
    else:  # header
        token = _require_prefixed(
            env_prefix,
            "TOKEN",
            f"Header mode sends it as `{auth_header_name}: <token>`.",
        )
        register_secret(token)

    cfg = ServiceConfig(
        base_url=base_url,
        auth_mode=auth_mode,
        token=token,
        username=username,
        auth_header_name=auth_header_name,
        ca_bundle=_resolve_ca_bundle(env_prefix),
        max_results_cap=_resolve_cap(env_prefix),
        connect_timeout=_resolve_timeout(
            env_prefix, "CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT
        ),
        read_timeout=_resolve_timeout(env_prefix, "READ_TIMEOUT", DEFAULT_READ_TIMEOUT),
        product=product,
        base_url_var=base_url_var,
        env_prefix=env_prefix,
        extra_headers=dict(extra_headers or {}),
        wrong_path_hint=wrong_path_hint,
        search_post_allowlist=tuple(search_post_allowlist),
    )
    # Registering the assembled header values covers the case where a library
    # renders the header rather than the token it was built from.
    for value in cfg.auth_headers().values():
        register_secret(value)
    return cfg
