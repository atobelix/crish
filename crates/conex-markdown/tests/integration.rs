//! `conex-markdown` 公共 API 契约测试。
//!
//! 旧的 byte-for-byte JS 兼容断言已随 Markdown 2.0 退役；这里锁定新的
//! 语义 HTML 契约、安全边界、缓存/批处理/流式行为，以及列表/表格等
//! 容易回归的结构。

use conex_markdown::{
    clear_cache, highlight_code, highlight_code_lines, render_markdown, render_markdown_batch,
    render_markdown_stream, MarkdownVariant, RenderOptions,
};

fn chat(text: &str) -> String {
    render_markdown(text, RenderOptions::chat()).html
}

fn document(text: &str) -> String {
    render_markdown(text, RenderOptions::document()).html
}

fn count(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return haystack.len();
    }
    haystack.matches(needle).count()
}

fn setup() {
    clear_cache();
}

// ── 列表 ─────────────────────────────────────────────────────

#[test]
fn renders_tight_list_as_single_ul() {
    setup();
    let html = chat("- a\n- b\n- c");
    assert_eq!(count(&html, "<ul class=\"md-ul\">"), 1);
    assert_eq!(count(&html, "<li class=\"md-li\">"), 3);
}

#[test]
fn merges_loose_list_items_into_one_list() {
    setup();
    let html = chat("- a\n\n- b\n\n- c");
    assert_eq!(count(&html, "<ul class=\"md-ul\">"), 1);
    assert_eq!(count(&html, "<li class=\"md-li\">"), 3);
}

#[test]
fn ordered_list_start_attribute_is_preserved() {
    setup();
    let html = chat("5. five\n6. six");
    assert!(html.contains("<ol class=\"md-ol\" start=\"5\">"));
}

#[test]
fn nested_lists_get_nested_class() {
    setup();
    let html = chat("- parent\n  - child\n    - grandchild");
    assert!(html.contains("md-ul-nested"));
    assert!(html.contains("grandchild"));
}

#[test]
fn mixed_ordered_and_unordered_lists_are_separate() {
    setup();
    let html = chat("- a\n1. b\n2. c");
    assert!(html.contains("<ul class=\"md-ul\">"));
    assert!(html.contains("<ol class=\"md-ol\">"));
}

#[test]
fn task_list_uses_disabled_checkbox_inputs() {
    setup();
    let html = chat("- [ ] open\n- [x] done");
    assert_eq!(count(&html, "md-task-item"), 2);
    assert_eq!(count(&html, "md-task-checkbox"), 2);
    assert_eq!(count(&html, " checked"), 1);
    assert!(html.contains("disabled"));
}

#[test]
fn empty_list_item_is_kept() {
    setup();
    let html = chat("- a\n-\n- c");
    assert_eq!(count(&html, "<li class=\"md-li\">"), 3);
}

#[test]
fn dash_lines_inside_fence_are_not_lists() {
    setup();
    let html = chat("```\n- not a list\n```");
    assert!(!html.contains("md-ul"));
    assert!(html.contains("md-code-block"));
}

// ── 表格 ─────────────────────────────────────────────────────

#[test]
fn renders_gfm_table_with_alignment() {
    setup();
    let html = chat("| A | B |\n| :--- | ---: |\n| 1 | 2 |");
    assert!(html.contains("<table class=\"md-table\""));
    assert!(html.contains("--md-table-cols:2"));
    assert!(html.contains("style=\"text-align:right\""));
    assert_eq!(count(&html, "<td class=\"md-td\""), 2);
}

#[test]
fn short_separator_is_padded_to_header_columns() {
    setup();
    let html = chat("| A | B | C |\n| --- | --- |\n| 1 | 2 | 3 |");
    assert!(html.contains("<table"));
    assert_eq!(count(&html, "<th class=\"md-th\""), 3);
}

