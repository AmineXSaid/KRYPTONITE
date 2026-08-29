"""Fetching the picture, not the word "image".

A Confluence page body reaches a model as `[image: topology.png]` and a Jira
bug report's evidence is a screenshot nobody can see. These servers could name
attachments and could not fetch them, which made every visual answer a guess.

What is pinned here is the part that is easy to get wrong and impossible to
notice:

* **A download must never be truncated.** A capped console log is still the
  answer to "why did the build fail" - its tail has the stack trace. The first
  three megabytes of a four-megabyte PNG is not a picture, it is a decode error
  at the model's end that cost a full transfer. So the binary path refuses
  where the text path truncates, and the two are deliberately asymmetric.

* **A redirect must not carry the credential off the instance.** The token is
  a client-wide header, so httpx would present it to whatever host a Location
  names, and nothing about a 302 is authenticated. Attachment downloads are the
  ONLY path here that redirects at all, which is why this is the only file that
  can catch it.

* **The instance says where the bytes are; we do not guess.** Both products put
  a download location in the metadata, and following it is what survives a
  context path, a reverse proxy and a version that moved the route. None of
  those survive a hardcoded template - and `developer.atlassian.com` is blocked
  from the build environment, so a template here would be a guess dressed as a
  constant.
"""

from __future__ import annotations

import httpx
import pytest

from readonly_client.attachments import (
    VIEWABLE_IMAGE_TYPES,
    fetch_attachment,
    is_viewable_image,
    pick_attachment,
    shape_attachment,
)
from readonly_client.config import ServiceConfig
from readonly_client.errors import ServiceError
from readonly_client.http import DEFAULT_BINARY_LIMIT, MAX_DOWNLOAD_REDIRECTS, ReadOnlyClient
from readonly_client.paths.atlassian import download_url_for
from confluence_mcp.shaping import shape_confluence_attachment
from jira_mcp.shaping import shape_jira_attachment

BASE = "https://wiki.test.internal"

# A real PNG header, so a content-type sniff or a decode is testing something.
PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 40


def cfg(**over) -> ServiceConfig:
    base = dict(
        base_url=BASE,
        auth_mode="bearer",
        username=None,
        token="test-token-value-long-enough",
        product="Confluence",
        base_url_var="CONFLUENCE_BASE_URL",
        env_prefix="ATLASSIAN",
    )
    base.update(over)
    return ServiceConfig(**base)  # type: ignore[arg-type]


def client_for(handler, **over) -> ReadOnlyClient:
    c = ReadOnlyClient(cfg(**over))
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url=over.get("base_url", BASE),
        headers={"Authorization": "Bearer test-token-value-long-enough"},
    )
    return c


# ── where the bytes are ─────────────────────────────────────────────────────


def test_a_confluence_download_link_is_a_path_already() -> None:
    """`_links.download` is relative to the instance root and already carries
    the version query. Rebuilding it loses the query and the page shows an old
    revision of the diagram."""
    link = "/download/attachments/123/topology.png?version=2&api=v2"
    assert download_url_for(link, BASE) == link


def test_a_context_path_in_the_link_survives() -> None:
    """A DC instance behind /confluence serves attachments under it too. This
    is the case a hardcoded template cannot get right, because the base URL
    already carries the context path and the template would double it."""
    assert (
        download_url_for(f"{BASE}/confluence/download/attachments/1/t.png", BASE)
        == "/confluence/download/attachments/1/t.png"
    )


def test_jiras_absolute_content_url_is_reduced_to_a_path() -> None:
    assert (
        download_url_for(f"{BASE}/secure/attachment/10000/shot.png", BASE)
        == "/secure/attachment/10000/shot.png"
    )


def test_the_default_port_is_the_same_origin_as_no_port() -> None:
    assert download_url_for("https://wiki.test.internal:443/secure/attachment/1/a.png", BASE)


def test_a_link_to_another_host_is_refused_rather_than_reduced() -> None:
    """Reducing it to a path would quietly request that path from the CONFIGURED
    instance - a 404 about the wrong file. None is the true answer."""
    assert download_url_for("https://elsewhere.example.com/secure/attachment/1/a.png", BASE) is None


