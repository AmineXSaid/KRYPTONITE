"""Turning transport and HTTP failures into messages that name the fix.

The distinctions here are the whole point. "Something went wrong" costs a user
twenty minutes; "authenticated, but no permission on this project" costs them
one. Two pairs matter most:

  401 vs 403  A rejected token and a valid token without access are opposite
              problems with opposite fixes - regenerate the credential, versus
              ask an admin for access. Collapsing them into "access denied"
              sends people to re-issue a token that was never the issue.

  404 path vs 404 item
              Every one of these products answers both "this endpoint does not
              exist" and "this item does not exist, or you cannot see it" with
              404. The first means the client is pointed at the wrong
              deployment or API version; the second is normal. We separate them
              by asking whether the response looks like an API error or like a
              web page, since a wrong path usually falls through to the site's
              HTML 404.

Note the third case folded into item-not-found: Jira, Confluence and GitLab all
return 404 rather than 403 for an item that exists but is invisible to the
caller. That is a deliberate anti-enumeration choice on their part, and we
cannot undo it, so the message says both.

Every message that names a variable takes the prefix from the config, so a
GitLab failure says GITLAB_TOKEN and a Jenkins one says JENKINS_TOKEN. A
message naming the wrong variable is worse than one naming none.
"""

from __future__ import annotations

import httpx

from .redaction import safe_exception_text, scrub


class ServiceError(RuntimeError):
    """Base for every error surfaced to a tool caller.

    Carries no response body by default: bodies can echo request headers on
    some gateway error pages, and a tool result goes straight into a model's
    context. Subclasses add only text they have constructed themselves.
    """


class AuthError(ServiceError):
    """401 - the credential was rejected."""


class PermissionError_(ServiceError):
    """403 - the credential is good, the caller lacks rights."""


class NotFoundError(ServiceError):
    """404 - either the path or the item."""


class RateLimitError(ServiceError):
    """429 after retries were exhausted."""


class TransportError(ServiceError):
    """DNS, connect, timeout, TLS."""


class ReadOnlyViolation(ServiceError):
    """A caller tried to make a request this client refuses to build.

    Deliberately not an HTTP error: it is raised before any connection exists.
    """


def _looks_like_html(response: httpx.Response) -> bool:
    ctype = response.headers.get("content-type", "").lower()
    if "html" in ctype:
        return True
    return response.text.lstrip()[:15].lower().startswith(("<!doctype", "<html"))


def _api_messages(response: httpx.Response) -> str:
    """Pull the API's own error strings out of a JSON error body.

    These are genuinely useful and reported nowhere else - an invalid JQL field
    name, a GitLab scope refusal, a Jenkins tree-parameter syntax error.
    Everything else in the body is dropped.

      Atlassian  errorMessages (list) and/or errors (dict)
      Confluence a flat `message` on some shapes
      GitLab     `message` (str or dict) or `error` (str)
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
    if not parts:
        for key in ("message", "error", "error_description"):
            value = data.get(key)
            if isinstance(value, str) and value:
                parts.append(value)
                break
            if isinstance(value, dict) and value:
                parts.extend(f"{k}: {v}" for k, v in value.items())
                break
    return scrub("; ".join(parts))


def raise_for_response(
    response: httpx.Response,
    *,
    product: str,
    path: str,
    base_url_var: str,
    env_prefix: str = "MCP",
    wrong_path_hint: str = "",
) -> None:
    """Map a non-2xx response onto a precise, actionable error.

    ``product``, ``base_url_var`` and ``env_prefix`` are threaded through so
    the message can name the variable the user has to change, rather than
    describing the problem in the abstract. ``wrong_path_hint`` is the
    product's own sentence about what a wrong API root looks like for it - that
    knowledge belongs to the product, not to this module.
    """
    status = response.status_code
    if status < 400:
        return

    detail = _api_messages(response)
    suffix = f" {product} said: {detail}" if detail else ""

    if status == 401:
        raise AuthError(
            f"Token rejected (HTTP 401). Check {env_prefix}_TOKEN, and that "
            f"{env_prefix}_AUTH_MODE matches what this instance expects - the "
            "same token sent in the wrong header or the wrong scheme fails "
            "exactly like a bad one. The credential itself was not logged."
            f"{suffix}"
        )

    if status == 403:
        # Explicitly NOT an auth problem, and the message has to say so or the
        # user will go and regenerate a working token.
        raise PermissionError_(
            "Authenticated, but no permission on this resource (HTTP 403). "
            "The token is valid - your account lacks rights here, or the "
            "token's scopes do not cover this call. Regenerating the token "
            "will not help unless you widen its scopes; otherwise ask an "
            f"admin for access.{suffix}"
        )

    if status == 404:
        if _looks_like_html(response):
            # An HTML 404 means the request never reached the REST layer, which
            # almost always means the wrong API root.
            hint = f" {wrong_path_hint}" if wrong_path_hint else ""
            raise NotFoundError(
                f"HTTP 404 with an HTML body for {path} - this looks like a wrong "
                f"API path rather than a missing item. Check {base_url_var} points "
                f"at the instance root and nothing deeper.{hint} "
                "Run probe.py to see what this instance actually is."
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
        raise ServiceError(
            f"{product} returned HTTP {status} for {path}. This is a server-side "
            f"fault on the instance, not a problem with the request.{suffix}"
        )

    raise ServiceError(f"{product} returned HTTP {status} for {path}.{suffix}")


def transport_error(
    exc: Exception,
    *,
    product: str,
    base_url: str,
    base_url_var: str,
    env_prefix: str = "MCP",
) -> TransportError:
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
            f"Raise {env_prefix}_CONNECT_TIMEOUT if the network is merely slow."
        )
    if isinstance(exc, httpx.ReadTimeout):
        return TransportError(
            f"{product} accepted the connection but did not answer in time. "
            "A broad query or a very large log can exceed the read timeout - "
            f"narrow it, or raise {env_prefix}_READ_TIMEOUT."
        )
    # ConnectError wraps TLS failures as well as refused connections, so the
    # certificate check has to look at the message.
    lowered = text.lower()
    if any(k in lowered for k in ("certificate", "ssl", "tls", "self signed", "self-signed")):
        return TransportError(
            f"TLS verification failed for {base_url}: {text}\n"
            "This is what a corporate root CA looks like when the client does "
            f"not trust it. Point {env_prefix}_CA_BUNDLE (or MCP_CA_BUNDLE, "
            "which covers every server here) at your organisation's PEM "
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
