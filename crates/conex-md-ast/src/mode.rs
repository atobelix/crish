//! MD 模式面与 normalize（**W2-A 扩表**）。
//!
//! # API（对齐 plans/03 §3.4）
//! - [`MdMode`]：`Conex` | `PureGfm`
//! - [`parse_md`] / [`serialize_md`]：一等 mode，非仅 strip 辅助
//! - [`normalize_md`]：N1–N3 最低集（行尾空格 / EOF 换行 / 无序标记统一 `-`）
//!
//! # 诚实边界
//! - **已交付**：mode 一等面 + normalize 可测；pure-gfm 剥 ID 时 lossy 可列举
//! - **未关闭**：**≠ A-MD-01 全集** / **≠ A-MD-05 全 diff 表** / **≠ EL-06**
//! - 默认 [`crate::parse_document`] / [`crate::serialize_tree`] 仍为 **conex + 发 ID**

use crate::{
    BlockTree, LossyReport, MdError, ParseOutput, parse_document_detailed, serialize_tree,
    strip_conex_id_comments_detailed,
};

/// 契约模式：`conex` 保留/识别 `<!--c:UUID-->`；`pure_gfm` 剥 ID 并记 lossy。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MdMode {
    /// Conex-MD：机器 ID 注释一等；Agent `get_md` 默认此模式。
    #[default]
    Conex,
    /// pure-gfm：序列化不发射 ID；解析前剥离 ID 注释；有损可列举。
    PureGfm,
}

/// 解析选项（plans/03 `ParseOpts`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseOpts {
    pub mode: MdMode,
    /// 预留：严格要求每块有合法 ID（当前未强制失败，仅文档钉桩）。
    pub strict_ids: bool,
}

impl Default for ParseOpts {
    fn default() -> Self {
        Self {
            mode: MdMode::Conex,
            strict_ids: false,
        }
    }
}

/// 序列化选项（plans/03 `SerializeOpts`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SerializeOpts {
    pub mode: MdMode,
    /// `true` 时发射 `<!--c:UUID-->`（仅 `MdMode::Conex` 生效；PureGfm 强制不发射）。
    pub emit_ids: bool,
}

impl Default for SerializeOpts {
    fn default() -> Self {
        Self {
            mode: MdMode::Conex,
            emit_ids: true,
        }
    }
}

/// 带 mode 的解析入口。
///
/// - [`MdMode::Conex`]：等同 [`parse_document_detailed`]
/// - [`MdMode::PureGfm`]：先剥 `<!--c:…-->`（lossy `stripped_block_ids*`），再 parse
///   （缺 ID 再记 `missing_block_id`）
///
/// **≠ EL-06**；**≠ A-MD-01 全集**。
pub fn parse_md(md: &str, opts: ParseOpts) -> Result<ParseOutput, MdError> {
    match opts.mode {
        MdMode::Conex => parse_document_detailed(md),
        MdMode::PureGfm => {
            let (stripped, strip_report) = strip_conex_id_comments_detailed(md);
            let mut out = parse_document_detailed(&stripped)?;
            // strip 在前，parse lossy 接后（调用方可枚举差集）
            let mut items = strip_report.items;
            items.append(&mut out.lossy.items);
            out.lossy.items = items;
            // strict_ids 预留：PureGfm 下天然缺 ID，不因本旗标失败
            let _ = opts.strict_ids;
            Ok(out)
        }
    }
}

/// 带 mode 的序列化入口。
///
/// - Conex + `emit_ids=true`：即时 S，含 ID（与 [`serialize_tree`] 同形）
/// - PureGfm **或** `emit_ids=false`：剥 ID + `stripped_block_ids` lossy
///
/// **≠ EL-06**；**≠ A-MD-05 工具面满挂**（本 API 仅契约层 S(mode)）。
pub fn serialize_md(
    tree: &BlockTree,
    opts: SerializeOpts,
) -> Result<(String, LossyReport), MdError> {
    let full = serialize_tree(tree);
    let strip = matches!(opts.mode, MdMode::PureGfm) || !opts.emit_ids;
    if strip {
        let (body, report) = strip_conex_id_comments_detailed(&full);
        Ok((body, report))
    } else {
        Ok((full, LossyReport::default()))
    }
}