def test_a_missing_link_is_none_not_an_empty_path() -> None:
    assert download_url_for(None, BASE) is None
    assert download_url_for("", BASE) is None
    assert download_url_for("   ", BASE) is None


# ── the projection ──────────────────────────────────────────────────────────


def test_confluence_data_center_field_names() -> None:
    raw = {
        "id": "att99",
        "title": "topology.png",
        "extensions": {"mediaType": "image/png", "fileSize": 40_000},
        "_links": {"download": "/download/attachments/1/topology.png?version=2",
                   "webui": "/display/ENG/Runbook"},
        "version": {"when": "2026-02-01T10:00:00Z", "by": {"displayName": "Ada"}},
    }
    out = shape_confluence_attachment(raw, base_url=BASE)
    assert out["filename"] == "topology.png"
    assert out["media_type"] == "image/png"
    assert out["size"] == 40_000
    assert out["viewable"] is True
    assert out["downloadable"] is True
    assert out["author"] == "Ada"
    assert out["url"] == f"{BASE}/display/ENG/Runbook"


def test_confluence_cloud_puts_the_media_type_somewhere_else() -> None:
    """DC uses extensions.mediaType, Cloud uses metadata.mediaType. Reading only
    one gives a user on the other deployment a list of nulls that looks like an
    empty page rather than a wrong root."""
    out = shape_confluence_attachment(
        {"id": "1", "title": "a.png", "metadata": {"mediaType": "image/png"}}, base_url=BASE
    )
    assert out["media_type"] == "image/png"
    assert out["viewable"] is True


def test_a_jira_attachment_reads_its_own_field_names() -> None:
    out = shape_jira_attachment(
        {
            "id": 10000,
            "filename": "stacktrace.png",
            "mimeType": "image/png",
            "size": 1234,
            "content": f"{BASE}/secure/attachment/10000/stacktrace.png",
            "created": "2026-02-01T10:00:00Z",
            "author": {"displayName": "Ada"},
        },
        base_url=BASE,
    )
    assert out["id"] == "10000"  # stringified: Jira sends an int, Confluence a str
    assert out["filename"] == "stacktrace.png"
    assert out["downloadable"] is True
    assert out["author"] == "Ada"


def test_the_download_path_never_reaches_the_model() -> None:
    """It is plumbing. A path in the summary invites a model to ask for an
    arbitrary one, and there is no tool that would take it."""
    out = shape_confluence_attachment(
        {"id": "1", "title": "a.png", "extensions": {"mediaType": "image/png"},
         "_links": {"download": "/download/attachments/1/a.png"}},
        base_url=BASE,
    )
    assert out["_download_path"] == "/download/attachments/1/a.png"
    public = {k: v for k, v in out.items() if not k.startswith("_")}
    assert not any("download/attachments" in str(v) for v in public.values())


def test_only_what_a_model_wire_accepts_is_viewable() -> None:
    """These four are what the endpoint takes inline. Fetching a TIFF to have it
    dropped one hop later spends the request and answers nothing."""
    assert VIEWABLE_IMAGE_TYPES == {"image/png", "image/jpeg", "image/gif", "image/webp"}
    assert is_viewable_image("image/png")
    assert is_viewable_image("IMAGE/PNG")
    assert is_viewable_image("image/png; charset=binary")
    assert not is_viewable_image("image/svg+xml")
    assert not is_viewable_image("application/pdf")
    assert not is_viewable_image(None)


# ── finding the one that was asked for ──────────────────────────────────────


def att(name: str, **over):
    base = dict(filename=name, media_type="image/png", viewable=True, _download_path="/d/" + name)
    base.update(over)
    return base


def test_an_exact_name_wins() -> None:
    items = [att("topology.png"), att("topology-v2.png")]
    assert pick_attachment(items, "topology.png", where="page 1")["filename"] == "topology.png"


