use conex_compaction::structured_summary_template;

#[test]
fn structured_summary_template_sections() {
    let template = structured_summary_template(&[], None);
    for section in [
        "## Goal",
        "## Constraints",
        "## Progress",
        "## Key Decisions",
        "## Next Steps",
        "## Critical Context",
    ] {
        assert!(template.contains(section), "模板须含 {section} 节");
    }
    let merged = structured_summary_template(&[], Some("OLD"));
    assert!(merged.starts_with("OLD"));
    assert!(template.contains("(none)"));
}
