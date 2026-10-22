//! project_tree 渲染：树文本 + 折叠计数

use super::cache::{TreeEntry, TreeNode};
use super::params::ProjectTreeParams;
use super::MAX_LINE_CHARS;

/// 渲染结果（文本 + 计数，单一权威面：JSON 与摘要行同源）
pub(super) struct RenderOutcome {
    pub(super) text: String,
    pub(super) shown: usize,
    pub(super) collapsed: usize,
    pub(super) truncated: bool,
}

/// 渲染树文本 + 折叠（maxItems / maxDepthContent 均为渲染期参数）。
///
/// 折叠不变量：shown + collapsed = 树内全部节点（dirs + files）——
/// 折叠行的 `(+N)` 只作标记不计入 shown，被折叠节点恒计入 collapsed。
pub(super) fn render_tree(entry: &TreeEntry, params: &ProjectTreeParams) -> RenderOutcome {
    let mut st = RenderState {
        out: Vec::new(),
        shown: 0,
        collapsed: 0,
        truncated: false,
        budget: params.max_items,
        max_depth_content: params.max_depth_content,
    };
    let root_line = if entry.root_is_dir {
        format!("{}/", entry.root_display)
    } else {
        entry.root_display.clone()
    };
    st.out.push(root_line);
    if !entry.children.is_empty() {
        render_children(&mut st, "", &entry.children, 1);
    }
    let shown = st.shown;
    let collapsed = st.collapsed;
    let truncated = st.truncated;
    debug_assert_eq!(
        shown + collapsed,
        entry.dirs + entry.files,
        "折叠不变量：shown + collapsedNodes = dirs + files"
    );
    st.out.push(String::new());
    st.out.push(format!("root: {}", entry.root_display));
    st.out.push(format!("depth: {}", params.depth));
    st.out.push(format!(
        "dirs: {}, files: {}, shown: {}, collapsedNodes: {}, truncated: {}",
        entry.dirs, entry.files, shown, collapsed, truncated
    ));
    RenderOutcome {
        text: st.out.join("\n"),
        shown,
        collapsed,
        truncated,
    }
}

/// 渲染期状态
struct RenderState {
    out: Vec<String>,
    shown: usize,
    collapsed: usize,
    truncated: bool,
    budget: usize,
    max_depth_content: usize,
}

/// 渲染一层子节点（`depth` = 本层节点的显示深度，根的直接子节点 = 1）
fn render_children(st: &mut RenderState, prefix: &str, nodes: &[TreeNode], depth: usize) {
    let n = nodes.len();
    for (i, node) in nodes.iter().enumerate() {
        if st.shown >= st.budget {
            // maxItems 预算耗尽：本层剩余节点（含各自子树）折叠
            let rest: usize = nodes[i..].iter().map(|nd| nd.size).sum();
            st.collapsed += rest;
            st.truncated = true;
            let last = i == n - 1;
            let branch = if last { "└── " } else { "├── " };
            st.out
                .push(format!("{prefix}{branch}... (+{rest} 项未展开)"));
            return;
        }
        let last = i == n - 1;
        let branch = if last { "└── " } else { "├── " };
        // 行宽约束（≤120）作用于整行：前缀 + 分支 + 名称（char 边界）
        let prefix_chars = prefix.chars().count();
        let name_budget = MAX_LINE_CHARS.saturating_sub(prefix_chars + 4);
        let name = truncate_name(&node.name, name_budget);
        let deep_fold = node.is_dir && depth > st.max_depth_content && !node.children.is_empty();
        if deep_fold {
            // 超深目录：以 (+N) 统计行替代展开（N = 该目录子树节点数 - 自身）
            let cnt = node.size - 1;
            st.collapsed += cnt;
            st.out.push(format!("{prefix}{branch}{name}/ (+{cnt} 项)"));
            st.shown += 1;
        } else {
            let suffix = if node.is_dir { "/" } else { "" };
            st.out.push(format!("{prefix}{branch}{name}{suffix}"));
            st.shown += 1;
            if node.is_dir && !node.children.is_empty() {
                let child_prefix = format!("{prefix}{}", if last { "    " } else { "│   " });
                render_children(st, &child_prefix, &node.children, depth + 1);
            }
        }
    }
}

/// 单行超宽截断：整行（前缀+分支+名称）不得超 [MAX_LINE_CHARS]，
/// 名称预算按 char 边界截断，超限取预算 - 1 + `…`
fn truncate_name(name: &str, budget: usize) -> String {
    let len = name.chars().count();
    if len <= budget {
        return name.to_string();
    }
    if budget == 0 {
        return "…".to_string();
    }
    let head: String = name.chars().take(budget - 1).collect();
    format!("{head}…")
}