def test_the_wrong_case_still_finds_it() -> None:
    """A model reads the name out of page text, where it may be title-cased. A
    404 for a capital letter teaches it nothing."""
    items = [att("Topology.PNG")]
    assert pick_attachment(items, "topology.png", where="page 1")["filename"] == "Topology.PNG"


def test_a_unique_substring_is_enough() -> None:
    items = [att("2026-topology-final.png"), att("notes.pdf", viewable=False)]
    assert "topology" in pick_attachment(items, "topology", where="page 1")["filename"]


def test_an_ambiguous_substring_is_refused_rather_than_guessed() -> None:
    """Returning whichever came first hands the model the wrong picture, and a
    wrong picture is answered from confidently. The names are listed instead."""
    items = [att("topology-a.png"), att("topology-b.png")]
    with pytest.raises(ServiceError) as exc:
        pick_attachment(items, "topology", where="page 1")
    assert "topology-a.png" in str(exc.value) and "topology-b.png" in str(exc.value)


def test_a_miss_lists_what_is_actually_there() -> None:
    """The one answer that lets the next call succeed."""
    items = [att("topology.png"), att("rack.png")]
    with pytest.raises(ServiceError) as exc:
        pick_attachment(items, "diagram.png", where="page 42")
    assert "topology.png" in str(exc.value) and "rack.png" in str(exc.value)


def test_an_empty_page_says_so_rather_than_listing_nothing() -> None:
    with pytest.raises(ServiceError) as exc:
        pick_attachment([], "any.png", where="page 42")
    assert "no attachments at all" in str(exc.value)


def test_duplicate_names_resolve_to_the_newest() -> None:
    """Both products allow it - a re-upload, or the same file on two comments -
    and both order oldest first. A caller naming a file means the current one."""
    items = [att("shot.png", size=1), att("shot.png", size=2)]
    assert pick_attachment(items, "shot.png", where="issue X")["size"] == 2


# ── the download itself ─────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_bytes_come_back_whole() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    c = client_for(handler)
    got = await c.get_bytes("/download/attachments/1/t.png")
    assert got.content == PNG
    assert got.content_type == "image/png"
    # Every other request advertises application/json, which is what makes
    # Atlassian answer with JSON. A download endpoint asked for JSON can 406.
    assert seen[0].headers["accept"] == "*/*"
    await c.aclose()


@pytest.mark.anyio
async def test_a_declared_oversize_costs_one_round_trip_not_a_transfer() -> None:
    """Content-Length is consulted before the body is read, so a 40 MB
    attachment is refused without downloading 40 MB."""
    pulled = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        pulled["n"] += 1
        return httpx.Response(
            200,
            content=b"x" * 32,
            headers={"content-type": "image/png",
                     "content-length": str(DEFAULT_BINARY_LIMIT + 1)},
        )

    c = client_for(handler)
    with pytest.raises(ServiceError) as exc:
        await c.get_bytes("/download/attachments/1/huge.png")
    assert "not downloaded" in str(exc.value)
    assert str(DEFAULT_BINARY_LIMIT) in str(exc.value).replace(",", "")
    await c.aclose()


class Chunked(httpx.AsyncByteStream):
    """A body delivered in pieces and with no length, as a chunked transfer is.

    ``httpx.Response(content=...)`` sets Content-Length, which means a test
    built on it only ever exercises the cheap pre-flight check. The branch that
    matters more - a server that streams without saying how much - needs a body
    that genuinely has no length. ``pulled`` counts the chunks actually read, so
    a test can also assert the reader gave up early instead of draining it.
    """

    def __init__(self, data: bytes, size: int = 64) -> None:
        self._parts = [data[i : i + size] for i in range(0, len(data), size)]
        self.pulled = 0

    async def __aiter__(self):
        for part in self._parts:
            self.pulled += 1
            yield part