#[test]
fn short_body_row_is_padded_to_column_count() {
    setup();
    let html = chat("| A | B | C |\n| --- | --- | --- |\n| 1 |");
    assert_eq!(count(&html, "<td class=\"md-td\""), 3);
}

#[test]
fn code_span_pipe_does_not_tear_table_columns() {
    setup();
    let html = chat("| expr | desc |\n| --- | --- |\n| `a | b` | bitwise |");
    assert_eq!(count(&html, "<td class=\"md-td\""), 2);
    assert!(html.contains("md-inline-code"));
    assert!(html.contains("a | b"));
    assert!(!html.contains("bitwise</td><td"));
}

#[test]
fn escaped_pipe_stays_inside_cell() {
    setup();
    let html = chat("| A | B |\n| --- | --- |\n| x \\| y | z |");
    assert_eq!(count(&html, "<td class=\"md-td\""), 2);
    assert!(html.contains("x | y"));
}

#[test]
fn header_only_table_has_empty_tbody() {
    setup();
    let html = chat("| A | B |\n| --- | --- |");
    assert!(html.contains("<tbody></tbody>"));
}

#[test]
fn bare_pipe_prose_is_not_a_table() {
    setup();
    let html = chat("A | B 是逻辑运算");
    assert!(!html.contains("<table"));
}

#[test]
fn horizontal_rule_is_not_a_table_separator() {
    setup();
    let html = chat("---");
    assert!(html.contains("<hr class=\"md-hr\">"));
    assert!(!html.contains("<table"));
}

#[test]
fn table_then_list_are_not_fused() {
    setup();
    let html = chat("| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- item");
    assert!(html.contains("<table"));
    assert!(html.contains("<ul class=\"md-ul\">"));
}

// ── 代码块 ───────────────────────────────────────────────────

#[test]
fn code_block_has_language_and_line_spans() {
    setup();
    let html = chat("```ts\nconst x = 1;\nconst y = 2;\n```");
    assert!(html.contains("md-code-block"));
    assert!(html.contains("data-lang=\"ts\""));
    assert!(html.contains("language-ts"));
    assert_eq!(count(&html, "md-code-line"), 2);
    assert!(html.contains("data-line=\"1\""));
    assert!(html.contains("data-line=\"2\""));
}

#[test]
fn unclosed_fence_is_flushed_in_stream_mode() {
    setup();
    let html = render_markdown_stream("```ts\nconst x = 1;", RenderOptions::chat()).html;
    assert!(html.contains("md-code-block"));
    assert!(html.contains("const x = 1;"));
}

#[test]
fn fence_info_file_and_highlight_are_parsed() {
    setup();
    let html = chat("```ts file=\"src/index.ts\" {1}\nconst a = 1;\nconst b = 2;\n```");
    assert!(html.contains("md-code-breadcrumb"));
    assert!(html.contains("index.ts"));
    assert!(html.contains("md-code-line-highlight"));
}

#[test]
fn mermaid_fence_is_marked_as_island() {
    setup();
    let html = chat("```mermaid\ngraph TD\nA-->B\n```");
    assert!(html.contains("data-md-island=\"mermaid\""));
    assert!(html.contains("data-island-slot=\"mermaid\""));
}

#[test]
fn copy_button_has_no_hardcoded_ui_text() {
    setup();
    let html = chat("```\nx\n```");
    assert!(html.contains("data-tooltip-key=\"markdown.code.copy\""));
    assert!(!html.contains(">Copy<"));
}

#[test]
fn stream_mode_keeps_code_shell_but_skips_syntax_classes() {
    setup();
    let full = chat("```ts\nconst x = 1;\n```");
    let stream = render_markdown_stream("```ts\nconst x = 1;\n```", RenderOptions::chat()).html;
    assert!(full.contains("<span class=\"source"));
    assert!(!stream.contains("<span class=\"source"));
    assert!(stream.contains("md-code-line"));
}