/// 源码级 normalize（plans/03 §3.5 最低集 N1–N3）。
///
/// | 规则 | 行为 |
/// | ---- | ---- |
/// | N1 | 行尾空格 strip |
/// | N2 | 非空文件末恰一个 `\n`；空输入保持空 |
/// | N3 | 无序列表行首标记 `*`/`+` → `-`（围栏代码内不改） |
///
/// 幂等：`N(N(x)) = N(x)`。  
/// **不**把丢 ID / 扩展降级算进 N（N7）。
///
/// **≠ EL-06**；**≠ RT-2 全 GFM 核心绿**（仅最低集可测）。
pub fn normalize_md(md: &str) -> String {
    if md.is_empty() {
        return String::new();
    }

    let mut out_lines: Vec<String> = Vec::new();
    let mut in_fence = false;
    // 围栏：行 trim 后以 ``` 或 ~~~ 开头则翻转 in_fence；围栏内不改列表标记
    for line in md.lines() {
        let trimmed_start = line.trim_start();
        let is_fence_delim =
            trimmed_start.starts_with("```") || trimmed_start.starts_with("~~~");
        let inside_before = in_fence;
        if is_fence_delim {
            in_fence = !in_fence;
        }

        // N1：行尾空格
        let mut line = line.trim_end().to_string();

        // N3：仅围栏外内容行统一 `*`/`+` → `-`（开/闭围栏行与围栏内不改）
        if !inside_before && !is_fence_delim {
            line = unify_unordered_marker(&line);
        }

        out_lines.push(line);
    }

    // N2：恰一个 EOF 换行
    let mut body = out_lines.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    body
}

/// 将行首（可含缩进）的 `* ` / `+ ` 列表标记改为 `- `。
fn unify_unordered_marker(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
        i += 1;
    }
    if i + 1 < bytes.len() && (bytes[i] == b'*' || bytes[i] == b'+') && bytes[i + 1] == b' ' {
        let mut s = String::with_capacity(line.len());
        s.push_str(&line[..i]);
        s.push('-');
        s.push_str(&line[i + 1..]);
        return s;
    }
    line.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlockId, BlockKind, encode_block_id_line, structure_eq};
    use std::str::FromStr;

    fn bid(s: &str) -> BlockId {
        BlockId::from_str(s).unwrap()
    }

    #[test]
    fn normalize_strips_trailing_spaces_and_eof() {
        let raw = "hello  \nworld   ";
        let n = normalize_md(raw);
        assert_eq!(n, "hello\nworld\n");
        assert_eq!(normalize_md(&n), n, "N 幂等");
    }

    #[test]
    fn normalize_unifies_bullet_markers_outside_fence() {
        let raw = "* 甲\n+ 乙\n- 丙\n";
        let n = normalize_md(raw);
        assert_eq!(n, "- 甲\n- 乙\n- 丙\n");
        assert_eq!(normalize_md(&n), n);
    }

    #[test]
    fn normalize_preserves_markers_inside_fence() {
        let raw = "```\n* not a list\n```\n* real\n";
        let n = normalize_md(raw);
        assert!(n.contains("* not a list"), "围栏内保留 *：{n}");
        assert!(n.contains("- real"), "围栏外统一 -：{n}");
    }

    #[test]
    fn normalize_empty_stays_empty() {
        assert_eq!(normalize_md(""), "");
        assert_eq!(normalize_md(&normalize_md("")), "");
    }

    #[test]
    fn parse_md_conex_matches_parse_document_detailed() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
