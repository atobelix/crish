//! D0 residual — fixture parity with apps/crish-desktop TS cases.
//!
//! Keep markdown sources aligned with:
//!   `apps/crish-desktop/src/api/fixtures/markdown-parity-cases.ts`
//!
//! Structural CSS contracts only (not byte-for-byte vs highlight.js).
//! Intentional differences: syntect token spans, language alias display,
//! ammonia sanitize timing — see desktop fixture module comment.

use conex_markdown::{clear_cache, render_markdown};

fn count_substr(s: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return s.len();
    }
    s.matches(needle).count()
}

fn setup() {
    clear_cache();
}

#[test]
fn parity_lists_tight_ul_with_bold() {
    setup();
    let md = "### 改进建议优先级\n\n- **P0** 先修 markdown 重复列表\n- **P1** 表格窄屏换行\n- **P2** 其他 polish";
    let html = render_markdown(md);
    assert!(html.contains("<h3 class=\"md-h3\">改进建议优先级</h3>"));
    assert!(html.contains("<strong>P0</strong>"));
    assert!(html.contains("md-ul"));
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 3);
    assert!(!regex::Regex::new(r"<p[^>]*>\s*<li")
        .unwrap()
        .is_match(&html));
}

#[test]
fn parity_code_fence_language_and_copy_chrome() {
    setup();
    let html = render_markdown("```ts\nconst x = 1;\n```");
    assert!(html.contains("md-code-block"));
    assert!(html.contains("md-code-lang"));
    assert!(html.contains("md-code-copy"));
    assert!(html.contains("md-code-pre"));
    assert!(!html.contains("data-copy="));
    assert!(!html.contains("```"));
    let lang_ok = regex::Regex::new(r"language-(ts|typescript)")
        .unwrap()
        .is_match(&html);
    assert!(lang_ok, "expected language-ts|typescript, got: {html}");
    assert_eq!(count_substr(&html, "md-code-block"), 1);
}

#[test]
fn parity_bold_inline() {
    setup();
    let html = render_markdown("hello **world** and **P0** done");
    assert!(html.contains("<strong>world</strong>"));
    assert!(html.contains("<strong>P0</strong>"));
    assert!(html.contains("hello"));
    assert!(html.contains("done"));
    assert!(!html.contains("**world**"));
    assert!(!html.contains("**P0**"));
    assert_eq!(count_substr(&html, "<strong>"), 2);
}

#[test]
fn parity_list_bold_code_combined() {
    setup();
    let md = "### Title\n\n- **bold item**\n- plain\n\n```js\nconsole.log(1);\n```\n\n**closing**";
    let html = render_markdown(md);
    assert!(html.contains("<h3 class=\"md-h3\">Title</h3>"));
    assert!(html.contains("<strong>bold item</strong>"));
    assert!(html.contains("plain"));
    assert!(html.contains("md-code-block"));
    assert!(html.contains("<strong>closing</strong>"));
    assert!(!html.contains("data-copy="));
    assert!(!html.contains("**bold item**"));
    assert!(!html.contains("**closing**"));
    assert!(
        regex::Regex::new(r"language-(js|javascript)")
            .unwrap()
            .is_match(&html),
        "expected language-js|javascript, got: {html}"
    );
    assert_eq!(count_substr(&html, "<ul"), 1);
    assert_eq!(count_substr(&html, "<li"), 2);
    assert_eq!(count_substr(&html, "md-code-block"), 1);
    assert!(!regex::Regex::new(r"<p[^>]*>\s*<li")
        .unwrap()
        .is_match(&html));
}
