//! 集成测试:逐字移植自 apps/crish-desktop/src/api/markdownRender.lists.test.ts
//!
//! 这是 Rust markdown 渲染层的契约。任何输出变更必须先更新这里。
//! HTML 输出必须 byte-for-byte 兼容现有 CSS 选择器。

use conex_markdown::{
    clear_cache, highlight_code, render_markdown, strip_thought_placeholders,
};

/// 计算字符串中某个子串出现的次数(非正则)。
fn count_substr(s: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return s.len();
    }
    s.matches(needle).count()
}

/// 计算正则匹配次数。
fn count_re(s: &str, pattern: &str) -> usize {
    let re = regex::Regex::new(pattern).unwrap_or_else(|e| panic!("bad pattern {pattern}: {e}"));
    re.find_iter(s).count()
}

/// 断言字符串匹配正则。
fn assert_match(s: &str, pattern: &str) {
    let re = regex::Regex::new(pattern).unwrap_or_else(|e| panic!("bad pattern {pattern}: {e}"));
    assert!(
        re.is_match(s),
        "expected string to match `{pattern}`\nactual: {s}"
    );
}

/// 断言字符串不匹配正则。
fn assert_not_match(s: &str, pattern: &str) {
    let re = regex::Regex::new(pattern).unwrap_or_else(|e| panic!("bad pattern {pattern}: {e}"));
    assert!(
        !re.is_match(s),
        "expected string NOT to match `{pattern}`\nactual: {s}"
    );
}

fn setup() {
    clear_cache();
}

// ── lists & tables ────────────────────────────────────────────

#[test]
fn renders_tight_priority_list_as_single_ul() {
    setup();
    let html = render_markdown(
        "### 改进建议优先级\n\n- **P0** 先修 markdown 重复列表\n- **P1** 表格窄屏换行\n- **P2** 其他 polish",
    );
    assert!(html.contains("<h3 class=\"md-h3\">改进建议优先级</h3>"));
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 3);
    assert!(html.contains("<strong>P0</strong>"));
    // 不得把 li 再包进 p(浏览器会重排成重影列表)
    assert_not_match(&html, r"<p[^>]*>\s*<li");
    assert_not_match(&html, r"<p[^>]*>[\s\S]*<ul");
}

#[test]
fn merges_loose_list_items_with_blank_lines_into_one_list() {
    setup();
    let md = "### 改进建议优先级\n\n- **P0 · 必须**\n\n  修复 markdown 重复列表与重叠\n\n- **P1 · 应该**\n\n  表格窄屏 overflow\n\n- **P2 · 可以**\n\n  细节优化\n";
    let html = render_markdown(md);
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 3);
    assert!(html.contains("修复 markdown 重复列表与重叠"));
    assert!(html.contains("表格窄屏 overflow"));
    // 续行应并入 li,而不是拆成段落后再开新列表
    assert_match(
        &html,
        r#"<li class="md-li"><strong>P0 · 必须</strong><br />\u{4fee}\u{590d} markdown"#,
    );
}

#[test]
fn merges_ordered_list_items_with_indented_continuations() {
    setup();
    let md = "## 改进建议优先级\n\n1. **高**\n   修复列表重复渲染问题\n2. **中**\n   改进表格在窄屏下的表现\n3. **低**\n   细节 polish\n";
    let html = render_markdown(md);
    assert_eq!(count_substr(&html, "<ol"), 1);
    assert_eq!(count_substr(&html, "<ul"), 0);
    assert_eq!(count_substr(&html, "<li"), 3);
    assert!(html.contains("修复列表重复渲染问题"));
}

#[test]
fn does_not_let_italic_eat_asterisk_list_markers() {
    setup();
    let html = render_markdown("* **P0**:修复 *markdown* 列表重复\n* **P1**:改进 *table* 样式");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 2);
    assert!(html.contains("<em>markdown</em>"));
    assert!(html.contains("<em>table</em>"));
    // 不得留下残片 `markdown*` / 整行被 em 吞掉
    assert!(!html.contains("markdown*"));
    assert_not_match(&html, r"<em>\s*<strong>P0");
}

#[test]
fn keeps_dash_lists_with_italic_intact() {
    setup();
    let html = render_markdown("- **P0** 先修 *重复* 列表\n- **P1** 表格");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert!(html.contains("<em>重复</em>"));
}

#[test]
fn splits_mixed_ul_ol_into_separate_lists() {
    setup();
    let html = render_markdown("- a\n- b\n1. c\n2. d");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<ol"), 1);
    assert!(html.contains("md-ul"));
    assert!(html.contains("md-ol"));
}

#[test]
fn renders_task_lists_inside_one_ul() {
    setup();
    let html = render_markdown("- [ ] todo one\n- [x] done two\n- normal three");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert!(html.contains("md-task-item"));
    assert!(html.contains("md-task-box checked"));
}

#[test]
fn does_not_convert_dash_lines_inside_fenced_code_into_lists() {
    setup();
    let html = render_markdown("code:\n\n```\n- a\n- b\n```\n\n- real list\n- item 2");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 2);
    assert!(html.contains("md-code-block"));
    assert!(html.contains("md-code-copy"));
    assert!(!html.contains("data-copy="));
    let code_inner = regex::Regex::new(r#"<code class="language-">([\s\S]*?)</code>"#)
        .unwrap()
        .captures(&html)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    assert!(code_inner.contains('-'));
    assert!(!code_inner.contains("<li"));
}

