"""Shared read-only Atlassian client for the Jira and Confluence MCP servers.

Both servers import from here so there is exactly one implementation of auth,
the read-only guard, error mapping and redaction. Nothing in this package
mutates anything on the instance, and :func:`assert_read_only` is what makes
that a property of the code rather than a promise in a README.
"""

from .config import (
    AtlassianConfig,
    ConfigError,
    DEFAULT_MAX_RESULTS,
    HARD_MAX_RESULTS,
    load_config,
)
from .errors import (
    AtlassianError,
    AuthError,
    NotFoundError,
    PermissionError_,
    RateLimitError,
    ReadOnlyViolation,
    TransportError,
)
from .http import ReadOnlyClient, assert_read_only, normalise_path
from .redaction import register_secret, safe_exception_text, scrub

__all__ = [
    "AtlassianConfig",
    "AtlassianError",
    "AuthError",
    "ConfigError",
    "DEFAULT_MAX_RESULTS",
    "HARD_MAX_RESULTS",
    "NotFoundError",
    "PermissionError_",
    "RateLimitError",
    "ReadOnlyClient",
    "ReadOnlyViolation",
    "TransportError",
    "assert_read_only",
    "load_config",
    "normalise_path",
    "register_secret",
    "safe_exception_text",
    "scrub",
]