@pytest.mark.anyio
async def test_an_undeclared_oversize_is_refused_mid_stream_never_truncated() -> None:
    """The asymmetry with get_text, stated as a test: a truncated log is still
    an answer, a truncated PNG is a decode error that cost a full transfer."""
    stream = Chunked(b"y" * 4096)

    def handler(request: httpx.Request) -> httpx.Response:
        # No content-length, so the cap has to be enforced while reading.
        return httpx.Response(200, stream=stream, headers={"content-type": "image/png"})

    c = client_for(handler)
    with pytest.raises(ServiceError) as exc:
        await c.get_bytes("/download/attachments/1/big.png", max_bytes=100)
    assert "abandoned" in str(exc.value)
    assert "Half a file is not a file" in str(exc.value)
    # And it stopped rather than draining 4 KB to discard it. Sixty-four-byte
    # chunks, a 100-byte cap: three reads is enough to know, 64 is a download.
    assert stream.pulled <= 4, stream.pulled
    await c.aclose()


@pytest.mark.anyio
async def test_the_binary_limit_is_the_clients_image_cap_exactly() -> None:
    """3,750,000 bytes is 5,000,000 characters of base64, which is the per-image
    cap the extension enforces at the other end. A byte over and the picture is
    fetched, encoded, sent and then dropped - all the cost, none of the use."""
    assert (DEFAULT_BINARY_LIMIT + 2) // 3 * 4 == 5_000_000


@pytest.mark.anyio
async def test_a_same_host_redirect_is_followed() -> None:
    """Data Center 302s an attachment URL to /download/... constantly. Not
    following it means the tool never works at all."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/secure"):
            return httpx.Response(302, headers={"location": "/download/attachments/1/t.png"})
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    c = client_for(handler)
    got = await c.get_bytes("/secure/attachment/1/t.png")
    assert got.content == PNG
    await c.aclose()


@pytest.mark.anyio
async def test_a_redirect_off_the_instance_is_refused_before_the_token_travels() -> None:
    """The credential is a client-wide header, so httpx would present it to
    whatever host the Location names, and nothing about a 302 is authenticated.
    This is the only path in the package that redirects, so it is the only place
    this can be caught."""
    hosts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        if request.url.path.startswith("/secure"):
            return httpx.Response(
                302, headers={"location": "https://evil.example.com/steal/t.png"}
            )
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    c = client_for(handler)
    with pytest.raises(ServiceError) as exc:
        await c.get_bytes("/secure/attachment/1/t.png")
    assert "evil.example.com" in str(exc.value)
    assert "another host" in str(exc.value)
    assert "evil.example.com" not in hosts, "the request was made anyway"
    await c.aclose()


@pytest.mark.anyio
async def test_a_redirect_loop_stops_rather_than_spinning() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/round/again"})

    c = client_for(handler)
    with pytest.raises(ServiceError) as exc:
        await c.get_bytes("/round/again")
    assert str(MAX_DOWNLOAD_REDIRECTS) in str(exc.value)
    await c.aclose()


@pytest.mark.anyio
async def test_an_sso_login_page_is_not_an_image() -> None:
    """The JSON path already knows an HTML body is a portal. The binary path
    must not lose the check just because it expects bytes: a login page saved
    as a .png would reach the model as a corrupt image."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"<!DOCTYPE html><html><body>Sign in</body></html>",
            headers={"content-type": "text/html"},
        )

    c = client_for(handler)
    with pytest.raises(ServiceError) as exc:
        await c.get_bytes("/download/attachments/1/t.png")
    assert "login page" in str(exc.value)
    await c.aclose()


@pytest.mark.anyio
async def test_a_404_is_still_a_404() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "no such attachment"})

    c = client_for(handler)
    with pytest.raises(ServiceError):
        await c.get_bytes("/download/attachments/1/gone.png")
    await c.aclose()


@pytest.mark.anyio
async def test_the_read_only_guard_still_applies() -> None:
    """A new transport is a new way to forget the guard."""
    c = client_for(lambda r: httpx.Response(200, content=PNG))
    with pytest.raises(ServiceError):
        await c.request("PUT", "/download/attachments/1/t.png")
    await c.aclose()


# ── the whole fetch, as a tool returns it ───────────────────────────────────


