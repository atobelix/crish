//! 增强节点中间表示（Bounds/StyleInfo/AxInfo/AxProperties/FrameMarker/EnhancedNode）。

use super::*;

/// 布局 bounds（坐标 + 尺寸，CSS 像素；设备像素 ÷ DPR 换算）。
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    /// 零尺寸（§2.3 排除：宽或高为 0 且无滚动内容）。
    pub fn is_zero(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }

    /// 大 iframe 判定（S7：宽高均 > 100px）。
    pub fn is_big_iframe(&self) -> bool {
        self.width > 100.0 && self.height > 100.0
    }

    /// 图标尺寸（M3：10px ≤ 宽高 ≤ 50px）。
    pub fn is_icon_size(&self) -> bool {
        (10.0..=50.0).contains(&self.width) && (10.0..=50.0).contains(&self.height)
    }

    /// 包含比例（容器折叠用：other 被本矩形包含的面积比例，0-1）。
    pub fn containment(&self, other: &Bounds) -> f64 {
        if other.width <= 0.0 || other.height <= 0.0 || self.width <= 0.0 || self.height <= 0.0 {
            return 0.0;
        }
        let ix = ((self.x + self.width).min(other.x + other.width) - self.x.max(other.x)).max(0.0);
        let iy =
            ((self.y + self.height).min(other.y + other.height) - self.y.max(other.y)).max(0.0);
        (ix * iy) / (other.width * other.height)
    }
}

/// 计算样式子集（§1.3 白名单中判定/序列化用到的子集）。
#[derive(Debug, Clone, Default)]
pub struct StyleInfo {
    pub display: Option<String>,
    pub visibility: Option<String>,
    pub opacity: Option<f64>,
    /// overflow/overflow-x/overflow-y 合并值（任一非 visible → 可滚动候选）
    pub overflow: Option<String>,
    pub cursor: Option<String>,
    pub pointer_events: Option<String>,
    pub position: Option<String>,
    pub background_color: Option<String>,
}

impl StyleInfo {
    /// 隐藏判定（P3）：display:none / visibility:hidden / opacity≤0。
    pub fn is_hidden(&self) -> bool {
        self.display
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("none"))
            || self
                .visibility
                .as_deref()
                .is_some_and(|v| v.eq_ignore_ascii_case("hidden"))
            || self.opacity.is_some_and(|o| o <= 0.0)
    }

    /// 可滚动候选（W2）：overflow 任一值非 visible/clip。
    pub fn scroll_candidate(&self) -> bool {
        self.overflow
            .as_deref()
            .is_some_and(|v| !v.eq_ignore_ascii_case("visible") && !v.eq_ignore_ascii_case("clip"))
    }

    /// 背景不透明（绘制序过滤用：background-color 非 transparent 且 opacity ≥ 0.8）。
    pub fn bg_opaque(&self) -> bool {
        let opaque_color = self
            .background_color
            .as_deref()
            .is_some_and(|c| !c.eq_ignore_ascii_case("transparent") && !c.is_empty());
        let opaque_alpha = self.opacity.unwrap_or(1.0) >= 0.8;
        opaque_color && opaque_alpha
    }

    /// cursor:pointer（W1 弱信号）。
    pub fn cursor_pointer(&self) -> bool {
        self.cursor
            .as_deref()
            .is_some_and(|v| v.eq_ignore_ascii_case("pointer"))
    }
}

/// AX 合并信息（§1.4：DOM 属性 + AX name/role/properties + 布局数据三合一）。
#[derive(Debug, Clone, Default)]
pub struct AxInfo {
    /// AX 树中是否有对应节点（false = AX 通道无数据，相应规则不生效）
    pub present: bool,
    /// AX ignored（装饰性节点，P5 排除）
    pub ignored: bool,
    /// AX role（S4）
    pub role: Option<String>,
    /// 可访问名称（名称提取优先链：AX name → aria-label → title → placeholder → 文本）
    pub name: Option<String>,
    /// AX 交互属性（S5）
    pub properties: AxProperties,
}

