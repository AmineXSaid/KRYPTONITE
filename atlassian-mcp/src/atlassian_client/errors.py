"""Turning transport and HTTP failures into messages that name the fix.

The distinctions here are the whole point. "Something went wrong" costs a user
twenty minutes; "authenticated, but no permission on this project" costs them
one. Two pairs matter most:

  401 vs 403  A rejected token and a valid token without access are opposite
              problems with opposite fixes - regenerate the credential, versus
              ask a space admin for access. Collapsing them into "access
              denied" sends people to re-issue a PAT that was never the issue.

  404 path vs 404 item
              Atlassian answers both "this endpoint does not exist" and "this
              issue does not exist, or you cannot see it" with 404. The first
              means the client is pointed at the wrong deployment type; the
              second is normal. We separate them by asking whether the response
              looks like an API error or like a web page, since a wrong path on
              a DC instance usually falls through to the site's HTML 404.

Note the third case folded into item-not-found: Jira and Confluence both return
404 rather than 403 for an item that exists but is invisible to the caller.
That is a deliberate anti-enumeration choice on Atlassian's part, and we cannot
undo it, so the message says both.
"""

from __future__ import annotations

import httpx

from .redaction import safe_exception_text, scrub


class AtlassianError(RuntimeError):
    """Base for every error surfaced to a tool caller.

    Carries no response body by default: bodies can echo request headers on
    some gateway error pages, and a tool result goes straight into a model's
    context. Subclasses add only text they have constructed themselves.
    """


class AuthError(AtlassianError):
    """401 - the credential was rejected."""


class PermissionError_(AtlassianError):
    """403 - the credential is good, the caller lacks rights."""


class NotFoundError(AtlassianError):
    """404 - either the path or the item."""


class RateLimitError(AtlassianError):
    """429 after retries were exhausted."""


class TransportError(AtlassianError):
    """DNS, connect, timeout, TLS."""


class ReadOnlyViolation(AtlassianError):
    """A caller tried to make a request this client refuses to build.

    Deliberately not an HTTP error: it is raised before any connection exists.
    """


def _looks_like_html(response: httpx.Response) -> bool:
    ctype = response.headers.get("content-type", "").lower()
    if "html" in ctype:
        return True
    return response.text.lstrip()[:15].lower().startswith(("<!doctype", "<html"))


def _atlassian_messages(response: httpx.Response) -> str:
    """Pull Atlassian's own error strings out of a JSON error body.

    Both products answer errors with ``errorMessages`` (a list) and/or
    ``errors`` (a dict), and those strings are genuinely useful - an invalid
    JQL field name is reported there and nowhere else. Everything else in the
    body is dropped.
    """
    try:
        data = response.json()
    except Exception:
        return ""
    if not isinstance(data, dict):
        return ""
    parts: list[str] = []
    msgs = data.get("errorMessages")
    if isinstance(msgs, list):
        parts.extend(str(m) for m in msgs if m)
    errs = data.get("errors")
    if isinstance(errs, dict):
        parts.extend(f"{k}: {v}" for k, v in errs.items())
    # Confluence uses a flat `message` on some error shapes.
    if not parts and isinstance(data.get("message"), str):
        parts.append(data["message"])
    return scrub("; ".join(parts))