@pytest.mark.anyio
async def test_a_fetch_returns_a_summary_and_a_picture() -> None:
    """Pixels alone would give the model nothing to cite: no filename, no page,
    no size. The summary is not decoration."""
    c = client_for(lambda r: httpx.Response(200, content=PNG, headers={"content-type": "image/png"}))
    out = await fetch_attachment(
        shape_attachment(
            attachment_id="1", filename="topology.png", media_type="image/png",
            size=48, download_path="/download/attachments/1/topology.png",
        ),
        c,
    )
    assert len(out) == 2
    summary, image = out
    assert summary["filename"] == "topology.png"
    assert summary["bytes"] == len(PNG)
    assert summary["served_as"] == "image/png"
    assert "_download_path" not in summary
    block = image.to_image_content()
    assert block.type == "image"
    # image/png, not image/image/png: the SDK helper takes a FORMAT and builds
    # the media type itself, so passing one through doubles the prefix and the
    # block becomes unreadable. The field is `mime_type` in SDK 2.x and
    # `mimeType` in 1.x, and mcp_compat supports both, so the test does too.
    served = getattr(block, "mime_type", None) or getattr(block, "mimeType", None)
    assert served == "image/png"
    await c.aclose()


@pytest.mark.anyio
async def test_a_pdf_is_refused_before_the_request_not_after() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, content=b"%PDF-1.7")

    c = client_for(handler)
    with pytest.raises(ServiceError) as exc:
        await fetch_attachment(
            shape_attachment(
                attachment_id="1", filename="runbook.pdf", media_type="application/pdf",
                size=10, download_path="/download/attachments/1/runbook.pdf",
            ),
            c,
        )
    assert "cannot be shown to a model" in str(exc.value)
    assert calls["n"] == 0, "the download was made anyway"
    await c.aclose()


@pytest.mark.anyio
async def test_a_lie_in_the_metadata_is_caught_by_what_was_served() -> None:
    """The media type in the payload is what someone typed when they uploaded.
    The response header is what the bytes are, and it is the header the model's
    endpoint has to decode."""
    c = client_for(
        lambda r: httpx.Response(200, content=b"<svg/>", headers={"content-type": "image/svg+xml"})
    )
    with pytest.raises(ServiceError) as exc:
        await fetch_attachment(
            shape_attachment(
                attachment_id="1", filename="diagram.png", media_type="image/png",
                size=6, download_path="/download/attachments/1/diagram.png",
            ),
            c,
        )
    assert "served it as image/svg+xml" in str(exc.value)
    await c.aclose()


@pytest.mark.anyio
async def test_an_attachment_with_no_download_location_points_at_the_probe() -> None:
    """Not a retryable failure: the deployment is shaped differently from what
    these paths assume, and only probe.py will say how."""
    c = client_for(lambda r: httpx.Response(200, content=PNG))
    with pytest.raises(ServiceError) as exc:
        await fetch_attachment(
            shape_attachment(
                attachment_id="1", filename="a.png", media_type="image/png",
                size=1, download_path=None,
            ),
            c,
        )
    assert "probe.py" in str(exc.value)
    await c.aclose()


# ── through the server, which is the only place the annotation is read ──────
#
# The SDK decides "content blocks" vs "structured data" from a tool's RETURN
# ANNOTATION, not from what it returned. Annotated `-> list[Any]` these tools
# took the structured path and raised `Unable to serialize unknown type: Image`
# at call time - after the download was paid for, and invisible to every test
# that calls the function directly, because the function's return value is
# correct either way. So these go through `mcp.call_tool`.


def wire_server(module, cfg_kwargs, handler):
    """Point a server module's module-level client at a mock transport."""
    conf = cfg(**cfg_kwargs)
    c = ReadOnlyClient(conf)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url=conf.base_url)
    module._config = conf
    module._client = c
    return c


def blocks_of(res):
    """The content blocks, whichever shape this SDK major returns them in."""
    return list(getattr(res, "content", res) or [])


