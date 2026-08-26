"""Result trimming. The assertions are mostly about what is NOT in the output.

A raw Jira issue is 40-80 KB, nearly all of it avatar URLs and null custom
fields. The tests below use a payload shaped like the real thing and assert the
noise is gone, because "we return fewer keys" is easy to regress into "we
return fewer keys plus a nested object that carries all of them again".
"""

from __future__ import annotations

from confluence_mcp.shaping import shape_page, shape_result
from confluence_mcp.shaping import shape_search as shape_conf_search
from jira_mcp.shaping import shape_field, shape_issue, shape_project, shape_search

BASE = "https://jira.test.internal"
CBASE = "https://confluence.test.internal"

AVATARS = {
    "48x48": f"{BASE}/secure/useravatar?size=48&ownerId=jdoe",
    "24x24": f"{BASE}/secure/useravatar?size=24&ownerId=jdoe",
    "16x16": f"{BASE}/secure/useravatar?size=16&ownerId=jdoe",
    "32x32": f"{BASE}/secure/useravatar?size=32&ownerId=jdoe",
}

RAW_ISSUE = {
    "expand": "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
    "id": "10042",
    "self": f"{BASE}/rest/api/2/issue/10042",
    "key": "PLATFORM-1423",
    "fields": {
        "summary": "Gateway drops streaming responses over HTTP/2",
        "status": {
            "self": f"{BASE}/rest/api/2/status/3",
            "iconUrl": f"{BASE}/images/icons/statuses/inprogress.png",
            "name": "In Progress",
            "id": "3",
            "statusCategory": {"id": 4, "key": "indeterminate", "name": "In Progress"},
        },
        "issuetype": {
            "self": f"{BASE}/rest/api/2/issuetype/1",
            "id": "1",
            "iconUrl": f"{BASE}/secure/viewavatar?avatarId=10303",
            "name": "Bug",
            "subtask": False,
        },
        "assignee": {
            "self": f"{BASE}/rest/api/2/user?username=jdoe",
            "name": "jdoe",
            "key": "jdoe",
            "emailAddress": "jdoe@corp.example",
            "avatarUrls": AVATARS,
            "displayName": "Jane Doe",
            "active": True,
        },
        "reporter": {
            "name": "rsmith",
            "displayName": "Rob Smith",
            "avatarUrls": AVATARS,
            "emailAddress": "rsmith@corp.example",
        },
        "priority": {"self": f"{BASE}/rest/api/2/priority/2", "iconUrl": "x", "name": "High", "id": "2"},
        "updated": "2026-08-20T11:04:33.000+0000",
        "labels": ["networking", "http2"],
        "customfield_10101": {"self": "x", "value": "Platform", "id": "10201"},
        "customfield_10102": None,
        "description": "Long body text that nobody asked for.",
    },
}


# ── Jira issue projection ──────────────────────────────────────────────────


def test_issue_projection_is_exactly_the_specified_shape() -> None:
    out = shape_issue(RAW_ISSUE, base_url=BASE)
    assert set(out) == {
        "key", "summary", "status", "issue_type", "assignee",
        "reporter", "priority", "updated", "url",
    }


def test_issue_values_are_flattened_to_strings() -> None:
    out = shape_issue(RAW_ISSUE, base_url=BASE)
    assert out["key"] == "PLATFORM-1423"
    assert out["status"] == "In Progress"
    assert out["issue_type"] == "Bug"
    assert out["assignee"] == "Jane Doe"
    assert out["reporter"] == "Rob Smith"
    assert out["priority"] == "High"


def test_url_is_the_browse_url_not_the_rest_url() -> None:
    """`self` is /rest/api/2/issue/10042, which is no use to a person."""
    out = shape_issue(RAW_ISSUE, base_url=BASE)
    assert out["url"] == f"{BASE}/browse/PLATFORM-1423"
    assert "/rest/" not in out["url"]


def test_avatar_and_link_noise_is_gone() -> None:
    """The whole point of the projection."""
    blob = repr(shape_issue(RAW_ISSUE, base_url=BASE))
    assert "avatarUrls" not in blob
    assert "useravatar" not in blob
    assert "iconUrl" not in blob
    assert "expand" not in blob
    assert "self" not in blob


def test_unrequested_fields_are_dropped() -> None:
    out = shape_issue(RAW_ISSUE, base_url=BASE)
    assert "description" not in repr(out)
    assert "customfield_10101" not in repr(out)


def test_requested_extra_fields_are_nested_not_merged() -> None:
    """Nested so a custom field named `status` cannot shadow the real one."""
    out = shape_issue(RAW_ISSUE, base_url=BASE, extra_fields=("labels", "customfield_10101"))
    assert out["fields"]["labels"] == ["networking", "http2"]
    assert out["status"] == "In Progress"  # not overwritten
    # Noise is stripped from extras too.
    assert "self" not in repr(out["fields"]["customfield_10101"])
    assert out["fields"]["customfield_10101"]["value"] == "Platform"


def test_unassigned_is_none_not_the_string_none() -> None:
    """A model reports the string "None" as an assignee. Actual None it omits."""
    raw = {"key": "X-1", "fields": {"assignee": None, "summary": "s"}}
    assert shape_issue(raw, base_url=BASE)["assignee"] is None


# ── pagination facts ───────────────────────────────────────────────────────