// ── 标题 / 脚注 / Callout / 数学 ──────────────────────────────

#[test]
fn headings_h1_to_h6_and_ids() {
    setup();
    let html = chat("# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6");
    for level in 1..=6 {
        assert!(html.contains(&format!("<h{level} class=\"md-h{level}\"")));
        assert!(html.contains(&format!("</h{level}>")));
    }
    assert!(html.contains("id=\"h1\""));
}

#[test]
fn duplicate_headings_get_suffixes() {
    setup();
    let html = chat("# Same\n\n# Same");
    assert!(html.contains("id=\"same\""));
    assert!(html.contains("id=\"same-1\""));
}

#[test]
fn explicit_heading_id_is_used() {
    setup();
    let html = chat("## Title {#custom-id}");
    assert!(html.contains("id=\"custom-id\""));
}

#[test]
fn footnotes_have_reference_and_section() {
    setup();
    let html = chat("Text[^1]\n\n[^1]: note body");
    assert!(html.contains("md-footnote-ref"));
    assert!(html.contains("href=\"#fn-1\""));
    assert!(html.contains("md-footnotes"));
    assert!(html.contains("md-footnote-backref"));
}

#[test]
fn gfm_alerts_become_callouts() {
    setup();
    let html = chat("> [!WARNING]\n> careful");
    assert!(html.contains("md-callout md-callout-warning"));
    assert!(html.contains("data-callout-title=\"warning\""));
}

#[test]
fn normal_blockquote_stays_blockquote() {
    setup();
    let html = chat("> quote");
    assert!(html.contains("<blockquote class=\"md-quote\">"));
    assert!(!html.contains("md-callout"));
}

#[test]
fn math_becomes_islands() {
    setup();
    let html = chat("inline $E=mc^2$\n\n$$\nx^2\n$$");
    assert!(html.contains("data-md-island=\"math\""));
    assert!(html.contains("data-tex=\"E=mc^2\""));
    assert!(html.contains("md-math-block"));
}

// ── raw HTML 与安全 ──────────────────────────────────────────

#[test]
fn safe_raw_html_tags_survive() {
    setup();
    let html = chat("<details open><summary>log</summary><kbd>Ctrl</kbd> H<sub>2</sub>O <mark>hi</mark></details>");
    assert!(html.contains("<details"));
    assert!(html.contains("<summary>"));
    assert!(html.contains("<kbd>"));
    assert!(html.contains("<sub>"));
    assert!(html.contains("<mark>"));
}

#[test]
fn scripts_and_events_are_stripped() {
    setup();
    let html = chat("<script>alert(1)</script>\n\n<img src=\"x.png\" onerror=\"alert(1)\">");
    assert!(!html.contains("<script"));
    assert!(!html.contains("onerror"));
}

#[test]
fn raw_html_classes_and_data_attributes_are_stripped() {
    setup();
    let html = chat("<p class=\"md-code-copy\" data-md-island=\"math\" id=\"x\">x</p>");
    assert!(!html.contains("md-code-copy"));
    assert!(!html.contains("data-md-island"));
    assert!(!html.contains("id=\"x\""));
}

#[test]
fn javascript_links_become_unsafe_spans() {
    setup();
    let html = chat("[x](javascript:alert(1))");
    assert!(html.contains("md-a-unsafe"));
    assert!(!html.contains("href=\"javascript"));
}

#[test]
fn percent_and_zero_width_smuggled_javascript_are_blocked() {
    setup();
    let a = chat("[x](javascript%3Aalert(1))");
    let b = chat("[x](java\u{200b}script:alert(1))");
    assert!(a.contains("md-a-unsafe"));
    assert!(b.contains("md-a-unsafe"));
}

#[test]
fn http_links_open_in_new_target() {
    setup();
    let html = chat("[x](https://example.com)");
    assert!(html.contains("target=\"_blank\""));
    assert!(html.contains("rel=\"noreferrer\""));
}