@pytest.mark.anyio
async def test_confluence_get_attachment_renders_an_image_block() -> None:
    import confluence_mcp.server as srv

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/child/attachment"):
            return httpx.Response(200, json={"results": [{
                "id": "att1", "title": "topology.png",
                "extensions": {"mediaType": "image/png", "fileSize": 48},
                "_links": {"download": "/download/attachments/1/topology.png?version=2",
                           "webui": "/display/ENG/Runbook"}}]})
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    c = wire_server(srv, {"product": "Confluence"}, handler)
    res = await srv.mcp.call_tool(
        "confluence_get_attachment", {"page_id": "1", "filename": "topology.png"}
    )
    kinds = [b.type for b in blocks_of(res)]
    assert kinds == ["text", "image"], kinds
    image = blocks_of(res)[1]
    import base64

    assert base64.b64decode(image.data) == PNG
    assert "topology.png" in blocks_of(res)[0].text
    await c.aclose()


@pytest.mark.anyio
async def test_jira_get_attachment_renders_an_image_block() -> None:
    import jira_mcp.server as srv

    def handler(request: httpx.Request) -> httpx.Response:
        if "/rest/api/2/issue/" in request.url.path:
            return httpx.Response(200, json={"fields": {"attachment": [{
                "id": 10000, "filename": "stacktrace.png", "mimeType": "image/png",
                "size": 48, "content": f"{BASE}/secure/attachment/10000/stacktrace.png"}]}})
        return httpx.Response(200, content=PNG, headers={"content-type": "image/png"})

    c = wire_server(srv, {"product": "Jira", "base_url_var": "JIRA_BASE_URL"}, handler)
    res = await srv.mcp.call_tool(
        "jira_get_attachment", {"issue_key": "PLATFORM-1423", "filename": "stacktrace.png"}
    )
    kinds = [b.type for b in blocks_of(res)]
    assert kinds == ["text", "image"], kinds
    await c.aclose()


@pytest.mark.anyio
async def test_listing_attachments_is_still_plain_data() -> None:
    """The list tool returns a dict and must keep the structured path - only the
    fetching tools opt out of it."""
    import confluence_mcp.server as srv

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [
            {"id": "1", "title": "topology.png", "extensions": {"mediaType": "image/png"},
             "_links": {"download": "/d/1"}},
            {"id": "2", "title": "runbook.pdf", "extensions": {"mediaType": "application/pdf"},
             "_links": {"download": "/d/2"}},
        ]})

    c = wire_server(srv, {"product": "Confluence"}, handler)
    res = await srv.mcp.call_tool("confluence_list_attachments", {"page_id": "1"})
    text = "".join(b.text for b in blocks_of(res) if b.type == "text")
    assert "topology.png" in text and "runbook.pdf" in text
    # The count that tells a model which one it can ask for.
    assert '"viewable": 1' in text or '"viewable":1' in text, text
    await c.aclose()


# ── the sentence that turns a dead end into a call ──────────────────────────


def test_a_page_with_images_says_how_to_see_them() -> None:
    """`[image: topology.png]` is a filename, and a model that reads it with no
    idea a tool exists describes a diagram it never saw. The pointer is what
    makes the marker actionable, and it appears once per page rather than once
    per image."""
    from confluence_mcp.shaping import shape_page

    storage = (
        '<p>Before:</p><ac:image><ri:attachment ri:filename="a.png"/></ac:image>'
        '<p>After:</p><ac:image><ri:attachment ri:filename="b.png"/></ac:image>'
    )
    out = shape_page(
        {"id": "1", "title": "R", "body": {"storage": {"value": storage}}},
        base_url=BASE,
        include_body=True,
    )
    assert "[image: a.png]" in out["body"] and "[image: b.png]" in out["body"]
    note = out["body_note"]
    assert "confluence_get_attachment" in note
    assert "2 image(s)" in note
    assert note.count("confluence_get_attachment") == 1, "said once, not once per image"


def test_a_page_with_no_images_is_not_told_about_attachments() -> None:
    """Noise on every text page, for a tool that would answer 'none'."""
    from confluence_mcp.shaping import shape_page

    out = shape_page(
        {"id": "1", "title": "R", "body": {"storage": {"value": "<p>Just prose.</p>"}}},
        base_url=BASE,
        include_body=True,
    )
    assert "confluence_get_attachment" not in out["body_note"]