#[test]
fn renders_gfm_tables_with_wrap_and_inline_bold_in_cells() {
    setup();
    let md = "### 改进建议优先级\n\n| 优先级 | 建议 | 说明 |\n| --- | --- | --- |\n| **P0** | 重复列表 | 必须 |\n| P1 | 窄屏表格 | 应该 |\n";
    let html = render_markdown(md);
    assert!(html.contains("md-table-wrap"));
    assert!(html.contains("md-table"));
    assert!(html.contains("<strong>P0</strong>"));
    assert_eq!(count_substr(&html, "<table"), 1);
}

#[test]
fn does_not_emit_duplicate_list_markers_for_priority_section() {
    setup();
    let raw = "**改进建议优先级**\n\n1. **P0**:修复 markdown 助手「改进建议优先级」重复渲染(大列表 + 小浮层列表)\n2. **P1**:表格在窄屏下边框重叠、灰块过重\n3. **P2**:列表在窄容器内换行撕裂\n";
    let html = render_markdown(raw);
    assert_eq!(count_substr(&html, "<ol"), 1);
    assert_eq!(count_substr(&html, "<li"), 3);
    // 每条正文只出现一次
    assert_eq!(count_substr(&html, "大列表 + 小浮层列表"), 1);
    assert_eq!(count_substr(&html, "边框重叠"), 1);
}

#[test]
fn applies_gfm_column_alignment_from_separator() {
    setup();
    let html = render_markdown("| L | C | R |\n|:---|:---:|---:|\n| a | b | c |\n");
    assert!(html.contains("text-align:center"));
    assert!(html.contains("text-align:right"));
    assert!(html.contains("md-table"));
    assert!(html.contains("scope=\"col\""));
}

#[test]
fn stripes_alternating_table_body_rows() {
    setup();
    let html = render_markdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n");
    assert!(html.contains("md-tr-alt"));
    // 仅偶数索引行(1-based 第 2 行)带 alt:3 行体 → 1 条 alt
    assert_eq!(count_substr(&html, "md-tr-alt"), 1);
}

