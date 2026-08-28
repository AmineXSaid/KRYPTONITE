"""Reading a text body, which is what a Jenkins console log is.

Everything else in this package reads JSON. ``/consoleText`` does not, and the
differences are not cosmetic:

* **It can be enormous.** A build that looped leaves hundreds of megabytes.
  Reading that into memory to hand a model the last hundred lines is how a tool
  call takes the server down, so the body is streamed and capped.
* **The useful part is at the END.** A stack trace is the last thing a failing
  build prints. A cap that keeps the first two megabytes of a two-hundred
  megabyte log is a cap that discards the answer, so ``tail=True`` keeps the
  other end.
* **Truncation has to be visible.** A truncated log that looks whole is worse
  than no log: the model reads it, sees no error, and reports that the build
  failed for no visible reason.
* **An HTML body is never a log.** It is an SSO portal, and the JSON path
  already knows that. The text path must not lose the check just because the
  content type it expects is not JSON.
"""

from __future__ import annotations

import httpx
import pytest

from readonly_client.config import ServiceConfig
from readonly_client.errors import NotFoundError, ServiceError
from readonly_client.http import DEFAULT_TEXT_LIMIT, ReadOnlyClient


def cfg(**over) -> ServiceConfig:
    base = dict(
        base_url="https://jenkins.test.internal",
        auth_mode="basic",
        username="builder",
        token="test-token-value-long-enough",
        product="Jenkins",
        base_url_var="JENKINS_BASE_URL",
        env_prefix="JENKINS",
    )
    base.update(over)
    return ServiceConfig(**base)  # type: ignore[arg-type]


def client_for(handler, **over) -> ReadOnlyClient:
    c = ReadOnlyClient(cfg(**over))
    c._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        base_url="https://jenkins.test.internal",
    )
    return c


def text_handler(body: bytes, *, status: int = 200, ctype: str = "text/plain"):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, content=body, headers={"content-type": ctype})

    return handler


class Chunked(httpx.AsyncByteStream):
    """A body delivered in many small pieces, as a real socket delivers one.

    ``httpx.ByteStream`` hands over the whole body in a single chunk, which
    means a test built on it never runs the loop that drops chunks off the
    front - the exact code a tail cap lives or dies by. ``read`` counts the
    chunks actually pulled, so a test can also assert the reader stopped early.
    """

    def __init__(self, data: bytes, size: int = 13) -> None:
        self.data, self.size, self.read = data, size, 0

    async def __aiter__(self):
        for i in range(0, len(self.data), self.size):
            self.read += 1
            yield self.data[i : i + self.size]


# ── the ordinary case ──────────────────────────────────────────────────────


async def test_a_small_log_comes_back_whole_and_unflagged() -> None:
    c = client_for(text_handler(b"Started by user\nFinished: SUCCESS\n"))
    out = await c.get_text("/job/build/12/consoleText")
    assert out.text == "Started by user\nFinished: SUCCESS\n"
    assert out.truncated is False
    assert out.byte_limit == DEFAULT_TEXT_LIMIT
    await c.aclose()


async def test_an_empty_log_is_empty_text_not_an_error() -> None:
    """A build that produced no output is a normal answer. Raising here would
    make an agent report a failure that did not happen."""
    c = client_for(text_handler(b""))
    out = await c.get_text("/job/build/12/consoleText")
    assert out.text == ""
    assert out.truncated is False
    await c.aclose()


# ── the cap, at both ends ──────────────────────────────────────────────────


async def test_head_truncation_keeps_the_start_and_says_so() -> None:
    c = client_for(text_handler(b"abcdefghijklmnopqrstuvwxyz"))
    out = await c.get_text("/job/build/12/consoleText", max_bytes=10)
    assert out.text == "abcdefghij"
    assert out.truncated is True
    assert out.byte_limit == 10
    await c.aclose()


async def test_tail_truncation_keeps_the_end_which_is_where_the_trace_is() -> None:
    c = client_for(text_handler(b"abcdefghijklmnopqrstuvwxyz"))
    out = await c.get_text("/job/build/12/consoleText", max_bytes=10, tail=True)
    assert out.text == "qrstuvwxyz"
    assert out.truncated is True
    await c.aclose()


async def test_tail_is_exact_across_chunk_boundaries() -> None:
    """The tail is assembled by dropping whole chunks off the front, so an
    off-by-one there silently returns the wrong slice of a real log.

    The caps below straddle the 13-byte chunk size deliberately: one chunk
    either side of it, and both ends of the body.
    """
    body = b"".join(f"line{n:03d}\n".encode() for n in range(500))  # 4000 bytes

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, stream=Chunked(body), headers={"content-type": "text/plain"}
        )

    c = client_for(handler)
    for limit in (7, 12, 13, 14, 26, 27, 100, 3999, 4000, 4001):
        out = await c.get_text("/x/consoleText", max_bytes=limit, tail=True)
        assert out.text.encode() == body[-limit:], limit
        assert out.truncated is (limit < len(body)), limit
    await c.aclose()