#[test]
fn file_urls_become_path_buttons() {
    setup();
    let html = chat("[doc](file:///C:/Workspace/a.md)");
    assert!(html.contains("md-path-link"));
    assert!(html.contains("data-path=\"C:/Workspace/a.md\""));
}

#[test]
fn dangerous_images_are_rejected_but_raster_data_is_allowed() {
    setup();
    let svg = chat("![x](data:image/svg+xml;base64,AAA)");
    let png = chat("![x](data:image/png;base64,AAA)");
    assert!(!svg.contains("<img"));
    assert!(png.contains("data:image/png"));
}

#[test]
fn quotes_and_angles_are_escaped_in_attributes() {
    setup();
    let html = chat("[a\"<b](https://example.com/?q=\"<>)");
    assert!(!html.contains("href=\"https://example.com/?q=\"<>\""));
    assert!(html.contains("&quot;"));
}

// ── CJK / 变体 ───────────────────────────────────────────────

#[test]
fn cjk_text_is_not_split_by_wbr() {
    setup();
    let html = chat("修复Bug完成");
    assert!(!html.contains("<wbr>"));
    assert!(html.contains("修复Bug完成"));
}

#[test]
fn document_variant_renders_soft_break_as_space() {
    setup();
    let chat_html = chat("a\nb");
    let doc_html = document("a\nb");
    assert!(chat_html.contains("<br>"));
    assert!(!doc_html.contains("<br>"));
    assert!(doc_html.contains("a b"));
}

// ── 缓存 / 批处理 / 截断 / 高亮 ──────────────────────────────

#[test]
fn cache_is_isolated_by_variant() {
    setup();
    let chat_html = chat("a\nb");
    let doc_html = document("a\nb");
    assert!(chat_html.contains("<br>"));
    assert!(!doc_html.contains("<br>"));
    // 再取一次仍分别为各自变体结果
    assert_eq!(chat("a\nb"), chat_html);
    assert_eq!(document("a\nb"), doc_html);
}

#[test]
fn batch_returns_one_result_per_input() {
    setup();
    let results = render_markdown_batch(
        vec!["# a".to_string(), "".to_string(), "b".to_string()],
        RenderOptions::chat(),
    );
    assert_eq!(results.len(), 3);
    assert!(results[0].html.contains("md-h1"));
    assert_eq!(results[1].html, "");
    assert!(results[2].html.contains("md-p"));
}

#[test]
fn truncation_is_reported() {
    setup();
    let big = "字".repeat(conex_markdown::MAX_MARKDOWN_INPUT);
    let result = render_markdown(&big, RenderOptions::chat());
    assert!(result.truncated);
}

#[test]
fn highlight_typescript_has_classed_spans() {
    setup();
    let lines = highlight_code_lines("const x = 1;", Some("ts"));
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("<span class=\""));
    assert!(highlight_code("const x = 1;", Some("ts")).contains("const"));
}

#[test]
fn unknown_language_falls_back_to_escaped_text() {
    setup();
    let html = highlight_code("plain <text>", Some("nonsense_xyz"));
    assert!(html.contains("&lt;text&gt;"));
}

#[test]
fn empty_input_is_empty_for_both_variants() {
    setup();
    assert_eq!(chat(""), "");
    assert_eq!(document("   \n\t"), "");
}

#[test]
fn nbsp_and_bidi_smuggling_do_not_create_href() {
    setup();
    let html = chat("[x](java\u{202e}script:alert(1))");
    assert!(html.contains("md-a-unsafe"));
}

#[test]
fn variant_parse_accepts_known_values() {
    assert_eq!(MarkdownVariant::parse("chat"), Some(MarkdownVariant::Chat));
    assert_eq!(
        MarkdownVariant::parse("document"),
        Some(MarkdownVariant::Document)
    );
    assert_eq!(MarkdownVariant::parse("unknown"), None);
}