def raise_for_response(
    response: httpx.Response,
    *,
    product: str,
    path: str,
    base_url_var: str,
) -> None:
    """Map a non-2xx response onto a precise, actionable error.

    ``product`` and ``base_url_var`` are threaded through so the message can
    name the variable the user has to change, rather than describing the
    problem in the abstract.
    """
    status = response.status_code
    if status < 400:
        return

    detail = _atlassian_messages(response)
    suffix = f" {product} said: {detail}" if detail else ""

    if status == 401:
        var = "ATLASSIAN_PAT" if "Bearer" in response.request.headers.get(
            "authorization", "Bearer"
        ) else "ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN"
        raise AuthError(
            "Token rejected (HTTP 401). Check "
            f"{var} and that ATLASSIAN_AUTH_MODE matches your deployment "
            "('bearer' for Data Center PATs, 'basic' for Cloud email+API "
            f"token). The credential itself was not logged.{suffix}"
        )

    if status == 403:
        # Explicitly NOT an auth problem, and the message has to say so or the
        # user will go and regenerate a working token.
        raise PermissionError_(
            "Authenticated, but no permission on this project/space (HTTP 403). "
            "The token is valid - your account lacks rights to this resource, "
            "or a project/space permission scheme excludes it. Regenerating the "
            f"token will not help; ask the project or space admin for access.{suffix}"
        )

    if status == 404:
        if _looks_like_html(response):
            # An HTML 404 means the request never reached the REST layer, which
            # on these products almost always means wrong deployment shape.
            raise NotFoundError(
                f"HTTP 404 with an HTML body for {path} - this looks like a wrong "
                f"API path rather than a missing item. Check {base_url_var} points "
                "at the instance root, and that the deployment type is right: "
                "Data Center uses /rest/api/2 (Jira) and /rest/api with no /wiki "
                "prefix (Confluence); Cloud uses /rest/api/3 and /wiki/rest/api. "
                "Run probe.py to see which this instance is."
            )
        raise NotFoundError(
            f"HTTP 404 for {path} - the item does not exist, or it exists and your "
            f"account cannot see it. {product} returns 404 rather than 403 for "
            f"invisible items, so these two cannot be told apart from here.{suffix}"
        )

    if status == 429:
        raise RateLimitError(
            "Rate limited by the instance (HTTP 429) and retries are exhausted. "
            "Retry-After was honoured up to the retry cap. Reduce max_results or "
            f"slow the call rate.{suffix}"
        )

    if 500 <= status < 600:
        raise AtlassianError(
            f"{product} returned HTTP {status} for {path}. This is a server-side "
            f"fault on the instance, not a problem with the request.{suffix}"
        )

    raise AtlassianError(f"{product} returned HTTP {status} for {path}.{suffix}")


def transport_error(exc: Exception, *, product: str, base_url: str, base_url_var: str) -> TransportError:
    """Map an httpx transport exception onto a cause the user can act on.

    The TLS branch is the important one. A corporate instance behind a private
    CA fails here on a fresh machine, and the internet's first suggestion is
    ``verify=False``. That turns a configuration problem into a silent
    interception risk on a connection carrying the user's own credential, so it
    is never offered, and the message points at the bundle instead.
    """
    text = safe_exception_text(exc)

    if isinstance(exc, httpx.ConnectTimeout):
        return TransportError(
            f"Timed out connecting to {base_url}. The host may be unreachable "
            "from this network - a corporate instance usually requires VPN. "
            "Raise ATLASSIAN_CONNECT_TIMEOUT if the network is merely slow."
        )
    if isinstance(exc, httpx.ReadTimeout):
        return TransportError(
            f"{product} accepted the connection but did not answer in time. "
            "A broad JQL/CQL query can exceed the read timeout - narrow it, or "
            "raise ATLASSIAN_READ_TIMEOUT."
        )
    # ConnectError wraps TLS failures as well as refused connections, so the
    # certificate check has to look at the message.
    lowered = text.lower()
    if any(k in lowered for k in ("certificate", "ssl", "tls", "self signed", "self-signed")):
        return TransportError(
            f"TLS verification failed for {base_url}: {text}\n"
            "This is what a corporate root CA looks like when the client does "
            "not trust it. Point ATLASSIAN_CA_BUNDLE at your organisation's PEM "
            "bundle. Do not disable verification: this connection carries your "
            "personal token, and an unverified TLS session cannot tell the "
            "instance apart from anything that intercepts it."
        )
    if isinstance(exc, httpx.ConnectError):
        return TransportError(
            f"Could not connect to {base_url}: {text}\n"
            f"Check {base_url_var}, that you are on the corporate network or VPN, "
            "and that HTTPS_PROXY / NO_PROXY are set correctly for an internal host."
        )
    return TransportError(f"Request to {product} failed: {text}")