def test_search_reports_total_and_more() -> None:
    """Without these a model summarises page one as the whole answer."""
    raw = {"startAt": 0, "maxResults": 25, "total": 431, "issues": [RAW_ISSUE] * 25}
    out = shape_search(raw, base_url=BASE)
    assert out["total"] == 431
    assert out["returned"] == 25
    assert out["has_more"] is True
    assert out["next_start_at"] == 25


def test_search_last_page_has_no_more() -> None:
    raw = {"startAt": 25, "maxResults": 25, "total": 27, "issues": [RAW_ISSUE] * 2}
    out = shape_search(raw, base_url=BASE)
    assert out["has_more"] is False
    assert out["next_start_at"] is None


def test_empty_search_is_well_formed() -> None:
    out = shape_search({"startAt": 0, "total": 0, "issues": []}, base_url=BASE)
    assert out["total"] == 0 and out["has_more"] is False and out["issues"] == []


# ── projects and fields ────────────────────────────────────────────────────


def test_project_shape_is_what_jql_needs() -> None:
    raw = {
        "self": f"{BASE}/rest/api/2/project/10000",
        "id": "10000",
        "key": "PLATFORM",
        "name": "Platform Engineering",
        "avatarUrls": AVATARS,
        "projectTypeKey": "software",
        "lead": {"displayName": "Jane Doe", "avatarUrls": AVATARS},
    }
    out = shape_project(raw)
    assert out == {
        "key": "PLATFORM", "name": "Platform Engineering",
        "id": "10000", "type": "software", "lead": "Jane Doe",
    }
    assert "avatarUrls" not in repr(out)


def test_field_shape_keeps_both_the_id_and_the_jql_clause_names() -> None:
    """They differ, and that difference is what makes models guess wrong.

    `customfield_10101` is what goes in `fields`; `cf[10101]` or "Team" is what
    goes in JQL.
    """
    raw = {
        "id": "customfield_10101",
        "name": "Team",
        "custom": True,
        "orderable": True,
        "navigable": True,
        "searchable": True,
        "clauseNames": ["cf[10101]", "Team"],
        "schema": {"type": "option", "custom": "com.atlassian.jira:select", "customId": 10101},
    }
    out = shape_field(raw)
    assert out["id"] == "customfield_10101"
    assert out["clause_names"] == ["cf[10101]", "Team"]
    assert out["custom"] is True
    assert out["type"] == "option"


# ── Confluence ─────────────────────────────────────────────────────────────

RAW_CONF = {
    "id": "123456789",
    "type": "page",
    "status": "current",
    "title": "Rollback procedure",
    "space": {"id": 98, "key": "ENG", "name": "Engineering", "_links": {"webui": "/display/ENG"}},
    "version": {"when": "2026-08-01T09:12:00.000Z", "number": 14, "by": {"displayName": "Jane"}},
    "excerpt": "To roll back, first @@@hl@@@drain@@@endhl@@@ the node pool then...",
    "_expandable": {"container": "/rest/api/space/ENG", "metadata": "", "operations": ""},
    "_links": {
        "webui": "/display/ENG/Rollback+procedure",
        "self": f"{CBASE}/rest/api/content/123456789",
        "tinyui": "/x/AwBQ",
    },
}


def test_confluence_result_projection() -> None:
    out = shape_result(RAW_CONF, base_url=CBASE)
    assert set(out) == {"id", "title", "space_key", "type", "last_modified", "url", "excerpt"}
    assert out["space_key"] == "ENG"
    assert out["url"] == f"{CBASE}/display/ENG/Rollback+procedure"
    assert out["last_modified"] == "2026-08-01T09:12:00.000Z"


def test_confluence_excerpt_loses_highlight_markers() -> None:
    """@@@hl@@@ is Confluence's highlight marker and is noise in a tool result."""
    out = shape_result(RAW_CONF, base_url=CBASE)
    assert "@@@hl@@@" not in out["excerpt"]
    assert "drain" in out["excerpt"]


def test_confluence_links_and_expandable_noise_is_gone() -> None:
    blob = repr(shape_result(RAW_CONF, base_url=CBASE))
    assert "_expandable" not in blob
    assert "tinyui" not in blob
    assert "/rest/api/content" not in blob


def test_confluence_search_has_more_uses_the_next_link() -> None:
    """`total` is unreliable on this endpoint; the next link is not."""
    raw = {"results": [RAW_CONF] * 25, "size": 25, "start": 0, "limit": 25,
           "_links": {"next": "/rest/api/content/search?cql=...&start=25"}}
    out = shape_conf_search(raw, base_url=CBASE, start=0)
    assert out["has_more"] is True
    assert out["next_start"] == 25


def test_confluence_search_without_next_link_has_no_more() -> None:
    raw = {"results": [RAW_CONF], "size": 1, "start": 0, "_links": {}}
    out = shape_conf_search(raw, base_url=CBASE, start=0)
    assert out["has_more"] is False and out["next_start"] is None


def test_page_without_body_omits_it() -> None:
    """body_format="none" is the cheap metadata-only path."""
    out = shape_page(RAW_CONF, base_url=CBASE, include_body=False)
    assert "body" not in out
    assert out["version"] == 14


def test_page_with_body_returns_markdown_and_says_so() -> None:
    raw = dict(RAW_CONF)
    raw["body"] = {"storage": {"value": "<h1>Title</h1><p>Text</p>", "representation": "storage"}}
    out = shape_page(raw, base_url=CBASE, include_body=True)
    assert out["body_format"] == "markdown"
    assert "# Title" in out["body"]
    assert "storage format" in out["body_note"]