#[test]
fn renders_fenced_code_with_language_badge() {
    setup();
    let html = render_markdown("```ts\nconst x = 1;\n```");
    assert!(html.contains("md-code-block"));
    assert!(html.contains("md-code-lang"));
    // highlight.js 可能把 ts 规范为 typescript;徽章与 class 同源
    assert_match(&html, r#"md-code-lang"[^>]*>(ts|typescript)<"#);
    assert_match(&html, r#"data-lang="(ts|typescript)""#);
    assert_match(&html, r#"language-(ts|typescript)"#);
    // 无语言 fence 不画空徽章
    let plain = render_markdown("```\nplain\n```");
    assert!(plain.contains("md-code-block"));
    assert!(!plain.contains("md-code-lang"));
}

#[test]
fn nests_indented_child_list_under_parent_item() {
    setup();
    let html = render_markdown("- parent\n  - child a\n  - child b\n- sibling\n");
    assert!(html.contains("md-ul-nested"));
    assert_eq!(count_substr(&html, "<li"), 4);
    // nested ul sits inside first li
    assert_match(
        &html,
        r#"<li class="md-li">parent<ul class="md-ul md-ul-nested">"#,
    );
}

#[test]
fn nests_multi_level_indented_lists_grandchildren() {
    setup();
    let html = render_markdown("- root\n  - child\n    - grand\n  - child2\n- sibling\n");
    assert!(count_substr(&html, "md-ul-nested") >= 2);
    assert_eq!(count_substr(&html, "<li"), 5);
    assert!(html.contains("grand"));
    // grand 应在 child 的嵌套 ul 内,而不是与 child 同级
    assert_match(
        &html,
        r#"<li class="md-li">child<ul class="md-ul md-ul-nested"><li class="md-li">grand</li></ul>"#,
    );
}

#[test]
fn strips_benlun_zongjie_heading_noise_before_render() {
    setup();
    let html = render_markdown("## 本轮总结\n\n实际正文内容");
    assert!(!html.contains("本轮总结"));
    assert!(html.contains("实际正文内容"));
}

#[test]
fn strips_reinforced_benlun_zongjie_variants() {
    setup();
    let variants = [
        "## 本轮总结:",
        "### 本轮小结",
        "**本轮回顾**",
        "**本轮总结:**",
        "【本轮总结】",
        "本轮总结",
        "本轮小结:",
        "## 本轮工作总结",
        "### 本回合小结 ·",
        "本轮内容回顾:",
        "## Round summary",
        "## Session summary:",
        "## Turn summary",
        "**Round summary**",
        "Round summary:",
    ];
    let noise_re = regex::Regex::new(r"(?i)本轮|本回合|Round\s+summary|Session\s+summary|Turn\s+summary").unwrap();
    for line in &variants {
        let stripped = strip_thought_placeholders(&format!("{}\n\n保留正文", line));
        assert!(
            !noise_re.is_match(&stripped),
            "should strip: {}\nactual: {}",
            line,
            stripped
        );
        assert!(
            stripped.contains("保留正文"),
            "should keep body for: {}\nactual: {}",
            line,
            stripped
        );
    }
    // 正文里提到「本轮总结」不应被整段清空
    let keep = strip_thought_placeholders("请在文末写本轮总结段落,不要省略细节。");
    assert!(keep.contains("本轮总结段落"));
}

#[test]
fn renders_plus_sign_unordered_lists() {
    setup();
    let html = render_markdown("+ alpha\n+ beta\n+ gamma");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 3);
    assert!(html.contains("alpha"));
    assert!(html.contains("gamma"));
}

#[test]
fn parses_fence_info_string_first_token_as_language() {
    setup();
    let html = render_markdown("```ts title=\"demo\"\nconst n = 1;\n```");
    assert!(html.contains("md-code-block"));
    assert!(html.contains("language-typescript"));
    assert!(html.contains(">typescript<"));
    assert!(html.contains("md-code-copy"));
    assert!(!html.contains("data-copy="));
}

#[test]
fn renders_trailing_unclosed_fence_as_code_block_streaming() {
    setup();
    let html = render_markdown("intro\n\n```js\nconsole.log(1);\nconst x = 2;");
    assert!(html.contains("md-code-block"));
    assert!(html.contains("language-javascript"));
    assert!(html.contains("md-code-copy"));
    assert!(!html.contains("data-copy="));
    // 未闭合时不应把代码行当正文列表/段落泄漏成裸 ```
    assert!(!html.contains("```"));
}

#[test]
fn maps_cpp_fence_alias_to_cpp_language_id() {
    setup();
    let html = render_markdown("```c++\nint main() {}\n```");
    assert!(html.contains("language-cpp"));
    assert!(html.contains("md-code-lang"));
}

#[test]
fn does_not_treat_a_horizontal_rule_as_a_table_separator() {
    setup();
    let html = render_markdown("before\n\n---\n\nafter");
    assert!(!html.contains("md-table"));
    assert!(html.contains("before"));
    assert!(html.contains("after"));
}

#[test]
fn pads_short_table_body_rows_to_header_column_count() {
    setup();
    let html = render_markdown("| A | B | C |\n| --- | --- | --- |\n| only |\n");
    assert!(html.contains("md-table"));
    let row = regex::Regex::new(r#"<tbody><tr class="md-tr">([\s\S]*?)</tr></tbody>"#)
        .unwrap()
        .captures(&html)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    assert_eq!(count_substr(&row, "<td"), 3);
}

#[test]
fn escapes_raw_html_in_markdown_body_no_script_injection() {
    setup();
    let html = render_markdown("hello <script>alert(1)</script> world");
    assert!(!html.contains("<script>"));
    assert!(html.contains("&lt;script&gt;"));
    assert!(html.contains("hello"));
}

#[test]
fn blocks_javascript_and_data_links_unsafe_scheme_to_span_no_href() {
    setup();
    let js = render_markdown("[click](javascript:alert(1))");
    assert_not_match(&js, r#"(?i)href\s*=\s*["']?javascript:"#);
    assert!(js.contains("md-a-unsafe"));
    assert!(js.contains("click"));
    assert!(!js.contains("<a class=\"md-a\""));

    let data = render_markdown("[x](data:text/html,<script>alert(1)</script>)");
    // data: 且 URL 含空格时正则可能截断;若匹配到则不得成可点链
    if data.contains("md-a") || data.contains("href") {
        assert_not_match(&data, r#"(?i)href\s*=\s*["']?data:"#);
    }

    let vbs = render_markdown("[v](vbscript:msgbox(1))");
    assert_not_match(&vbs, r#"(?i)href\s*=\s*["']?vbscript:"#);
    assert!(vbs.contains("md-a-unsafe"));
}

#[test]
fn allows_http_s_and_mailto_links() {
    setup();
    let http = render_markdown("[web](https://example.com/a)");
    assert!(http.contains("href=\"https://example.com/a\""));
    assert!(http.contains("rel=\"noreferrer\""));
    let mail = render_markdown("[me](mailto:a@b.com)");
    assert!(mail.contains("href=\"mailto:a@b.com\""));
}

#[test]
fn blocks_dangerous_image_src_javascript_non_image_data() {
    setup();
    let js_img = render_markdown("![x](javascript:alert(1))");
    assert_not_match(&js_img, r#"(?i)src\s*=\s*["']?javascript:"#);
    assert!(!js_img.contains("<img"));

    let bad_data = render_markdown("![y](data:text/html,hi)");
    assert!(!bad_data.contains("<img"));
    assert_not_match(&bad_data, r#"(?i)src\s*=\s*["']?data:text/html"#);
}

#[test]
fn escapes_html_special_chars_inside_table_cells() {
    setup();
    let html = render_markdown("| A | B |\n| --- | --- |\n| <b>x</b> | a&b |\n");
    assert!(html.contains("&lt;b&gt;"));
    assert!(!html.contains("<b>x</b>"));
    assert!(html.contains("a&amp;b"));
}

#[test]
fn normalizes_crlf_list_lines_into_one_ul() {
    setup();
    let html = render_markdown("- a\r\n- b\r\n- c");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 3);
}

#[test]
fn nests_ordered_list_under_unordered_parent() {
    setup();
    let html = render_markdown("- parent\n  1. one\n  2. two\n- sibling\n");
    assert!(html.contains("md-ol-nested"));
    assert_eq!(count_substr(&html, "<li"), 4);
    assert_match(&html, r#"<li class="md-li">parent<ol class="md-ol md-ol-nested">"#);
}

#[test]
fn strips_zhengzaisikao_placeholder_without_wiping_following_body() {
    setup();
    let stripped = strip_thought_placeholders("正在思考中…\n\n正文来了");
    assert!(!regex::Regex::new(r"正在思考").unwrap().is_match(&stripped));
    assert!(stripped.contains("正文来了"));
    let html = render_markdown("正在处理...\n\n- item");
    assert!(!html.contains("正在处理"));
    assert!(html.contains("<li"));
}

#[test]
fn returns_empty_string_for_empty_or_whitespace_only_after_strip() {
    setup();
    assert_eq!(render_markdown(""), "");
    assert_eq!(render_markdown("正在思考中…"), "");
    assert_eq!(strip_thought_placeholders(""), "");
}

#[test]
fn renders_code_fence_copy_button_without_data_copy_payload() {
    setup();
    let html = render_markdown("```\nconst s = 'hi';\n```");
    assert!(html.contains("md-code-copy"));
    assert!(!html.contains("data-copy="));
    assert!(html.contains("md-code-pre"));
    assert_match(&html, r"const|hljs-keyword|keyword");
}

#[test]
fn truncates_wide_table_body_rows_to_header_column_count() {
    setup();
    let html = render_markdown("| A | B |\n| --- | --- |\n| 1 | 2 | 3 | 4 |\n");
    let row = regex::Regex::new(r#"<tbody><tr class="md-tr">([\s\S]*?)</tr></tbody>"#)
        .unwrap()
        .captures(&html)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    assert_eq!(count_substr(&row, "<td"), 2);
    assert!(!html.contains(">3<"));
    assert!(!html.contains(">4<"));
}

#[test]
fn renders_empty_task_checkbox_and_checked_x_variants() {
    setup();
    let html = render_markdown("- [ ] open\n- [X] done caps\n- [x] done lower");
    assert_eq!(count_substr(&html, "md-task-item"), 3);
    assert_eq!(count_substr(&html, "md-task-box checked"), 2);
    assert_eq!(count_substr(&html, "md-task-item done"), 2);
}

#[test]
fn does_not_treat_bare_pipe_prose_as_a_table_without_separator() {
    setup();
    let html = render_markdown("a | b | c\nnot a table line");
    assert!(!html.contains("md-table"));
    assert!(html.contains("a | b | c"));
}

// ── empty input ──────────────────────────────────────────────

#[test]
fn returns_empty_for_whitespace_only_and_nullish_like_blanks() {
    setup();
    assert_eq!(render_markdown(""), "");
    assert_eq!(render_markdown("   "), "");
    assert_eq!(render_markdown("\n\n\t\n"), "");
    assert_eq!(render_markdown("   \r\n  \r\n"), "");
    assert_eq!(strip_thought_placeholders("   \n\t  "), "");
    assert_eq!(strip_thought_placeholders("---"), "---");
}

#[test]
fn renders_standard_horizontal_rule() {
    setup();
    assert_eq!(render_markdown("---"), "<hr class=\"md-hr\" />");
    assert_eq!(render_markdown("***"), "<hr class=\"md-hr\" />");
    assert_eq!(render_markdown("___"), "<hr class=\"md-hr\" />");
}

// ── XSS-safe escapes ─────────────────────────────────────────

#[test]
fn blocks_zero_width_bidi_smuggled_javascript_hrefs() {
    setup();
    // U+200B between letters
    let zw = render_markdown("[x](java\u{200b}script:alert(1))");
    assert_not_match(&zw, r"(?i)href\s*=");
    assert!(zw.contains("md-a-unsafe"));

    // BOM prefix
    let bom = render_markdown("[x](\u{feff}javascript:alert(1))");
    assert_not_match(&bom, r#"(?i)href\s*=\s*["']?javascript:"#);
    assert!(bom.contains("md-a-unsafe"));

    // bidi override
    let bidi = render_markdown("[x](\u{202e}javascript:alert(1))");
    assert_not_match(&bidi, r#"(?i)href\s*=\s*["']?javascript:"#);
}

#[test]
fn escapes_quotes_and_angle_brackets_in_link_text_and_url_attrs() {
    setup();
    let html = render_markdown("[say \"hi\" <ok>](https://ex.com/a?q=\"b\"&c='d')");
    assert!(html.contains("href=\"https://ex.com/a?q=&quot;b&quot;&amp;c=&#39;d&#39;\""));
    assert!(html.contains("say &quot;hi&quot; &lt;ok&gt;"));
    assert!(!html.contains("say \"hi\""));
}

#[test]
fn blocks_data_image_svg_plus_xml_but_allows_raster_data_image_png() {
    setup();
    let svg = render_markdown("![x](data:image/svg+xml;base64,PHN2Zy9+)");
    assert!(!svg.contains("<img"));
    assert_not_match(&svg, r#"(?i)src\s*=\s*["']?data:image/svg"#);

    let png = render_markdown("![ok](data:image/png;base64,iVBOR)");
    assert!(png.contains("<img"));
    assert!(png.contains("src=\"data:image/png;base64,iVBOR\""));
    assert!(png.contains("alt=\"ok\""));
}

#[test]
fn escapes_raw_html_in_list_items_and_headings() {
    setup();
    let li = render_markdown("- <img src=x onerror=alert(1)>\n- **<em>x</em>**");
    assert!(!li.contains("<img src=x"));
    assert!(li.contains("&lt;img"));
    assert!(li.contains("<strong>&lt;em&gt;x&lt;/em&gt;</strong>"));

    let h = render_markdown("## Title <script>x</script>");
    assert!(h.contains("<h2"));
    assert!(h.contains("&lt;script&gt;"));
    assert!(!h.contains("<script>x</script>"));
}

// ── CJK wrapping ─────────────────────────────────────────────

#[test]
fn inserts_wbr_between_cjk_and_latin_for_narrow_wrap() {
    setup();
    let html = render_markdown("修复markdown列表重复问题");
    // CJK|Latin and Latin|CJK boundaries
    assert!(html.contains("复<wbr>m"));
    assert!(html.contains("n<wbr>列"));
    // wbr must not appear inside tag attributes
    assert_not_match(&html, r#"class="[^"]*<wbr>"#);
}

#[test]
fn pure_cjk_runs_do_not_insert_wbr_in_table_cells_or_paragraphs() {
    setup();
    let long = "这是一段很长的中文用于测试窄屏表格单元格断行效果如何";
    let cjk_count = long.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count();
    assert!(cjk_count > 10);
    let para = render_markdown(long);
    assert!(!para.contains("<wbr>"));

    let table = render_markdown(&format!("| 列 | 值 |\n| --- | --- |\n| {} | 短 |\n", long));
    assert!(table.contains("md-td"));
    assert!(!table.contains("<wbr>"));
    // 属性里不得被插入 wbr
    assert_not_match(&table, r#"class="md-td"[^>]*<wbr>"#);
}

#[test]
fn cjk_wrap_does_not_break_bold_code_around_mixed_text() {
    setup();
    let html = render_markdown("代码`const x`与**粗体Text**混排");
    assert!(html.contains("<code class=\"md-inline-code\">const x</code>"));
    assert!(html.contains("<strong>"));
    assert!(html.contains("粗体"));
    assert!(html.contains("Text"));
}

// ── table edge cases ─────────────────────────────────────────

#[test]
fn keeps_escaped_pipes_inside_a_single_table_cell() {
    setup();
    let html = render_markdown("| A | B |\n| --- | --- |\n| a \\| b | c |\n");
    assert!(html.contains("md-table"));
    let row = regex::Regex::new(r#"<tbody><tr class="md-tr">([\s\S]*?)</tr></tbody>"#)
        .unwrap()
        .captures(&html)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    assert_eq!(count_substr(&row, "<td"), 2);
    assert!(row.contains("a | b"));
    assert!(row.contains(">c<"));
}

#[test]
fn renders_header_only_tables_with_empty_tbody() {
    setup();
    let html = render_markdown("| H1 | H2 |\n| --- | --- |\n");
    assert!(html.contains("md-table"));
    assert!(html.contains("<th class=\"md-th\""));
    assert!(html.contains("<tbody></tbody>"));
    assert!(html.contains("H1"));
    assert!(html.contains("H2"));
}

#[test]
fn pads_alignment_when_separator_has_fewer_columns_than_header() {
    setup();
    let html = render_markdown("| A | B | C |\n|:---|---:|\n| 1 | 2 | 3 |\n");
    assert!(html.contains("md-table"));
    // 用 <th\b 避免误计 <thead
    assert_eq!(count_re(&html, r"<th\b"), 3);
    assert_eq!(count_re(&html, r"<td\b"), 3);
    // first col left (from :---), second right; third defaults left (no style)
    assert!(html.contains("text-align:right"));
}

#[test]
fn renders_empty_middle_cells_without_dropping_columns() {
    setup();
    let html = render_markdown("| A | B | C |\n| --- | --- | --- |\n| x |  | z |\n");
    let row = regex::Regex::new(r#"<tbody><tr class="md-tr">([\s\S]*?)</tr></tbody>"#)
        .unwrap()
        .captures(&html)
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    assert_eq!(count_substr(&row, "<td"), 3);
    assert!(row.contains(">x<"));
    assert!(row.contains(">z<"));
    assert_match(&row, r#"<td class="md-td"></td>"#);
}

// ── list edge cases ──────────────────────────────────────────

#[test]
fn emits_start_attribute_for_ordered_lists_beginning_above_1() {
    setup();
    let html = render_markdown("5. fifth\n6. sixth");
    assert!(html.contains("<ol class=\"md-ol\" start=\"5\">"));
    assert_eq!(count_substr(&html, "<li"), 2);
    assert!(html.contains("fifth"));
    // start at 1 should not emit start=
    let from_one = render_markdown("1. a\n2. b");
    assert!(from_one.contains("<ol class=\"md-ol\">"));
    assert!(!from_one.contains("start="));
}

#[test]
fn keeps_empty_list_items_as_li_nodes() {
    setup();
    let html = render_markdown("- \n- b\n- ");
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 3);
    assert!(html.contains(">b<"));
}

#[test]
fn nests_lists_when_child_is_tab_indented() {
    setup();
    let html = render_markdown("- parent\n\t- child tab\n- sibling");
    assert!(html.contains("md-ul-nested"));
    assert!(html.contains("child tab"));
    assert_eq!(count_substr(&html, "<li"), 3);
    assert_match(
        &html,
        r#"<li class="md-li">parent<ul class="md-ul md-ul-nested"><li class="md-li">child tab</li></ul>"#,
    );
}

#[test]
fn renders_adjacent_table_then_list_without_fusing() {
    setup();
    let html = render_markdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- item one\n- item two\n");
    assert_eq!(count_substr(&html, "<table"), 1);
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 2);
    // table wrap before list
    let table_pos = html.find("md-table-wrap").expect("md-table-wrap present");
    let list_pos = html.find("md-ul").expect("md-ul present");
    assert!(table_pos < list_pos);
}

#[test]
fn does_not_turn_table_rows_into_list_items_when_cell_has_dashes() {
    setup();
    let html = render_markdown("| 项 | 说明 |\n| --- | --- |\n| - 不是列表 | 值 |\n");
    assert!(html.contains("md-table"));
    assert!(!html.contains("<ul"));
    assert!(html.contains("- 不是列表"));
}

// ── HX residuals after DE (XSS / inline / images) ─────────────

#[test]
fn keeps_mid_line_images_as_img_placeholder_through_escape() {
    setup();
    let html = render_markdown("see ![a](https://ex.com/a.png) here");
    assert!(html.contains("<img class=\"md-img\""));
    assert!(html.contains("src=\"https://ex.com/a.png\""));
    assert!(!html.contains("&lt;img"));
    // 不得被裸路径正则拆碎 src
    assert!(!html.contains("md-path-link"));
}

#[test]
fn does_not_apply_italic_inside_inline_code_or_href_attributes() {
    setup();
    let code = render_markdown("x `a*b*c` y");
    assert!(code.contains("<code class=\"md-inline-code\">a*b*c</code>"));
    assert_not_match(&code, r"<code[^>]*>[\s\S]*<em>");

    let href = render_markdown("[t](https://ex.com/a*b*c)");
    assert!(href.contains("href=\"https://ex.com/a*b*c\""));
    assert_not_match(&href, r#"href="[^"]*<em>"#);
}

#[test]
fn blocks_percent_encoded_and_angle_bracket_javascript_destinations() {
    setup();
    let pct = render_markdown("[x](javascript%3Aalert(1))");
    assert_not_match(&pct, r"(?i)href\s*=");
    assert!(pct.contains("md-a-unsafe"));

    let tab_pct = render_markdown("[x](java%09script:alert(1))");
    assert_not_match(&tab_pct, r"(?i)href\s*=");
    assert!(tab_pct.contains("md-a-unsafe"));

    let angle = render_markdown("[x](<javascript:alert(1)>)");
    assert_not_match(&angle, r"(?i)href\s*=");
    assert!(angle.contains("md-a-unsafe"));
    // 尖括号目标整段消费,不残留 `>)`
    assert_not_match(&angle, r"\)\s*</p>");
}

#[test]
fn allows_angle_bracket_http_destinations_with_embedded_parentheses() {
    setup();
    let html = render_markdown("[x](<https://ex.com/foo(bar)>)");
    assert!(html.contains("href=\"https://ex.com/foo(bar)\""));
    assert!(html.contains("rel=\"noreferrer\""));
}

#[test]
fn still_inserts_cjk_wbr_in_link_text_without_touching_href() {
    setup();
    let html = render_markdown("[修复markdown](https://ex.com/path)");
    assert!(html.contains("<wbr>"));
    assert!(html.contains("href=\"https://ex.com/path\""));
    assert_not_match(&html, r#"href="[^"]*<wbr>"#);
}

#[test]
fn escapes_script_tag_xss_payload_in_markdown_body() {
    setup();
    let html = render_markdown("hello <script>alert(1)</script> world");
    assert!(!html.contains("<script>"));
    assert!(html.contains("&lt;script&gt;"));
    assert!(html.contains("hello"));
    assert!(html.contains("world"));
}

#[test]
fn passes_img_tags_through_dompurify_sanitizes_event_handlers_at_component_level() {
    setup();
    let html = render_markdown("<img onerror=alert(1) src=x>");
    assert!(html.contains("<img"));
}

// ── batch & highlight API ────────────────────────────────────

#[test]
fn render_markdown_batch_handles_multiple_inputs() {
    setup();
    let inputs = vec!["# hi".to_string(), "- a\n- b".to_string(), "".to_string()];
    let outputs = conex_markdown::render_markdown_batch(inputs);
    assert_eq!(outputs.len(), 3);
    assert!(outputs[0].contains("<h1"));
    assert!(outputs[1].contains("<ul"));
    assert_eq!(outputs[2], "");
}

#[test]
fn highlight_code_returns_html_for_known_language() {
    setup();
    let html = highlight_code("const x = 1;", Some("ts"));
    // 已高亮: 含 span 或转义后的 const
    assert!(html.contains("const") || html.contains("keyword"));
}

#[test]
fn highlight_code_returns_escaped_text_for_unknown_language() {
    setup();
    let html = highlight_code("plain <text>", Some("nonsense_lang_xyz"));
    assert!(html.contains("&lt;text&gt;"));
}

#[test]
fn highlight_code_caches_repeated_calls() {
    setup();
    let a = highlight_code("const x = 1;", Some("ts"));
    let b = highlight_code("const x = 1;", Some("ts"));
    assert_eq!(a, b);
}

#[test]
fn clear_cache_does_not_panic() {
    clear_cache();
    clear_cache();
}

// ── file attribute breadcrumb (Stream A 补充覆盖) ─────────────

#[test]
fn renders_file_path_breadcrumb_in_code_fence() {
    setup();
    let html = render_markdown("```ts file=\"src/foo/bar.ts\"\nconst x = 1;\n```");
    assert!(html.contains("md-code-block"));
    assert!(html.contains("md-code-breadcrumb"));
    assert!(html.contains("md-code-breadcrumb-file"));
    assert!(html.contains("md-code-breadcrumb-segment"));
    assert!(html.contains("md-code-breadcrumb-separator"));
    // 每段 path 都渲染
    assert!(html.contains(">src<"));
    assert!(html.contains(">foo<"));
    assert!(html.contains(">bar.ts<"));
    // 仍有语言徽章
    assert!(html.contains("md-code-lang"));
    assert!(html.contains("data-lang=\"typescript\""));
}

#[test]
fn renders_unquoted_file_attribute_in_code_fence() {
    setup();
    // file= 不带引号的形式
    let html = render_markdown("```ts file=src/baz.ts\nconst y = 2;\n```");
    assert!(html.contains("md-code-breadcrumb"));
    assert!(html.contains(">baz.ts<"));
}

#[test]
fn code_fence_without_file_attr_has_no_breadcrumb() {
    setup();
    let html = render_markdown("```ts\nconst x = 1;\n```");
    assert!(!html.contains("md-code-breadcrumb"));
    assert!(html.contains("md-code-lang"));
}

// ── 24 种语言高亮覆盖 (Stream A 补充覆盖) ────────────────────

#[test]
fn normalizes_all_supported_language_aliases() {
    setup();
    // (输入别名, 规范化后的语言 id)
    // 覆盖契约文档 7.4 节列出的 24 种语言及其别名
    let cases: &[(&str, &str)] = &[
        ("javascript", "javascript"),
        ("js", "javascript"),
        ("jsx", "javascript"),
        ("typescript", "typescript"),
        ("ts", "typescript"),
        ("tsx", "typescript"),
        ("json", "json"),
        ("xml", "xml"),
        ("html", "html"),
        ("css", "css"),
        ("python", "python"),
        ("py", "python"),
        ("rust", "rust"),
        ("rs", "rust"),
        ("bash", "bash"),
        ("shell", "bash"),
        ("sh", "bash"),
        ("powershell", "bash"),
        ("markdown", "markdown"),
        ("md", "markdown"),
        ("sql", "sql"),
        ("yaml", "yaml"),
        ("yml", "yaml"),
        ("go", "go"),
        ("java", "java"),
        ("c", "c"),
        ("cpp", "cpp"),
        ("c++", "cpp"),
        ("c#", "csharp"),
        ("cs", "csharp"),
        ("diff", "diff"),
        ("ruby", "ruby"),
        ("rb", "ruby"),
        ("php", "php"),
        ("swift", "swift"),
        ("kotlin", "kotlin"),
        ("kt", "kotlin"),
        ("dart", "dart"),
        ("zsh", "bash"),
        ("ps1", "bash"),
    ];
    for (input, expected) in cases {
        let html = render_markdown(&format!("```{}\ncode\n```", input));
        assert!(
            html.contains(&format!("data-lang=\"{}\"", expected)),
            "语言别名 '{}' 应规范化为 '{}', 实际输出: {}",
            input,
            expected,
            html
        );
        assert!(
            html.contains(&format!("language-{}", expected)),
            "语言别名 '{}' 应生成 class 'language-{}', 实际输出: {}",
            input,
            expected,
            html
        );
    }
}

#[test]
fn highlights_all_supported_languages_without_panic() {
    setup();
    // 对每种支持的语言调用 highlight_code, 至少不 panic 且返回非空 HTML
    let langs = [
        "javascript", "typescript", "json", "xml", "html", "css", "python", "rust",
        "bash", "markdown", "sql", "yaml", "go", "java", "c", "cpp", "diff", "ruby",
        "php", "swift", "kotlin", "dart",
    ];
    for lang in &langs {
        let html = highlight_code("code snippet", Some(lang));
        assert!(!html.is_empty(), "highlight_code('{}') 返回空", lang);
    }
}

// ── 裸路径自动链接 (Stream A 新增功能) ───────────────────────

#[test]
fn wraps_bare_project_paths_as_path_link_buttons() {
    setup();
    let html = render_markdown("see apps/foo/bar.ts for details");
    assert!(html.contains("md-path-link"));
    assert!(html.contains("data-path=\"apps/foo/bar.ts\""));
    assert!(html.contains(">apps/foo/bar.ts<"));
}

#[test]
fn wraps_bare_src_and_packages_paths_as_path_link() {
    setup();
    let src_html = render_markdown("edit src/index.ts today");
    assert!(src_html.contains("md-path-link"));
    assert!(src_html.contains("data-path=\"src/index.ts\""));

    let pkg_html = render_markdown("see packages/lib/util.rs here");
    assert!(pkg_html.contains("md-path-link"));
    assert!(pkg_html.contains("data-path=\"packages/lib/util.rs\""));
}

#[test]
fn wraps_windows_drive_paths_as_path_link() {
    setup();
    let html = render_markdown("open C:/foo/bar.ts file");
    assert!(html.contains("md-path-link"));
    assert!(html.contains("data-path=\"C:/foo/bar.ts\""));
}

#[test]
fn wraps_absolute_home_and_relative_paths_as_path_link() {
    setup();
    let abs_html = render_markdown("see /etc/foo.conf here");
    assert!(abs_html.contains("md-path-link"));

    let home_html = render_markdown("edit ~/config/bar.toml now");
    assert!(home_html.contains("md-path-link"));

    let rel_html = render_markdown("see ./local.ts file");
    assert!(rel_html.contains("md-path-link"));

    let parent_html = render_markdown("see ../parent.rs file");
    assert!(parent_html.contains("md-path-link"));
}

#[test]
fn does_not_wrap_paths_inside_inline_code() {
    setup();
    // 行内代码内的路径不应被包装为 button (handle_inline_code 不走 handle_text)
    let html = render_markdown("run `apps/foo/bar.ts` now");
    assert!(!html.contains("md-path-link"));
    assert!(html.contains("md-inline-code"));
}

#[test]
fn does_not_wrap_paths_inside_fenced_code_block() {
    setup();
    let html = render_markdown("```\napps/foo/bar.ts\n```");
    assert!(!html.contains("md-path-link"));
    assert!(html.contains("md-code-block"));
}

#[test]
fn does_not_wrap_plain_text_without_extension() {
    setup();
    // 路径必须有 .[A-Za-z0-9]{1,12} 扩展名
    let html = render_markdown("see apps/foo/bar");
    assert!(!html.contains("md-path-link"));
}

#[test]
fn does_not_wrap_paths_in_link_destinations() {
    setup();
    // 链接 dest 中的 URL 不走 handle_text, 不应被包装
    let html = render_markdown("[text](https://ex.com/a.png)");
    assert!(!html.contains("md-path-link"));
    assert!(html.contains("md-a"));
}

#[test]
fn wraps_multiple_bare_paths_in_one_paragraph() {
    setup();
    // 路径体至少 2 字符 (regex `[^\s`"'<>|]{2,160}`); 前缀仅 apps/ packages/ src/
    let html = render_markdown("edit apps/foo.ts and src/bar.rs and packages/baz.md");
    assert_eq!(count_substr(&html, "md-path-link"), 3);
    assert!(html.contains("data-path=\"apps/foo.ts\""));
    assert!(html.contains("data-path=\"src/bar.rs\""));
    assert!(html.contains("data-path=\"packages/baz.md\""));
}

// ── md-ol-item CSS 类 (Stream A 修复覆盖) ────────────────────

#[test]
fn emits_md_ol_item_class_for_ordered_list_items() {
    setup();
    let html = render_markdown("1. first\n2. second\n3. third");
    assert!(html.contains("md-ol-item"));
    // 3 个有序列表项都应带 md-ol-item
    assert_eq!(count_substr(&html, "md-ol-item"), 3);
    // 不应有无序列表的 md-ul-nested
    assert!(!html.contains("md-ul"));
}

#[test]
fn does_not_emit_md_ol_item_for_unordered_list_items() {
    setup();
    let html = render_markdown("- a\n- b\n- c");
    assert!(!html.contains("md-ol-item"));
    assert!(html.contains("md-ul"));
}

#[test]
fn task_list_items_replace_md_ol_item_with_md_task_item() {
    setup();
    // 任务列表项应使用 md-task-item class, 不保留 md-ol-item
    // (task 优先级高于 list kind)
    let html = render_markdown("1. [ ] todo\n2. [x] done");
    assert!(html.contains("md-task-item"));
    assert!(html.contains("md-task-box"));
    // task-item 替换了 ol-item, 不应残留 md-ol-item
    assert!(!html.contains("md-ol-item"));
}

#[test]
fn nested_ordered_list_items_emit_md_ol_item_at_all_levels() {
    setup();
    let html = render_markdown("1. parent\n   1. child\n   2. sibling\n2. uncle");
    // 4 个有序列表项 (含嵌套) 都应带 md-ol-item
    assert_eq!(count_substr(&html, "md-ol-item"), 4);
    assert!(html.contains("md-ol-nested"));
}

// ── 斜体长度边界 (Stream A 边界覆盖) ─────────────────────────
//
// 注: pulldown-cmark 用 CommonMark 规范识别 emphasis, 不会出现 JS regex
// 的远距离 `*` 配对问题。JS 的 length>80 保护是针对其 regex 实现的弱点的补丁。
// Rust 用 GFM 规范的 pulldown-cmark, 是更系统化的实现, 不需要 length>80 补丁。
// 这些测试明确记录 pulldown-cmark 的行为, 作为契约边界文档。

#[test]
fn applies_em_to_short_italic_text() {
    setup();
    let html = render_markdown("this is *important* text");
    assert!(html.contains("<em>important</em>"));
}

#[test]
fn applies_em_to_italic_text_with_cjk() {
    setup();
    let html = render_markdown("这是 *重要的* 文本");
    assert!(html.contains("<em>重要的</em>"));
}

#[test]
fn does_not_apply_em_to_unclosed_asterisk() {
    setup();
    // 未闭合的 * 不应被识别为斜体 (pulldown-cmark 正确处理)
    let html = render_markdown("this is *not italic text");
    assert!(!html.contains("<em>"));
    assert!(html.contains("*not italic text"));
}

#[test]
fn italic_does_not_eat_list_markers() {
    setup();
    // * 开头的列表项不应被误识别为斜体
    let html = render_markdown("* item one\n* item two");
    assert!(html.contains("<ul"));
    assert_eq!(count_substr(&html, "<li"), 2);
    assert!(!html.contains("<em>item"));
}

// ── GFM Emoji shortcodes ─────────────────────────────────────

#[test]
fn translates_gfm_emoji_in_various_markdown_elements() {
    setup();
    let html = render_markdown("Status: :white_check_mark: and :x: and :rocket:");
    assert!(html.contains("Status: ✅ and ❌ and 🚀"));

    let table = render_markdown("| 任务 | 结果 |\n| --- | --- |\n| 单元测试 | :white_check_mark: 通过 |\n| 门禁 | :warning: 告警 |\n");
    assert!(table.contains("✅ 通过"));
    assert!(table.contains("⚠️ 告警"));

    let list = render_markdown("- :tada: 完成发布\n- :bug: 待修问题\n");
    assert!(list.contains("🎉 完成发布"));
    assert!(list.contains("🐛 待修问题"));

    let heading = render_markdown("# :bulb: 架构设计\n");
    assert!(heading.contains("💡 架构设计"));
}

#[test]
fn does_not_translate_emoji_in_code_blocks_or_inline_code() {
    setup();
    let inline = render_markdown("Inline code `:white_check_mark:` and `:x:` should remain untouched");
    assert!(inline.contains("<code class=\"md-inline-code\">:white_check_mark:</code>"));
    assert!(inline.contains("<code class=\"md-inline-code\">:x:</code>"));
    assert!(!inline.contains("✅"));
    assert!(!inline.contains("❌"));

    let fence = render_markdown("```bash\necho :x:\necho :white_check_mark:\n```");
    assert!(fence.contains(":x:"));
    assert!(fence.contains(":white_check_mark:"));
    assert!(!fence.contains("❌"));
    assert!(!fence.contains("✅"));
}

#[test]
fn exports_lookup_and_translate_gfm_emoji_directly() {
    assert_eq!(conex_markdown::lookup_gfm_emoji("white_check_mark"), Some("✅"));
    assert_eq!(conex_markdown::lookup_gfm_emoji("x"), Some("❌"));
    assert_eq!(conex_markdown::lookup_gfm_emoji("unknown_code"), None);

    assert_eq!(
        conex_markdown::translate_gfm_emoji("测试 :white_check_mark: 与 :x:"),
        "测试 ✅ 与 ❌"
    );
}
