//! DOMSnapshot 响应重建增强树（字符串池解析 + 布局绑定 + AX 合并）。

use super::frames::mark_owner_iframe;
use super::*;

/// AX value 中提取布尔属性（focusable/disabled 等；"true"/"false"/bool 容错）。
fn ax_bool(value: &crate::cdp::domains::AXValue) -> bool {
    match value.value.as_ref() {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s.eq_ignore_ascii_case("true"),
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0) != 0,
        _ => false,
    }
}

/// 文本节点类型（CDP nodeType：1=element，3=text，9=document）。
const NODE_TYPE_ELEMENT: i64 = 1;
const NODE_TYPE_TEXT: i64 = 3;
const NODE_TYPE_DOCUMENT: i64 = 9;

/// 字符串池解析 + 布局绑定 + AX 合并 → 增强树（§1.2/§1.4）。
///
/// 以 DOMSnapshot 的 documents 数组重建（`parent_index` 定父、字符串池定名、
/// layout 定 bounds、AX 按 backendDOMNodeId 合并）；每文档一棵根树。
/// 同源 iframe 子树（pierce 后 DOMSnapshot 给出 contentDocument）以独立根树
/// 呈现并标注 `|IFRAME|` 占位（跨文档挂接所需 contentDocumentIndex 字段在
/// 现有 domains 类型面未暴露，挂接细节留 e2e 实证；U-4 跨域递归为二期）。
/// DOM.getDocument 结构通道在本实现中作 backendNodeId 兜底校验输入（当前
/// 重建不消费该参数；结构通道载荷超预算时由采集层降级为默认占位传入）。
pub fn build_enhanced_tree(
    capture: &CaptureSnapshotResult,
    _document: &GetDocumentResult,
    ax: &[AXNode],
) -> Vec<EnhancedNode> {
    let strings = &capture.strings;

    // —— AX 索引：backendDOMNodeId → AX 节点（§1.4 去重：同 id 取首条）——
    let mut ax_by_id: HashMap<i64, &AXNode> = HashMap::new();
    for node in ax {
        if let Some(id) = node.backend_d_o_m_node_id {
            ax_by_id.entry(id).or_insert(node);
        }
    }

    let mut roots = Vec::new();
    let documents = capture.documents.iter().take(MAX_IFRAMES);

    for doc in documents {
        let nodes = &doc.nodes;
        // —— 布局索引：node_index → bounds（预构建 HashMap 防 O(n²)）——
        let layout_by_node: HashMap<i64, Bounds> = doc
            .layout
            .node_index
            .iter()
            .zip(doc.layout.bounds.iter())
            .filter_map(|(idx, v)| {
                let arr = v.as_array()?;
                if arr.len() < 4 {
                    return None;
                }
                let get = |i: usize| arr.get(i).and_then(|x| x.as_f64()).unwrap_or(0.0);
                Some((
                    *idx,
                    Bounds {
                        x: get(0),
                        y: get(1),
                        width: get(2),
                        height: get(3),
                    },
                ))
            })
            .collect();

        // —— 父索引 → 子索引邻接表 ——
        let mut children_of: HashMap<i64, Vec<i64>> = HashMap::new();
        for (i, parent) in nodes.parent_index.iter().enumerate() {
            if *parent >= 0 && *parent != i as i64 {
                children_of.entry(*parent).or_default().push(i as i64);
            }
        }

        let mut built: HashMap<i64, EnhancedNode> = HashMap::new();
        let mut order: Vec<i64> = Vec::new();

        // 后序构建（子先于父）；根节点（parent=-1）逐一构建
        for (i, parent) in nodes.parent_index.iter().enumerate() {
            let idx = i as i64;
            if *parent >= 0 && *parent != idx {
                continue;
            }
            build_node(
                idx,
                strings,
                nodes,
                &layout_by_node,
                &ax_by_id,
                &children_of,
                &mut built,
                &mut order,
            );
        }

        for idx in order {
            if let Some(n) = built.remove(&idx) {
                roots.push(n);
            }
        }
    }
    roots
}

