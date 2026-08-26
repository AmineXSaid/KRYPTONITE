"""Storage-format to Markdown.

The cases here are the ones where naive tag-stripping loses information rather
than merely looking untidy: code macros (whose content lives in CDATA and
vanishes entirely), tables (which collapse into run-on prose), structured links
(whose target is in an attribute), and task lists (where the checkbox state is
a sibling element).
"""

from __future__ import annotations

from confluence_mcp.storage import html_excerpt, storage_to_markdown


def test_headings_and_paragraphs() -> None:
    out = storage_to_markdown(
        "<h1>Rollback</h1><p>Drain the pool first.</p><h2>Steps</h2><p>Then reboot.</p>"
    )
    assert "# Rollback" in out
    assert "## Steps" in out
    assert "Drain the pool first." in out


def test_code_macro_body_survives_with_its_language() -> None:
    """The case tag-stripping loses completely: the body is in CDATA."""
    storage = (
        '<ac:structured-macro ac:name="code">'
        '<ac:parameter ac:name="language">bash</ac:parameter>'
        "<ac:plain-text-body><![CDATA[kubectl drain node-1 --ignore-daemonsets]]>"
        "</ac:plain-text-body></ac:structured-macro>"
    )
    out = storage_to_markdown(storage)
    assert "```bash" in out
    assert "kubectl drain node-1 --ignore-daemonsets" in out
    assert "```" in out.split("kubectl")[1]


def test_code_indentation_is_preserved() -> None:
    """Collapsing whitespace inside code destroys what makes it code."""
    storage = (
        '<ac:structured-macro ac:name="code">'
        "<ac:plain-text-body><![CDATA[def f():\n    return 1]]>"
        "</ac:plain-text-body></ac:structured-macro>"
    )
    assert "    return 1" in storage_to_markdown(storage)


def test_table_becomes_a_markdown_table() -> None:
    storage = (
        "<table><tbody>"
        "<tr><th>Env</th><th>Region</th></tr>"
        "<tr><td>prod</td><td>eu-west-1</td></tr>"
        "<tr><td>staging</td><td>eu-west-2</td></tr>"
        "</tbody></table>"
    )
    out = storage_to_markdown(storage)
    assert "| Env | Region |" in out
    assert "| --- | --- |" in out
    assert "| prod | eu-west-1 |" in out
    # The failure mode being prevented: cells running together.
    assert "prodeu-west-1" not in out


def test_table_cell_pipes_are_escaped() -> None:
    storage = "<table><tbody><tr><td>a|b</td><td>c</td></tr></tbody></table>"
    out = storage_to_markdown(storage)
    assert r"a\|b" in out


def test_lists_nest() -> None:
    storage = "<ul><li>one<ul><li>one a</li></ul></li><li>two</li></ul>"
    out = storage_to_markdown(storage)
    assert "- one" in out
    assert "  - one a" in out
    assert "- two" in out


def test_ordered_lists_number() -> None:
    out = storage_to_markdown("<ol><li>first</li><li>second</li><li>third</li></ol>")
    assert "1. first" in out
    assert "2. second" in out
    assert "3. third" in out


def test_internal_page_link_keeps_its_target_and_is_labelled_as_a_title() -> None:
    """The target is a page TITLE, not a URL - saying so stops a model fetching it."""
    storage = (
        '<ac:link><ri:page ri:content-title="Deployment runbook" />'
        "<ac:plain-text-link-body><![CDATA[the runbook]]></ac:plain-text-link-body>"
        "</ac:link>"
    )
    out = storage_to_markdown(storage)
    assert "Deployment runbook" in out
    assert "confluence page:" in out


def test_external_link_is_a_normal_markdown_link() -> None:
    out = storage_to_markdown('<p>See <a href="https://example.com/x">the doc</a>.</p>')
    assert "[the doc](https://example.com/x)" in out


def test_image_becomes_a_named_placeholder() -> None:
    storage = '<ac:image><ri:attachment ri:filename="topology.png" /></ac:image>'
    assert "[image: topology.png]" in storage_to_markdown(storage)


def test_task_list_keeps_checkbox_state() -> None:
    storage = (
        "<ac:task-list>"
        "<ac:task><ac:task-status>complete</ac:task-status>"
        "<ac:task-body>Drain the pool</ac:task-body></ac:task>"
        "<ac:task><ac:task-status>incomplete</ac:task-status>"
        "<ac:task-body>Reboot</ac:task-body></ac:task>"
        "</ac:task-list>"
    )
    out = storage_to_markdown(storage)
    assert "- [x] Drain the pool" in out
    assert "- [ ] Reboot" in out


def test_info_panel_becomes_a_labelled_quote() -> None:
    storage = (
        '<ac:structured-macro ac:name="warning"><ac:rich-text-body>'
        "<p>Do not run this in prod.</p></ac:rich-text-body></ac:structured-macro>"
    )
    out = storage_to_markdown(storage)
    assert "**WARNING**" in out
    assert "Do not run this in prod." in out


def test_layout_and_toc_macros_are_dropped() -> None:
    """Generated at render time; they contain nothing an author wrote."""
    storage = (
        '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter>'
        "</ac:structured-macro><p>Real content.</p>"
    )
    out = storage_to_markdown(storage)
    assert "Real content." in out
    assert "maxLevel" not in out
    assert "3" not in out


def test_emphasis_and_inline_code() -> None:
    out = storage_to_markdown("<p><strong>bold</strong> and <em>italic</em> and <code>x=1</code></p>")
    assert "**bold**" in out
    assert "*italic*" in out
    assert "`x=1`" in out


def test_entities_are_unescaped() -> None:
    assert "A & B" in storage_to_markdown("<p>A &amp; B</p>")


def test_words_do_not_run_together_across_tags() -> None:
    """The classic tag-stripping bug."""
    out = storage_to_markdown("<p>Hello</p><p>world</p>")
    assert "Helloworld" not in out


def test_malformed_markup_returns_partial_text_rather_than_raising() -> None:
    """A page that fails to parse is still more useful than an exception."""
    out = storage_to_markdown("<p>Good text<p>More text<ac:structured-macro ac:name=")
    assert "Good text" in out


def test_empty_input_is_empty_output() -> None:
    assert storage_to_markdown("") == ""
    assert storage_to_markdown("   ") == ""


def test_output_is_much_smaller_than_the_input() -> None:
    """The reason the conversion exists at all."""
    storage = (
        '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell>'
        "<h2>Section</h2>" + "<p>Some prose here.</p>" * 20 +
        "</ac:layout-cell></ac:layout-section></ac:layout>"
    )
    out = storage_to_markdown(storage)
    assert len(out) < len(storage) * 0.75
    assert "Some prose here." in out


def test_excerpt_flattening() -> None:
    raw = "To roll back, <b>first</b> @@@hl@@@drain@@@endhl@@@ the pool &amp; wait."
    out = html_excerpt(raw)
    assert out == "To roll back, first drain the pool & wait."


def test_excerpt_is_truncated_with_an_ellipsis() -> None:
    out = html_excerpt("x" * 500, limit=50)
    assert len(out) <= 50
    assert out.endswith("…")
