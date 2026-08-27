"""Shared read-only HTTP client for every MCP server in this directory.

Jira, Confluence, GitLab and Jenkins import from here so there is exactly one
implementation of auth, the read-only guard, error mapping and redaction.
Nothing in this package mutates anything on any instance, and
:func:`assert_read_only` is what makes that a property of the code rather than
a promise in a README.

The package is named for the property it enforces rather than for the first
product that used it. It began as ``atlassian_client``; that name stopped being
true the moment a second vendor's server imported it, and a misleading name on
a security boundary is worth renaming early.
"""

from .config import (
    AUTH_MODES,
    AuthMode,
    ConfigError,
    DEFAULT_MAX_RESULTS,
    HARD_MAX_RESULTS,
    SHARED_PREFIX,
    ServiceConfig,
    env_lookup,
    load_config,
)
from .errors import (
    AuthError,
    NotFoundError,
    PermissionError_,
    RateLimitError,
    ReadOnlyViolation,
    ServiceError,
    TransportError,
)
from .http import (
    ALLOWED_METHODS,
    DEFAULT_TEXT_LIMIT,
    ReadOnlyClient,
    TextResponse,
    assert_read_only,
    normalise_path,
)
from .redaction import register_secret, safe_exception_text, scrub

__all__ = [
    "ALLOWED_METHODS",
    "AUTH_MODES",
    "AuthError",
    "AuthMode",
    "ConfigError",
    "DEFAULT_MAX_RESULTS",
    "DEFAULT_TEXT_LIMIT",
    "HARD_MAX_RESULTS",
    "NotFoundError",
    "PermissionError_",
    "RateLimitError",
    "ReadOnlyClient",
    "ReadOnlyViolation",
    "SHARED_PREFIX",
    "ServiceConfig",
    "ServiceError",
    "TextResponse",
    "TransportError",
    "assert_read_only",
    "env_lookup",
    "load_config",
    "normalise_path",
    "register_secret",
    "safe_exception_text",
    "scrub",
]
