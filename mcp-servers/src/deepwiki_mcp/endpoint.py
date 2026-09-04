"""One chat call, spoken in whichever wire format the endpoint profile declares.

This is the only place in the server that talks to a model. It exists so the
generator and the ask tool can say "send this system+user prompt, give me back
text" without either of them knowing whether the gateway on the other end
speaks OpenAI's ``/chat/completions`` or Anthropic's ``/messages``.

Two wire formats, because those are the two a Genesis profile declares. They
differ in three places that all have to be right together, and getting one
wrong produces a 400 that reads like a model problem:

    * where the system prompt goes - a `system` role message (openai) versus a
      top-level `system` field (anthropic);
    * the auth header - `Authorization: Bearer` (openai) versus `x-api-key`
      plus `anthropic-version` (anthropic);
    * where the answer is - `choices[0].message.content` (openai) versus
      `content[0].text` (anthropic).

The URL handling is deliberately forgiving. A gateway URL is whatever the
profile's `baseUrl` is, and that is sometimes a bare host, sometimes already
the full completions path. So a URL that already names the wire's endpoint is
used verbatim; a bare one has the wire's default path appended; and
DEEPWIKI_ENDPOINT_PATH overrides both when a gateway is non-standard.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from readonly_client.errors import ServiceError
from readonly_client.redaction import safe_exception_text

from .config import EndpointConfig

# The default path each wire hangs its chat endpoint at, appended to a base URL
# that does not already carry one.
_DEFAULT_PATH = {
    "openai": "/chat/completions",
    "anthropic": "/v1/messages",
}

# Markers that say "this URL is already the full endpoint, do not append".
_FULL_URL_MARKERS = ("/chat/completions", "/messages", "/completions", "/responses")


class EndpointError(ServiceError):
    """A model call failed. Carries a message built here, never a raw body."""


def _target_url(cfg: EndpointConfig) -> str:
    if cfg.path_override:
        sep = "" if cfg.path_override.startswith("/") else "/"
        return f"{cfg.url}{sep}{cfg.path_override}"
    if any(marker in cfg.url for marker in _FULL_URL_MARKERS):
        return cfg.url
    return f"{cfg.url}{_DEFAULT_PATH[cfg.wire]}"


def _headers(cfg: EndpointConfig) -> dict[str, str]:
    headers = {"content-type": "application/json", "accept": "application/json"}
    if cfg.wire == "anthropic":
        headers["anthropic-version"] = "2023-06-01"
        if cfg.api_key:
            headers["x-api-key"] = cfg.api_key
    else:  # openai
        if cfg.api_key:
            headers["authorization"] = f"Bearer {cfg.api_key}"
    return headers


def _body(cfg: EndpointConfig, system: str, user: str) -> dict[str, Any]:
    if cfg.wire == "anthropic":
        return {
            "model": cfg.model,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "max_tokens": cfg.max_output_tokens,
        }
    # openai
    return {
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": cfg.max_output_tokens,
        "temperature": 0.2,
    }


def _extract_text(cfg: EndpointConfig, data: Any) -> str:
    """Pull the assistant's text out of whichever envelope came back.

    A gateway that rewrites responses, or a model that returned only a tool
    call, can leave this empty; that is reported as an error naming the shape,
    not returned as an empty page that looks generated.
    """
    if not isinstance(data, dict):
        raise EndpointError(
            f"The endpoint returned {type(data).__name__}, not a JSON object. "
            "If a gateway sits in front of it, that is the first thing to check."
        )
    if cfg.wire == "anthropic":
        blocks = data.get("content")
        if isinstance(blocks, list):
            parts = [b.get("text", "") for b in blocks if isinstance(b, dict)]
            text = "".join(parts).strip()
            if text:
                return text
    else:
        choices = data.get("choices")
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message") if isinstance(choices[0], dict) else None
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
                # Some gateways return content as a list of parts.
                if isinstance(content, list):
                    parts = [
                        p.get("text", "")
                        for p in content
                        if isinstance(p, dict)
                    ]
                    text = "".join(parts).strip()
                    if text:
                        return text
    # An API-level error is more useful surfaced than a shape complaint.
    err = data.get("error")
    if isinstance(err, dict) and err.get("message"):
        raise EndpointError(f"The endpoint returned an error: {err['message']}")
    raise EndpointError(
        "The endpoint returned no text content. The model may have replied with "
        "only a tool call, or the response shape does not match the configured "
        f"wire format ({cfg.wire}). Check DEEPWIKI_ENDPOINT_WIRE."
    )


class Endpoint:
    """A reusable chat client over one endpoint profile."""

    def __init__(self, cfg: EndpointConfig) -> None:
        self._cfg = cfg
        self._url = _target_url(cfg)
        verify: Any = cfg.ca_bundle if cfg.ca_bundle else True
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(cfg.read_timeout, connect=cfg.connect_timeout),
            verify=verify,
            follow_redirects=True,
        )

    async def chat(self, system: str, user: str) -> str:
        """Send one system+user turn, return the assistant's text."""
        cfg = self._cfg
        try:
            resp = await self._client.post(
                self._url, headers=_headers(cfg), json=_body(cfg, system, user)
            )
        except httpx.HTTPError as exc:
            raise EndpointError(
                f"Could not reach the endpoint at {self._url}: "
                f"{safe_exception_text(exc)}. Check DEEPWIKI_ENDPOINT_URL, the "
                "network path to the gateway, and DEEPWIKI_CA_BUNDLE if the "
                "certificate is internally signed."
            ) from None

        if resp.status_code == 401:
            raise EndpointError(
                "The endpoint rejected the credential (401). Check "
                "DEEPWIKI_ENDPOINT_KEY; on an air-gapped local endpoint that "
                "needs no key, leave it unset rather than blank-but-present."
            )
        if resp.status_code == 404:
            raise EndpointError(
                f"The endpoint returned 404 for {self._url}. The base URL is "
                "probably a bare host missing the wire path, or the wrong wire "
                "path was appended. Set DEEPWIKI_ENDPOINT_PATH to the exact "
                "completions path this gateway serves."
            )
        if resp.status_code >= 400:
            # The status line only - a body can echo the request, including the
            # prompt, and this text goes into a model's context.
            raise EndpointError(
                f"The endpoint returned HTTP {resp.status_code}. If this "
                "persists, verify the model id and wire format against the "
                "Genesis profile this mirrors."
            )

        try:
            data = resp.json()
        except (json.JSONDecodeError, ValueError):
            raise EndpointError(
                "The endpoint returned a non-JSON body where a chat completion "
                "was expected. An HTML body here is usually an SSO login page - "
                "the gateway is not authenticating this server."
            ) from None

        return _extract_text(cfg, data)

    async def aclose(self) -> None:
        await self._client.aclose()
