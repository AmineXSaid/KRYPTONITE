"""Configuration for deepwiki-mcp, split into two halves that fail differently.

There are two jobs here, and they do not need the same things:

**Serving** an already-generated wiki needs only a workspace and a place the
wiki lives. It must work on an air-gapped box with no model endpoint at all -
reading docs someone else generated is the common case, and refusing to start
without an endpoint would break it for no reason.

**Generating** a wiki needs a model endpoint - a Genesis endpoint profile,
expressed here as environment variables so the server can reach the same
gateway the extension does. That configuration is validated lazily, the first
time a generate/ask tool actually needs it, and the error names the exact
variable that is missing.

So ``load_config`` (serving) is strict about the workspace and silent about the
endpoint; ``resolve_endpoint`` (generating) is where the endpoint variables are
demanded, and it raises :class:`ConfigError` naming the fix when they are not
there. Both share the estate-wide ``MCP_`` fallback the other servers use, so
``MCP_CA_BUNDLE`` set once still covers this server too.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from readonly_client.config import ConfigError, env_lookup
from readonly_client.redaction import register_secret

# Wire formats this server can speak to. They mirror the Genesis profile
# `format:` field - `raw` is not offered here because a sandboxed JS transform
# is an extension concern, not something an out-of-process Python server can
# run. A profile that needs `raw` shaping should expose an openai/anthropic
# compatible face to this server.
WireFormat = Literal["openai", "anthropic"]

WIRE_FORMATS: tuple[WireFormat, ...] = ("openai", "anthropic")

# Per-`kind` output-token seeds, matching the README's table. A reasoning
# endpoint is asked to think, so it gets headroom; the rest get the stock
# default. Overridable with DEEPWIKI_MAX_OUTPUT_TOKENS.
KIND_OUTPUT_TOKENS = {
    "reasoning": 8192,
    "chat": 4096,
    "coding": 4096,
    "multimodal": 4096,
    "completion": 4096,
}

DEFAULT_CONNECT_TIMEOUT = 10.0
# Generation is a long call - a page can take a minute on a slow gateway - so
# the read timeout is generous by default and separately tunable.
DEFAULT_READ_TIMEOUT = 120.0

# Indexing caps. A file over the byte cap is listed but its body is not fed to
# the model; a repo over the file cap is indexed to the cap and says so. Both
# exist so one vendored tree cannot blow the context budget or the wall clock.
DEFAULT_MAX_FILE_BYTES = 80_000
DEFAULT_MAX_INDEX_FILES = 6_000

# Directories never worth walking. Not configurable-away: a wiki OF node_modules
# is never what anyone means, and walking it is most of the wall-clock cost.
ALWAYS_IGNORE_DIRS = frozenset(
    {
        ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
        ".mypy_cache", ".pytest_cache", ".ruff_cache", "dist", "build", "out",
        ".next", ".nuxt", "target", ".gradle", ".idea", ".vscode-test",
        "coverage", ".turbo", "vendor", ".agent",
    }
)


@dataclass(frozen=True)
class EndpointConfig:
    """A resolved Genesis endpoint profile, enough to make one chat call.

    This is the Python-side shadow of a `.agent/endpoints/*.yaml` profile: the
    same base URL, key, wire format and model the extension would resolve, read
    from the environment so an out-of-process server can reach the same
    gateway. Secrets are registered with the redaction module the moment they
    are read, before they are used to build any header.
    """

    url: str
    wire: WireFormat
    model: str
    api_key: str | None
    kind: str
    max_output_tokens: int
    connect_timeout: float
    read_timeout: float
    ca_bundle: str | None
    # An explicit path override, when the base URL is a bare host and the
    # gateway does not sit at the wire's default path.
    path_override: str | None = None


@dataclass(frozen=True)
class DeepWikiConfig:
    """What the serving half needs: where the code is, where the wiki lives."""

    workspace: Path
    wiki_dir: Path
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES
    max_index_files: int = DEFAULT_MAX_INDEX_FILES

    @property
    def pages_dir(self) -> Path:
        return self.wiki_dir / "pages"

    @property
    def manifest_path(self) -> Path:
        return self.wiki_dir / "wiki.json"


def _resolve_int(name: str, default: int, *, minimum: int = 1) -> int:
    raw, var = env_lookup("DEEPWIKI", name)
    if not raw:
        return default
    try:
        n = int(raw)
    except ValueError:
        raise ConfigError(f"{var} must be an integer, got {raw!r}.") from None
    if n < minimum:
        raise ConfigError(f"{var} must be at least {minimum}, got {n}.")
    return n


def _resolve_timeout(name: str, default: float) -> float:
    raw, var = env_lookup("DEEPWIKI", name)
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ConfigError(f"{var} must be a number of seconds, got {raw!r}.") from None
    if v <= 0:
        raise ConfigError(f"{var} must be greater than zero, got {v}.")
    return v


def _resolve_ca_bundle() -> str | None:
    raw, var = env_lookup("DEEPWIKI", "CA_BUNDLE")
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_file():
        raise ConfigError(
            f"{var} points at {p}, which is not a readable file. "
            "It must be a PEM bundle containing your corporate root CA."
        )
    return str(p)


def load_config() -> DeepWikiConfig:
    """Read the serving configuration. Endpoint variables are NOT required here.

    ``DEEPWIKI_WORKSPACE`` defaults to the current working directory, which is
    what an MCP client launched with ``cwd`` set to the repo will pass. The
    wiki lives under ``<workspace>/.agent/wiki`` by default - beside the
    endpoint profiles, in the repo, versioned and diffable - and
    ``DEEPWIKI_WIKI_DIR`` moves it only if a team wants it elsewhere.
    """
    raw_ws, ws_var = env_lookup("DEEPWIKI", "WORKSPACE")
    workspace = Path(raw_ws).expanduser().resolve() if raw_ws else Path.cwd().resolve()
    if not workspace.is_dir():
        raise ConfigError(
            f"{ws_var} points at {workspace}, which is not a directory. "
            "Set it to the root of the repository to document, or launch the "
            "server with its working directory set there."
        )

    raw_wiki, _ = env_lookup("DEEPWIKI", "WIKI_DIR")
    if raw_wiki:
        wiki_dir = Path(raw_wiki).expanduser()
        if not wiki_dir.is_absolute():
            wiki_dir = (workspace / wiki_dir).resolve()
    else:
        wiki_dir = workspace / ".agent" / "wiki"

    return DeepWikiConfig(
        workspace=workspace,
        wiki_dir=wiki_dir,
        max_file_bytes=_resolve_int("MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES),
        max_index_files=_resolve_int("MAX_INDEX_FILES", DEFAULT_MAX_INDEX_FILES),
    )


def resolve_endpoint() -> EndpointConfig:
    """Demand and validate the endpoint variables. Raises naming the fix.

    Called only when a tool actually needs to reach the model, so that the
    read-only surface of this server works with no endpoint configured at all.
    """
    url, url_var = env_lookup("DEEPWIKI", "ENDPOINT_URL")
    if not url:
        raise ConfigError(
            f"{url_var} is not set. Generating or asking the wiki needs a model "
            "endpoint - the same one a Genesis profile points at. Set it to the "
            "chat URL of your gateway, e.g. https://gateway.company.internal/v1 "
            "(the wire-specific path is appended for you) or the full completions "
            "URL if your gateway is non-standard."
        )
    url = url.rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise ConfigError(f"{url_var} must start with http:// or https://, got {url!r}.")

    raw_wire, wire_var = env_lookup("DEEPWIKI", "ENDPOINT_WIRE")
    wire = (raw_wire or "openai").lower()
    if wire not in WIRE_FORMATS:
        raise ConfigError(
            f"{wire_var} must be one of {', '.join(WIRE_FORMATS)}, got {raw_wire!r}. "
            "Use the wire format your Genesis profile declares."
        )

    model, model_var = env_lookup("DEEPWIKI", "MODEL")
    if not model:
        raise ConfigError(
            f"{model_var} is not set. A gateway's model id is opaque, so it must "
            "be given rather than guessed - copy the `model:` from your profile."
        )

    key, _ = env_lookup("DEEPWIKI", "ENDPOINT_KEY")
    api_key = key or None
    # An air-gapped local server may genuinely need no key; a blank one is kept
    # as None so no empty Authorization header is sent. When present it is a
    # secret from this line on.
    if api_key:
        register_secret(api_key)

    raw_kind, _ = env_lookup("DEEPWIKI", "ENDPOINT_KIND")
    kind = (raw_kind or "reasoning").lower()
    # `kind` seeds the token budget the way the profile's does; an unknown kind
    # falls back to the chat seed rather than refusing, because it is only a
    # seed and DEEPWIKI_MAX_OUTPUT_TOKENS can override it outright.
    seed = KIND_OUTPUT_TOKENS.get(kind, KIND_OUTPUT_TOKENS["chat"])
    max_out = _resolve_int("MAX_OUTPUT_TOKENS", seed, minimum=256)

    path_override, _ = env_lookup("DEEPWIKI", "ENDPOINT_PATH")

    return EndpointConfig(
        url=url,
        wire=wire,  # type: ignore[arg-type]
        model=model,
        api_key=api_key,
        kind=kind,
        max_output_tokens=max_out,
        connect_timeout=_resolve_timeout("CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT),
        read_timeout=_resolve_timeout("READ_TIMEOUT", DEFAULT_READ_TIMEOUT),
        ca_bundle=_resolve_ca_bundle(),
        path_override=path_override or None,
    )