段
";
        let a = parse_md(md, ParseOpts::default()).unwrap();
        let b = parse_document_detailed(md).unwrap();
        assert!(structure_eq(&a.tree, &b.tree));
        assert_eq!(a.lossy, b.lossy);
    }

    #[test]
    fn parse_md_pure_gfm_strips_ids_and_reports_lossy() {
        let id = bid("11111111-1111-4111-a111-111111111111");
        let md = format!("{}\n纯 gfm 段\n", encode_block_id_line(&id));
        let out = parse_md(
            &md,
            ParseOpts {
                mode: MdMode::PureGfm,
                strict_ids: false,
            },
        )
        .unwrap();
        assert_eq!(out.tree.root_children.len(), 1);
        // 剥 ID 后重新生成 → 不得保留原 ID
        assert_ne!(out.tree.root_children[0], id);
        let codes: Vec<_> = out.lossy.items.iter().map(|i| i.code.as_str()).collect();
        assert!(
            codes.iter().any(|c| *c == "stripped_block_ids"),
            "pure-gfm 须报 stripped_block_ids，got {codes:?}"
        );
        assert!(
            codes.iter().any(|c| *c == "missing_block_id"),
            "剥 ID 后缺 ID 须报 missing_block_id，got {codes:?}"
        );
        assert_eq!(
            out.tree
                .get(&out.tree.root_children[0])
                .unwrap()
                .text_snapshot
                .as_deref(),
            Some("纯 gfm 段")
        );
    }

    #[test]
    fn serialize_md_pure_gfm_strips_ids() {
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 标题

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
子段
";
        let tree = parse_document_detailed(md).unwrap().tree;
        let (out, report) = serialize_md(
            &tree,
            SerializeOpts {
                mode: MdMode::PureGfm,
                emit_ids: true, // PureGfm 强制剥
            },
        )
        .unwrap();
        assert!(!out.contains("<!--c:"), "pure-gfm S 不得发射 ID：\n{out}");
        assert!(out.contains("# 标题"));
        assert!(out.contains("子段"));
        assert!(
            report
                .items
                .iter()
                .any(|i| i.code == "stripped_block_ids"
                    || i.code == "stripped_block_ids_count"),
            "须 lossy 声明剥 ID，got {:?}",
            report
        );
    }

    #[test]
    fn serialize_md_conex_emit_ids_matches_serialize_tree() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
hello
";
        let tree = parse_document_detailed(md).unwrap().tree;
        let (out, report) = serialize_md(&tree, SerializeOpts::default()).unwrap();
        assert_eq!(out, serialize_tree(&tree));
        assert!(report.is_empty());
    }

    #[test]
    fn serialize_md_emit_ids_false_strips_without_mode_change() {
        let md = "\
<!--c:11111111-1111-4111-a111-111111111111-->
x
";
        let tree = parse_document_detailed(md).unwrap().tree;
        let (out, report) = serialize_md(
            &tree,
            SerializeOpts {
                mode: MdMode::Conex,
                emit_ids: false,
            },
        )
        .unwrap();
        assert!(!out.contains("<!--c:"));
        assert!(out.contains('x'));
        assert!(!report.is_empty());
    }

    #[test]
    fn pure_gfm_roundtrip_structure_without_ids() {
        // pure-gfm：S 无 ID → P 生成新 ID；结构 kind/文本仍可对照（ID 不守恒 —— RT-6）
        let md = "\
<!--c:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-->
# 章

<!--c:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-->
```
code
```
";
        let t1 = parse_document_detailed(md).unwrap().tree;
        let (s_pure, lossy_s) = serialize_md(
            &t1,
            SerializeOpts {
                mode: MdMode::PureGfm,
                emit_ids: true,
            },
        )
        .unwrap();
        assert!(!lossy_s.is_empty());
        let t2 = parse_md(
            &s_pure,
            ParseOpts {
                mode: MdMode::PureGfm,
                ..Default::default()
            },
        )
        .unwrap()
        .tree;
        // kind 指纹：heading + code（code 挂 heading 下）
        assert_eq!(t2.root_children.len(), 1);
        let h = t2.root_children[0];
        assert_eq!(t2.get(&h).unwrap().kind, BlockKind::Heading { level: 1 });
        assert_eq!(t2.get(&h).unwrap().children.len(), 1);
        let c = t2.get(&h).unwrap().children[0];
        assert_eq!(t2.get(&c).unwrap().kind, BlockKind::Code);
        assert_eq!(t2.get(&c).unwrap().text_snapshot.as_deref(), Some("code"));
    }
}