/// AX 交互属性集合（S5：任一为真即强正信号）。
#[derive(Debug, Clone, Default)]
pub struct AxProperties {
    pub focusable: bool,
    pub editable: bool,
    pub settable: bool,
    pub checked: bool,
    pub expanded: bool,
    pub pressed: bool,
    pub selected: bool,
    pub required: bool,
    pub autocomplete: bool,
    pub keyshortcuts: bool,
    pub disabled: bool,
    pub hidden: bool,
}

impl AxProperties {
    /// S5 判定：任一交互属性为真。
    pub fn any_interactive(&self) -> bool {
        self.focusable
            || self.editable
            || self.settable
            || self.checked
            || self.expanded
            || self.pressed
            || self.selected
            || self.required
            || self.autocomplete
            || self.keyshortcuts
    }
}

/// 帧/影子标记（§3.2：`|IFRAME|`/`|SHADOW(open|closed)|`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameMarker {
    Iframe,
    ShadowOpen,
    ShadowClosed,
}

/// 增强节点（采集合并产物：DOM 域数据 + AX 合并 + 样式/布局）。
///
/// 构造输入路径：测试与引擎侧用 `EnhancedNode::element` 等构造器直接构建
/// 确定性树（fixture JSON / 内部数据结构）；真实采集路径由 `build_enhanced_tree`
/// 从 CDP 响应重建。
#[derive(Debug, Clone)]
pub struct EnhancedNode {
    /// backendNodeId（CDP 会话内全局唯一，直接作默认模型索引）
    pub backend_node_id: i64,
    /// 元素标签（小写）；None = 文本节点（tag 为空时 text 为内容）
    pub tag: Option<String>,
    pub attributes: Vec<(String, String)>,
    /// 文本节点内容（元素节点为 None；元素文本由直接子文本节点拼接）
    pub text: Option<String>,
    pub ax: AxInfo,
    pub styles: StyleInfo,
    pub bounds: Option<Bounds>,
    /// 可滚动（overflow* 样式或显式标注）
    pub scrollable: bool,
    /// 是否处于 SVG 子树（P6/S8；svg 根自身为 false，构造时从父继承）
    pub in_svg: bool,
    pub frame_marker: Option<FrameMarker>,
    /// 是否含 JS click 类监听器（getEventListeners 探测通道；默认关闭 T-4）
    pub has_click_listener: bool,
    pub children: Vec<EnhancedNode>,
}

impl EnhancedNode {
    /// 元素节点构造（构造输入入口）。
    pub fn element(tag: &str, backend_node_id: i64) -> Self {
        EnhancedNode {
            backend_node_id,
            tag: Some(tag.to_ascii_lowercase()),
            attributes: Vec::new(),
            text: None,
            ax: AxInfo::default(),
            styles: StyleInfo::default(),
            bounds: None,
            scrollable: false,
            in_svg: false,
            frame_marker: None,
            has_click_listener: false,
            children: Vec::new(),
        }
    }

    /// 文本节点构造（tag=None）。
    pub fn text_node(text: &str, backend_node_id: i64) -> Self {
        EnhancedNode {
            backend_node_id,
            tag: None,
            attributes: Vec::new(),
            text: Some(text.to_string()),
            ax: AxInfo::default(),
            styles: StyleInfo::default(),
            bounds: None,
            scrollable: false,
            in_svg: false,
            frame_marker: None,
            has_click_listener: false,
            children: Vec::new(),
        }
    }

    /// 追加属性（构造输入）。
    pub fn attr(mut self, name: &str, value: &str) -> Self {
        self.attributes.push((name.to_string(), value.to_string()));
        self
    }

    /// 设置 bounds（构造输入）。
    pub fn bounds(mut self, x: f64, y: f64, width: f64, height: f64) -> Self {
        self.bounds = Some(Bounds {
            x,
            y,
            width,
            height,
        });
        self
    }