/// 递归构建单个节点（后序：先子后父；同一 backendNodeId 重复出现取首条）。
#[allow(clippy::too_many_arguments)]
fn build_node(
    idx: i64,
    strings: &[String],
    nodes: &SnapshotNode,
    layout: &HashMap<i64, Bounds>,
    ax: &HashMap<i64, &AXNode>,
    children_of: &HashMap<i64, Vec<i64>>,
    built: &mut HashMap<i64, EnhancedNode>,
    order: &mut Vec<i64>,
) {
    if built.contains_key(&idx) {
        return;
    }
    let ntype = nodes.node_type.get(idx as usize).copied().unwrap_or(0);
    let name = str_at(strings, node_name_idx(nodes, idx));
    let backend = nodes
        .backend_dom_node_id
        .as_ref()
        .and_then(|v| v.get(idx as usize))
        .copied()
        .unwrap_or(-idx);

    let mut node = match ntype {
        NODE_TYPE_TEXT => {
            EnhancedNode::text_node(str_at(strings, node_value_idx(nodes, idx)), backend)
        }
        NODE_TYPE_ELEMENT | NODE_TYPE_DOCUMENT => {
            let mut e = EnhancedNode::element(&name.to_ascii_lowercase(), backend);
            // 属性对（[nameIdx, valueIdx, ...]）
            if let Some(attrs) = nodes.attributes.as_ref().and_then(|v| v.get(idx as usize)) {
                let mut it = attrs.iter();
                while let (Some(ni), Some(vi)) = (it.next(), it.next()) {
                    let n = str_at(strings, *ni).to_string();
                    let v = str_at(strings, *vi).to_string();
                    e.attributes.push((n, v));
                }
            }
            // iframe 元素恒打 |IFRAME| 标记（13 §1.5/§3.2：iframe 元素本身在
            // 序列化中以 |IFRAME| 占位呈现，一期即生效）。真实 Chrome 主采集
            // DOMSnapshot 已含跨域帧文档（2026-08-12 双本地服务器实测：关闭态
            // 根树即含跨域子文档），跨域递归仅是 frameId 不在文档集的防御路径
            // ——标记不能只依赖递归路径的 mark_owner_iframe。
            if e.tag.as_deref() == Some("iframe") {
                e.frame_marker = Some(FrameMarker::Iframe);
            }
            // 计算样式（styles 池未在现有 domains 类型面暴露时跳过；e2e 实证）
            e
        }
        // 其他节点类型（注释节点等）以元素形态兜底入树
        _ => EnhancedNode::element(str_at(strings, node_name_idx(nodes, idx)), backend),
    };

    // 布局绑定（CSS 像素；bounds 数组 [x, y, width, height]）
    if let Some(b) = layout.get(&idx) {
        node.bounds = Some(*b);
    }

    // AX 合并（§1.4：以 backendDOMNodeId 为键；D3：value/valuetext 在合并阶段即清除）
    if let Some(ax_node) = ax.get(&node.backend_node_id) {
        let props = &mut node.ax;
        props.present = true;
        props.ignored = ax_node.ignored.unwrap_or(false);
        if let Some(role) = ax_node.role.as_ref() {
            if let Some(serde_json::Value::String(s)) = role.value.as_ref() {
                props.role = Some(s.clone());
            }
        }
        if let Some(name) = ax_node.name.as_ref() {
            if let Some(serde_json::Value::String(s)) = name.value.as_ref() {
                props.name = Some(s.clone());
            }
        }
        if let Some(properties) = ax_node.properties.as_ref() {
            for p in properties {
                let is_true = ax_bool(&p.value);
                match p.name.as_str() {
                    "focusable" => props.properties.focusable = is_true,
                    "editable" => props.properties.editable = is_true,
                    "settable" => props.properties.settable = is_true,
                    "checked" => props.properties.checked = is_true,
                    "expanded" => props.properties.expanded = is_true,
                    "pressed" => props.properties.pressed = is_true,
                    "selected" => props.properties.selected = is_true,
                    "required" => props.properties.required = is_true,
                    "autocomplete" => props.properties.autocomplete = is_true,
                    "keyshortcuts" => props.properties.keyshortcuts = is_true,
                    "disabled" => props.properties.disabled = is_true,
                    "hidden" => props.properties.hidden = is_true,
                    // D3：value/valuetext 不流入增强节点
                    _ => {}
                }
            }
        }
    }

    // 子节点（后序挂接）
    if let Some(kids) = children_of.get(&idx) {
        for &kid in kids {
            if !built.contains_key(&kid) {
                build_node(kid, strings, nodes, layout, ax, children_of, built, order);
            }
            if let Some(child) = built.remove(&kid) {
                node.children.push(child);
            }
        }
    }

    built.insert(idx, node);
    order.push(idx);
}

/// 节点名索引（字符串池下标；负数/越界 → -1）。
fn node_name_idx(nodes: &SnapshotNode, idx: i64) -> i64 {
    nodes.node_name.get(idx as usize).copied().unwrap_or(-1)
}

/// 节点值索引（文本节点内容；负数/越界 → -1）。
fn node_value_idx(nodes: &SnapshotNode, idx: i64) -> i64 {
    nodes.node_value.get(idx as usize).copied().unwrap_or(-1)
}

/// 字符串池索引 → 文本（负数/越界返回空串）。
fn str_at(strings: &[String], idx: i64) -> &str {
    strings.get(idx as usize).map(|s| s.as_str()).unwrap_or("")
}
