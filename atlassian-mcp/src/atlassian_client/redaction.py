"""Keeping the token out of everything that leaves this process.

The threat here is not malice, it is plumbing. A PAT reaches us as a string and
then wants to travel: into an httpx exception's ``repr`` (which includes the
request headers on some error paths), into a traceback frame's local variables,
into a log line someone added while debugging, into an MCP tool result that
lands verbatim in a model's context window and from there into a transcript
that gets pasted into a ticket.

So redaction is applied at the boundary rather than at each call site. Every
error this package raises goes through :func:`scrub`, and the one place that
formats an exception for a user goes through :func:`safe_exception_text`.

Registration is deliberate: we redact the *actual* secret values we were given,
not anything that pattern-matches a token. Pattern matching both misses real
secrets (a PAT is just an opaque string) and mangles legitimate output (an
issue summary containing a long hex string is not a credential).
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# Populated at startup by config.load_config(). Module-level because redaction
# has to work from inside exception handlers deep in the stack that have no
# reference to the config object.
_SECRETS: set[str] = set()

# Short strings would redact half the output. A real PAT or API token is much
# longer than this; anything shorter is not worth the false positives.
_MIN_SECRET_LEN = 8

PLACEHOLDER = "***REDACTED***"


def register_secret(value: str | None) -> None:
    """Mark a value as a secret to be scrubbed from all outbound text.

    Called for the raw token AND for its derived forms - the base64 blob in a
    Basic header is not the same string as the token, and redacting only the
    token would leak the credential in its encoded form.
    """
    if value and len(value) >= _MIN_SECRET_LEN:
        _SECRETS.add(value)


def register_secrets(values: Iterable[str | None]) -> None:
    for v in values:
        register_secret(v)


def clear_secrets() -> None:
    """Only for tests. Production never un-registers a secret."""
    _SECRETS.clear()


def scrub(text: Any) -> str:
    """Replace every registered secret in ``text`` with the placeholder.

    Also catches the two shapes a credential takes on the wire even when the
    exact value was never registered - an ``Authorization`` header rendered
    into a string, which is how httpx leaks one in a ``repr``.
    """
    s = str(text)
    # Longest first: if a token happens to contain a shorter registered secret
    # as a substring, replacing the short one first would leave fragments of
    # the long one visible around the placeholder.
    for secret in sorted(_SECRETS, key=len, reverse=True):
        s = s.replace(secret, PLACEHOLDER)

    # Belt and braces. These fire on header text that got stringified before we
    # ever saw the value, e.g. from a library's own error formatting.
    s = re.sub(
        r"(?i)(authorization[\"']?\s*[:=]\s*[\"']?\s*)(bearer|basic)\s+\S+",
        rf"\1\2 {PLACEHOLDER}",
        s,
    )
    return s


def safe_exception_text(exc: BaseException) -> str:
    """A one-line description of ``exc`` with secrets removed.

    Deliberately does NOT include a traceback. A traceback's frame locals can
    hold the token, the auth header and the whole request object, and there is
    no reliable way to scrub a rendered traceback without also destroying the
    file paths and line numbers that make it useful. Callers who need a
    traceback should log it locally, never return it through a tool result.
    """
    return f"{type(exc).__name__}: {scrub(exc)}"
