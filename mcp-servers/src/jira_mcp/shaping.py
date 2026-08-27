"""Trimming Jira payloads down to what a model can actually use.

A single Jira issue from a corporate instance is routinely 40-80 KB of JSON.
Most of it is structurally required and semantically worthless to a caller:
five avatar URLs at different pixel sizes for every user mentioned, a ``_links``
block, an ``expand`` string listing what you did not ask for, and a ``fields``
object carrying every custom field defined anywhere on the instance - typically
several hundred, nearly all null.

Returning that raw does two bad things: it burns the context window that the
answer needs, and it buries the six facts that matter under noise the model
then has to reason about. So the default projection is deliberately narrow, and
anything beyond it has to be asked for by name through ``fields``.

The projection is the one specified in the brief. It is not a guess about what
is useful - it is the set that lets a model answer "what is this, who has it,
and is it done" without a second call.
"""

from __future__ import annotations

from typing import Any, Mapping

# Requested from the API so the instance sends less over the wire, not just so
# we drop less. On a wide instance this is the difference between a 2 MB search
# response and a 60 KB one.
DEFAULT_ISSUE_FIELDS = (
    "summary",
    "status",
    "issuetype",
    "assignee",
    "reporter",
    "priority",
    "updated",
)

# Keys that are pure noise wherever they appear. Stripped from any extra field
# a caller explicitly requested, since asking for `parent` should not drag in
# the parent's avatar set.
_NOISE_KEYS = frozenset(
    {"avatarUrls", "_links", "expand", "self", "iconUrl", "accountId", "entityId"}
)


def _person(node: Any) -> str | None:
    """A user object reduced to a display name.

    Prefers ``displayName``; falls back to ``name`` (the DC username) and then
    ``emailAddress``. Returns None for an unassigned field rather than the
    string "None", which a model will otherwise report as an assignee.
    """
    if not isinstance(node, Mapping):
        return None
    for key in ("displayName", "name", "emailAddress"):
        val = node.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return None


def _named(node: Any) -> str | None:
    """Pull ``name`` off a status/type/priority object."""
    if not isinstance(node, Mapping):
        return None
    val = node.get("name")
    return val if isinstance(val, str) and val.strip() else None


def strip_noise(value: Any) -> Any:
    """Recursively drop avatar blocks, ``_links`` and other Atlassian scaffolding.

    Applied only to caller-requested extra fields. The core projection is built
    by hand and never needs it.
    """
    if isinstance(value, Mapping):
        return {
            k: strip_noise(v)
            for k, v in value.items()
            if k not in _NOISE_KEYS and v is not None
        }
    if isinstance(value, list):
        return [strip_noise(v) for v in value]
    return value


def issue_url(base_url: str, key: str) -> str:
    """The human-facing browse URL.

    Built rather than taken from the payload's ``self``, which is the REST URL
    (``/rest/api/2/issue/10042``) and is useless to a person. Data Center and
    Cloud both serve ``/browse/KEY``.
    """
    return f"{base_url.rstrip('/')}/browse/{key}"


def shape_issue(
    raw: Mapping[str, Any],
    *,
    base_url: str,
    extra_fields: tuple[str, ...] = (),
) -> dict[str, Any]:
    """One Jira issue, reduced to the standard projection.

    ``extra_fields`` are added under a separate ``fields`` key rather than
    merged into the top level, so a custom field called ``status`` cannot
    shadow the real one and a caller can always tell which values it asked for.
    """
    fields = raw.get("fields") or {}
    key = raw.get("key", "")

    shaped: dict[str, Any] = {
        "key": key,
        "summary": fields.get("summary"),
        "status": _named(fields.get("status")),
        "issue_type": _named(fields.get("issuetype")),
        "assignee": _person(fields.get("assignee")),
        "reporter": _person(fields.get("reporter")),
        "priority": _named(fields.get("priority")),
        "updated": fields.get("updated"),
        "url": issue_url(base_url, key) if key else None,
    }

    if extra_fields:
        extras = {}
        for name in extra_fields:
            if name in DEFAULT_ISSUE_FIELDS:
                continue  # already in the projection above
            if name in fields:
                extras[name] = strip_noise(fields[name])
        if extras:
            shaped["fields"] = extras

    return shaped


def shape_search(
    raw: Mapping[str, Any],
    *,
    base_url: str,
    extra_fields: tuple[str, ...] = (),
) -> dict[str, Any]:
    """A ``/search`` response, with the pagination facts a caller needs.

    ``total`` and ``has_more`` are non-negotiable. Without them a model that
    receives 25 issues cannot tell whether it has seen the answer or the first
    page of four hundred, and will confidently summarise a slice as the whole.
    """
    issues = raw.get("issues") or []
    start_at = int(raw.get("startAt", 0) or 0)
    total = int(raw.get("total", len(issues)) or 0)
    returned = len(issues)

    return {
        "total": total,
        "start_at": start_at,
        "returned": returned,
        "has_more": start_at + returned < total,
        # Spelled out so the caller does not have to do the arithmetic to
        # continue, which is a step models reliably get wrong.
        "next_start_at": start_at + returned if start_at + returned < total else None,
        "issues": [
            shape_issue(i, base_url=base_url, extra_fields=extra_fields) for i in issues
        ],
    }


def shape_project(raw: Mapping[str, Any]) -> dict[str, Any]:
    """A project reduced to what is needed to write JQL against it."""
    lead = _person(raw.get("lead"))
    return {
        "key": raw.get("key"),
        "name": raw.get("name"),
        "id": raw.get("id"),
        "type": raw.get("projectTypeKey"),
        "lead": lead,
    }


def shape_field(raw: Mapping[str, Any]) -> dict[str, Any]:
    """A field definition, reduced to what makes it usable in ``fields``/JQL.

    ``clause_names`` is the important one and the least obvious: it is what you
    may write in JQL, which for a custom field is often ``cf[10101]`` or a
    quoted display name rather than the ``customfield_10101`` id used in the
    ``fields`` parameter. Returning both is what stops a model guessing.
    """
    schema = raw.get("schema") or {}
    return {
        "id": raw.get("id"),
        "name": raw.get("name"),
        "custom": bool(raw.get("custom")),
        "type": schema.get("type") if isinstance(schema, Mapping) else None,
        "clause_names": raw.get("clauseNames") or [],
    }