async def test_head_mode_stops_reading_once_it_has_enough() -> None:
    """Head mode does not need the rest of the log, so it must not pull it.

    Tail mode has no such option - Jenkins offers no range on /consoleText, so
    the whole body has to cross the wire - but even there RETENTION stays
    bounded, which is what the tail test above proves.
    """
    body = b"x" * 13_000
    streams: list[Chunked] = []

    def handler(request: httpx.Request) -> httpx.Response:
        stream = Chunked(body)
        streams.append(stream)
        return httpx.Response(
            200, stream=stream, headers={"content-type": "text/plain"}
        )

    c = client_for(handler)
    out = await c.get_text("/x/consoleText", max_bytes=100)
    assert out.truncated is True
    # 100 bytes at 13 bytes a chunk: 8 chunks reaches 104, which is the first
    # to exceed the cap. Anything near 1000 means it read the whole log.
    assert streams[0].read == 8, streams[0].read
    await c.aclose()


async def test_a_log_exactly_at_the_cap_is_not_flagged_truncated() -> None:
    """Off-by-one at the boundary would put a "log was cut" warning on every
    complete log of exactly that size."""
    c = client_for(text_handler(b"0123456789"))
    out = await c.get_text("/x/consoleText", max_bytes=10)
    assert out.text == "0123456789"
    assert out.truncated is False
    await c.aclose()


async def test_the_cap_bounds_what_is_read_not_just_what_is_returned() -> None:
    """Slicing after the fact would still have pulled the whole log into
    memory, which is the failure this is here to prevent."""
    huge = b"x" * (4 * 1024 * 1024)
    seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(1)
        return httpx.Response(
            200,
            stream=httpx.ByteStream(huge),
            headers={"content-type": "text/plain"},
        )

    c = client_for(handler)
    out = await c.get_text("/x/consoleText", max_bytes=1024)
    assert len(out.text) == 1024
    assert out.truncated is True
    assert seen == [1]
    await c.aclose()


# ── an HTML body is an SSO page, never a log ───────────────────────────────


async def test_html_by_content_type_is_named_as_a_login_page() -> None:
    c = client_for(
        text_handler(b"<html><body>Sign in</body></html>", ctype="text/html")
    )
    with pytest.raises(ServiceError) as exc:
        await c.get_text("/job/build/12/consoleText")
    msg = str(exc.value)
    assert "SSO" in msg
    # It has to name the variable, and the RIGHT one for this product.
    assert "JENKINS_TOKEN" in msg
    await c.aclose()


async def test_html_lying_about_its_content_type_is_still_caught() -> None:
    """A reverse proxy that serves its login page as text/plain is the case a
    content-type check alone misses, and it is not hypothetical."""
    c = client_for(
        text_handler(b"\n  <!DOCTYPE html>\n<html>...", ctype="text/plain")
    )
    with pytest.raises(ServiceError):
        await c.get_text("/job/build/12/consoleText")
    await c.aclose()


async def test_a_log_that_merely_mentions_html_is_not_mistaken_for_one() -> None:
    """Build logs quote HTML constantly. The check looks at the START of the
    body, so a log about HTML is still a log."""
    c = client_for(
        text_handler(b"[INFO] wrote report.html\n[INFO] <html> tag count: 4\n")
    )
    out = await c.get_text("/job/build/12/consoleText")
    assert "report.html" in out.text
    await c.aclose()


# ── errors on the streamed path classify the same as on the JSON path ──────


async def test_a_404_on_a_streamed_body_still_classifies() -> None:
    """The body has to be read before it can be classified, and a streamed
    response has not been read yet. Getting this wrong turns every 404 into an
    httpx internal error about an unread stream."""
    c = client_for(text_handler(b'{"message":"no such build"}', status=404,
                                ctype="application/json"))
    with pytest.raises(NotFoundError) as exc:
        await c.get_text("/job/build/999/consoleText")
    assert "does not exist" in str(exc.value)
    await c.aclose()


async def test_a_503_is_retried_on_the_text_path_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(503, content=b"busy",
                                  headers={"content-type": "text/plain"})
        return httpx.Response(200, content=b"done",
                              headers={"content-type": "text/plain"})

    monkeypatch.setattr(ReadOnlyClient, "_retry_delay", staticmethod(lambda *_: 0))
    c = client_for(handler)
    out = await c.get_text("/x/consoleText")
    assert out.text == "done"
    assert len(calls) == 3
    await c.aclose()