    /// 设置可见样式（构造输入）。
    pub fn style(mut self, name: &str, value: &str) -> Self {
        match name {
            "display" => self.styles.display = Some(value.to_string()),
            "visibility" => self.styles.visibility = Some(value.to_string()),
            "opacity" => self.styles.opacity = value.parse().ok(),
            "overflow" => self.styles.overflow = Some(value.to_string()),
            "cursor" => self.styles.cursor = Some(value.to_string()),
            "pointer-events" => self.styles.pointer_events = Some(value.to_string()),
            "position" => self.styles.position = Some(value.to_string()),
            "background-color" => self.styles.background_color = Some(value.to_string()),
            _ => {}
        }
        self
    }

    /// 设置 AX role（构造输入）。
    pub fn ax_role(mut self, role: &str) -> Self {
        self.ax.present = true;
        self.ax.role = Some(role.to_string());
        self
    }

    /// 设置 AX 交互属性（构造输入）。
    pub fn ax_prop(mut self, name: &str, value: bool) -> Self {
        self.ax.present = true;
        let p = &mut self.ax.properties;
        match name {
            "focusable" => p.focusable = value,
            "editable" => p.editable = value,
            "settable" => p.settable = value,
            "checked" => p.checked = value,
            "expanded" => p.expanded = value,
            "pressed" => p.pressed = value,
            "selected" => p.selected = value,
            "required" => p.required = value,
            "autocomplete" => p.autocomplete = value,
            "keyshortcuts" => p.keyshortcuts = value,
            "disabled" => p.disabled = value,
            "hidden" => p.hidden = value,
            _ => {}
        }
        self
    }

    /// 设置 AX ignored（构造输入）。
    pub fn ax_ignored(mut self) -> Self {
        self.ax.present = true;
        self.ax.ignored = true;
        self
    }

    /// 设置滚动性（构造输入）。
    pub fn scrollable(mut self) -> Self {
        self.scrollable = true;
        self
    }

    /// 设置 SVG 子树标记（构造输入；svg 根自身不设）。
    pub fn svg_child(mut self) -> Self {
        self.in_svg = true;
        self
    }

    /// 设置帧/影子标记（构造输入）。
    pub fn marker(mut self, m: FrameMarker) -> Self {
        self.frame_marker = Some(m);
        self
    }

    /// 设置 JS click 类监听器（getEventListeners 探测通道，T-4 默认关闭）。
    pub fn listener(mut self) -> Self {
        self.has_click_listener = true;
        self
    }

    /// 追加子节点（构造输入）。
    pub fn push(mut self, child: EnhancedNode) -> Self {
        self.children.push(child);
        self
    }

    /// 读取属性（大小写不敏感）。
    pub fn get_attr(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// 是否为文本节点。
    pub fn is_text(&self) -> bool {
        self.tag.is_none()
    }

    /// 直接子文本拼接（元素行内联文本）。
    pub fn inline_text(&self) -> String {
        self.children
            .iter()
            .filter(|c| c.is_text())
            .filter_map(|c| c.text.as_deref())
            .collect()
    }

    /// 子树探测（≤ max_depth 层，含自身）是否存在满足谓词的节点（M1/W2 探测；
    /// 直接递归实现，避免泛型闭包的类型级递归）。
    pub fn subtree_has(&self, max_depth: usize, pred: &impl Fn(&EnhancedNode) -> bool) -> bool {
        if pred(self) {
            return true;
        }
        if max_depth == 0 {
            return false;
        }
        self.children
            .iter()
            .any(|c| c.subtree_has(max_depth - 1, pred))
    }

    /// 预遍历（前序；含自身）。
    pub fn walk(&self, f: &mut impl FnMut(&EnhancedNode)) {
        f(self);
        for c in &self.children {
            c.walk(f);
        }
    }

    /// 后序遍历（含自身；父节点在子节点之后访问，供「无任何可交互后代」统计）。
    pub fn walk_post(&self, f: &mut impl FnMut(&EnhancedNode)) {
        for c in &self.children {
            c.walk_post(f);
        }
        f(self);
    }

    /// 是否为可判定的元素节点（文本/文档根不参与可交互判定，P1 前置）。
    pub fn is_element_candidate(&self) -> bool {
        !self.is_text()
            && self.tag.as_deref() != Some("#document")
            && self.tag.as_deref() != Some("html")
            && self.tag.as_deref() != Some("body")
    }
}
