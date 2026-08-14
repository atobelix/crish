//! UIA 结构化感知(04 §2 S2-5 PerceptionSource / 18 §3.3 数据面抑制)。
//!
//! 分层说明:
//! - 数据模型(全平台可编译):[`Rect`] / [`PerceptionNode`] / [`PerceptionSnapshot`],
//!   结构化窗口/控件树 + 边界矩形 + 角色/名称/值,serde 序列化供模型面消费;
//! - 抽象输入 [`RawNode`] + 纯函数 [`build_snapshot`] / [`element_at_point`]:
//!   树遍历解析、深度/节点数截断、密码抑制、命中检测全部在此(不依赖设备,
//!   fixture 可注入单测);
//! - 感知源抽象 [`PerceptionSource`]:快照 + 命中检测两方法,测试注入 mock;
//! - Windows 设备面 [`UiaPerception`](cfg(windows)):windows 0.61.3 直调
//!   `IUIAutomation`(37 报告 Gate-C 实测路径:TreeWalker 深遍历 / ElementFromPoint /
//!   IsPassword / ValuePattern)。
//!
//! 数据面抑制(04 §4.5 / 18 §3.3,对齐 security.rs 登记):
//! - `IsPassword=true` 为判定优先信号:name/value 不落实际字符,
//!   输出 [`security::PASSWORD_PLACEHOLDER`] 占位(长度可记、内容不记);
//! - 名称/值字段过键名模式(password/passwd/pwd/secret/token,大小写不敏感)
//!   命中 → [`security::PASSWORD_REDACTION_PLACEHOLDER`] 脱敏,
//!   复用 [`security::redact_password_field`](crate::security::redact_password_field);
//! - `ElementFromPoint` 命中密码框时文本同样不回传(04 §4.5 联动③)。

use serde::{Deserialize, Serialize};

use crate::security::{redact_password_field, PASSWORD_PLACEHOLDER};

/// 树遍历最大深度(04 §2 S2-5:深度受限 6 层,根为第 0 层)
pub const MAX_TREE_DEPTH: usize = 6;
/// 树遍历最大节点数(04 §2 S2-5:节点数受限 2000)
pub const MAX_TREE_NODES: usize = 2000;
/// 无几何元素(off-screen)的边界矩形
pub const EMPTY_RECT: Rect = Rect {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
};

/// 物理坐标边界矩形(UIA BoundingRectangle 语义:left/top 可负,虚拟桌面原点)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    /// 左边界(物理像素,可负)
    pub left: i32,
    /// 上边界(物理像素,可负)
    pub top: i32,
    /// 右边界(物理像素,开区间)
    pub right: i32,
    /// 下边界(物理像素,开区间)
    pub bottom: i32,
}

impl Rect {
    /// 构造边界矩形
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }

    /// 宽度(右-左,≥0)
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    /// 高度(下-上,≥0)
    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    /// 是否为空矩形(无几何,如 off-screen 元素)
    pub fn is_empty(&self) -> bool {
        self.width() <= 0 || self.height() <= 0
    }

    /// 是否包含物理坐标点(半开区间 [left,right)×[top,bottom))
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

/// 结构化感知节点(模型面输入:角色/名称/值/边界矩形/子节点)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerceptionNode {
    /// 控件角色(归一化小写,如 "window"/"edit"/"button";未知 → "custom")
    pub role: String,
    /// 控件名称(已过数据面抑制;密码框为 `<password>` 占位)
    pub name: String,
    /// 控件值(ValuePattern 或当前文本,已过抑制;无值 = 空串)
    pub value: String,
    /// 物理坐标边界矩形(EMPTY_RECT = 无几何)
    pub rect: Rect,
    /// 密码框标记(IsPassword 判定,供审计层「密码框元素任何字段不落」识别)
    pub is_password: bool,
    /// 子节点(深度/节点数截断后)
    pub children: Vec<PerceptionNode>,
}

impl PerceptionNode {
    /// 构造感知节点(常规路径)
    pub fn new(
        role: impl Into<String>,
        name: impl Into<String>,
        value: impl Into<String>,
        rect: Rect,
        children: Vec<PerceptionNode>,
    ) -> Self {
        Self {
            role: role.into(),
            name: name.into(),
            value: value.into(),
            rect,
            is_password: false,
            children,
        }
    }
}

/// 结构化感知快照(04 §2 S2-5:窗口/控件树 + 截断信息,serde 序列化供模型面)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PerceptionSnapshot {
    /// 根节点(活动窗口或其下的根元素)
    pub root: PerceptionNode,
    /// 实际遍历节点数(截断后)
    pub node_count: usize,
    /// 是否发生截断(深度 / 节点数任一触顶)
    pub truncated: bool,
}

/// 抽象原始节点(设备面读取的 UIA 元素最小数据投影;fixture/测试与设备面共用)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawNode {
    /// 控件角色(归一化小写)
    pub role: String,
    /// 原始名称(未脱敏;设备面直接取自 UIA Name 属性)
    pub name: String,
    /// 原始值(未脱敏;设备面取自 ValuePattern 或当前文本)
    pub value: String,
    /// 物理坐标边界矩形
    pub rect: Rect,
    /// 密码框标记(IsPassword 判定优先信号,判定前不读内容)
    pub is_password: bool,
    /// 子节点(设备面由 TreeWalker 收集)
    pub children: Vec<RawNode>,
}

impl RawNode {
    /// 构造原始节点(测试 fixture 便捷入口)
    pub fn new(
        role: impl Into<String>,
        name: impl Into<String>,
        value: impl Into<String>,
        rect: Rect,
    ) -> Self {
        Self {
            role: role.into(),
            name: name.into(),
            value: value.into(),
            rect,
            is_password: false,
            children: Vec::new(),
        }
    }

    /// 标记为密码框(IsPassword 判定)
    pub fn with_password(mut self) -> Self {
        self.is_password = true;
        self
    }

    /// 追加子节点
    pub fn push(mut self, child: RawNode) -> Self {
        self.children.push(child);
        self
    }
}

/// 感知错误(设备面 / 状态面)
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PerceptionError {
    /// UIA / COM 初始化失败(CoCreateInstance CUIAutomation / TreeWalker 构建)
    #[error("UIA 初始化失败: {0}")]
    Init(String),
    /// 无活动窗口(GetFocusedElement 失败:锁屏 / 无焦点 / 桌面态)
    #[error("无活动窗口(锁屏或无焦点)")]
    NoActiveWindow,
    /// 树遍历失败(属性读取 / 子元素枚举的意外错误)
    #[error("UIA 树遍历失败: {0}")]
    Traverse(String),
}

/// 感知源抽象(04 §2 S2-5 PerceptionSource 面;测试注入 mock,
/// 生产实现为 [`UiaPerception`])
pub trait PerceptionSource {
    /// 结构化感知快照(活动窗口 → 控件树,深度 6 / 节点 2000 截断,
    /// 密码抑制 + 键名脱敏)
    fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError>;
    /// 命中检测(物理坐标):返回命中元素(含抑制后的名称/值);
    /// 未命中(桌面外 / 无元素)返回 `None`
    fn element_from_point(&self, x: i32, y: i32)
        -> Result<Option<PerceptionNode>, PerceptionError>;
}

/// 纯函数:原始节点树 → 感知快照。
///
/// 递归解析执行三条规则:
/// - **深度截断**:节点深度 > [`MAX_TREE_DEPTH`] 时不展开子节点;
/// - **节点数截断**:已访问节点数 ≥ [`MAX_TREE_NODES`] 时停止追加
///   (优先保留高层节点);
/// - **数据面抑制**:`is_password` → name/value 输出 [`PASSWORD_PLACEHOLDER`];
///   其余 name/value 过 [`redact_password_field`] 键名模式脱敏。
///
/// 截断发生时 [`PerceptionSnapshot::truncated`] 置位(模型面可感知不完整)。
pub fn build_snapshot(root: &RawNode) -> PerceptionSnapshot {
    let mut budget = NodeBudget {
        remaining: MAX_TREE_NODES,
        truncated: false,
    };
    let node = convert_node(root, 0, &mut budget);
    PerceptionSnapshot {
        root: node,
        node_count: MAX_TREE_NODES.saturating_sub(budget.remaining),
        truncated: budget.truncated,
    }
}

/// 遍历预算(节点数上限 + 截断标记)
struct NodeBudget {
    /// 剩余可创建节点数(0 = 触顶)
    remaining: usize,
    /// 已发生截断(深度 / 节点数任一)
    truncated: bool,
}

/// 递归转换原始节点 → 感知节点(深度/节点数截断 + 数据面抑制)
fn convert_node(raw: &RawNode, depth: usize, budget: &mut NodeBudget) -> PerceptionNode {
    budget.remaining = budget.remaining.saturating_sub(1);
    // 数据面抑制:密码框(IsPassword 判定优先)与键名模式脱敏
    let (name, value) = suppress(raw);
    // 深度触顶:截断子节点
    if depth >= MAX_TREE_DEPTH {
        if !raw.children.is_empty() {
            budget.truncated = true;
        }
        return PerceptionNode {
            role: raw.role.clone(),
            name,
            value,
            rect: raw.rect,
            is_password: raw.is_password,
            children: Vec::new(),
        };
    }
    let mut children = Vec::new();
    for child in &raw.children {
        if budget.remaining == 0 {
            budget.truncated = true;
            break;
        }
        children.push(convert_node(child, depth + 1, budget));
    }
    PerceptionNode {
        role: raw.role.clone(),
        name,
        value,
        rect: raw.rect,
        is_password: raw.is_password,
        children,
    }
}

/// 数据面抑制(04 §4.5):密码框 → `<password>` 占位;
/// 其余名称/值过键名模式脱敏(`<redacted>`)
fn suppress(raw: &RawNode) -> (String, String) {
    if raw.is_password {
        // IsPassword 判定优先信号:内容不落,仅占位符
        (
            PASSWORD_PLACEHOLDER.to_string(),
            PASSWORD_PLACEHOLDER.to_string(),
        )
    } else {
        // 键名模式脱敏(security.rs 登记表:password/passwd/pwd/secret/token)
        let name = redact_password_field(&raw.name).to_string();
        let value = redact_password_field(&raw.value).to_string();
        (name, value)
    }
}

/// 纯函数:命中检测(物理坐标)。
///
/// 在已构建的感知树中找「包含坐标点」的**最深**节点(与 UIA 的
/// ElementFromPoint 命中最具体元素语义一致);未命中返回 `None`。
/// 供工具层在快照内定位元素 / 测试命中逻辑,设备面命中见
/// [`PerceptionSource::element_from_point`]。
pub fn element_at_point(root: &PerceptionNode, x: i32, y: i32) -> Option<&PerceptionNode> {
    if !root.rect.contains(x, y) {
        return None;
    }
    // 优先深入:子节点中找更深命中;找不到则自身命中
    for child in &root.children {
        if let Some(hit) = element_at_point(child, x, y) {
            return Some(hit);
        }
    }
    Some(root)
}

// ===== Windows 设备面(UIA 直调,37 报告 Gate-C 实测路径) =====

/// UIA 结构化感知设备面(windows 0.61.3 `IUIAutomation` COM 直调)。
///
/// 初始化:CoInitializeEx → CoCreateInstance(CUIAutomation) →
/// CreateTrueCondition → CreateTreeWalker;树遍历用 TreeWalker
/// 深遍历(GetFirstChildElement / GetNextSiblingElement)。
///
/// ## 37 报告 API 陷阱(实测落点)
/// windows 0.61 将 UIA「无子 / 无兄弟」的 NULL 结果包装为 `Err(Error::empty())`
/// (HRESULT 0)——遍历循环把 `Err` 当「无元素」处理(见 [`UiaPerception::children_of`]),
/// 否则首叶即中断。
#[cfg(windows)]
pub struct UiaPerception {
    automation: windows::Win32::UI::Accessibility::IUIAutomation,
    walker: windows::Win32::UI::Accessibility::IUIAutomationTreeWalker,
}

#[cfg(windows)]
impl UiaPerception {
    /// 初始化 UIA 感知源(COM + CUIAutomation + TreeWalker)。
    ///
    /// COM 初始化按「每线程一次」语义:已在别的线程初始化不冲突
    /// (CoInitializeEx 线程局部;失败仅告警不阻断——目标进程多线程场景
    /// 由调用方保证同线程使用)。
    #[allow(unsafe_code)]
    pub fn new() -> Result<Self, PerceptionError> {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
        };
        use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};
        unsafe {
            // COM 线程模型:MTA(与主线程共容;失败如已初始化/模式冲突 → 继续)
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|e| {
                    PerceptionError::Init(format!("CoCreateInstance CUIAutomation: {e}"))
                })?;
            let condition = automation
                .CreateTrueCondition()
                .map_err(|e| PerceptionError::Init(format!("CreateTrueCondition: {e}")))?;
            let walker = automation
                .CreateTreeWalker(&condition)
                .map_err(|e| PerceptionError::Init(format!("CreateTreeWalker: {e}")))?;
            Ok(Self { automation, walker })
        }
    }

    /// 由窗口句柄直接快照(探针 / 白名单窗口场景;hwnd 为 0 → Err)
    #[allow(unsafe_code)]
    pub fn snapshot_window(
        &self,
        hwnd: windows::Win32::Foundation::HWND,
    ) -> Result<PerceptionSnapshot, PerceptionError> {
        if hwnd.is_invalid() {
            return Err(PerceptionError::NoActiveWindow);
        }
        unsafe {
            let root_el = self
                .automation
                .ElementFromHandle(hwnd)
                .map_err(|e| PerceptionError::Traverse(format!("ElementFromHandle: {e}")))?;
            let raw = self.read_node(&root_el, 0);
            Ok(build_snapshot(&raw))
        }
    }

    /// 元素 → 原始节点(属性读取失败宽容降级:名称/值/矩形取空,
    /// 不因单元素属性异常中断整树)
    #[allow(unsafe_code)]
    fn read_node(
        &self,
        el: &windows::Win32::UI::Accessibility::IUIAutomationElement,
        depth: usize,
    ) -> RawNode {
        use windows::Win32::UI::Accessibility::IUIAutomationValuePattern;
        use windows::Win32::UI::Accessibility::{UIA_ValuePatternId, UIA_CONTROLTYPE_ID};
        unsafe {
            // 角色:ControlType → 归一化小写(未知 → "custom")
            let role = el
                .CurrentControlType()
                .map(|ct: UIA_CONTROLTYPE_ID| control_type_role(ct.0).to_string())
                .unwrap_or_else(|_| "custom".to_string());
            // 名称(容错:元素销毁/提权拒绝 → 空)
            let name = el.CurrentName().map(|b| b.to_string()).unwrap_or_default();
            // IsPassword 判定优先信号(判定为真则不再读值)
            let is_password = el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false);
            let mut value = String::new();
            if !is_password {
                // ValuePattern 值(不支持 ValuePattern → 空)
                if let Ok(pattern) =
                    el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                {
                    value = pattern
                        .CurrentValue()
                        .map(|b| b.to_string())
                        .unwrap_or_default();
                }
            }
            // 边界矩形(物理坐标;失败/无几何 → EMPTY_RECT)
            let rect = el
                .CurrentBoundingRectangle()
                .map(|r| Rect::new(r.left, r.top, r.right, r.bottom))
                .unwrap_or(EMPTY_RECT);
            // 深度受限:仅在未触顶时展开子节点
            let children = if depth < MAX_TREE_DEPTH {
                self.collect_children(el, depth)
            } else {
                Vec::new()
            };
            RawNode {
                role,
                name,
                value,
                rect,
                is_password,
                children,
            }
        }
    }

    /// 子元素收集(37 报告陷阱):`GetFirstChildElement / GetNextSiblingElement`
    /// 的 `Err(empty)` 表示「无子/无兄弟」——一律按终止处理;
    /// 其他错误(元素销毁等)同样终止该方向,不中断整树。
    #[allow(unsafe_code)]
    fn collect_children(
        &self,
        el: &windows::Win32::UI::Accessibility::IUIAutomationElement,
        depth: usize,
    ) -> Vec<RawNode> {
        let mut out = Vec::new();
        let mut current = match self.first_child(el) {
            Some(c) => c,
            None => return out,
        };
        loop {
            out.push(self.read_node(&current, depth + 1));
            current = match self.next_sibling(&current) {
                Some(s) => s,
                None => break,
            };
        }
        out
    }

    /// 首个子元素(NULL → Err(empty) → None)
    #[allow(unsafe_code)]
    fn first_child(
        &self,
        el: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    ) -> Option<windows::Win32::UI::Accessibility::IUIAutomationElement> {
        unsafe { self.walker.GetFirstChildElement(el).ok() }
    }

    /// 下一个兄弟元素(NULL → Err(empty) → None)
    #[allow(unsafe_code)]
    fn next_sibling(
        &self,
        el: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    ) -> Option<windows::Win32::UI::Accessibility::IUIAutomationElement> {
        unsafe { self.walker.GetNextSiblingElement(el).ok() }
    }
}

#[cfg(windows)]
impl Default for UiaPerception {
    fn default() -> Self {
        Self::new().expect("UIA 初始化失败(默认构造语义:见 new)")
    }
}

/// 感知源实现:活动窗口快照 + 命中检测(物理坐标)。
#[cfg(windows)]
impl PerceptionSource for UiaPerception {
    #[allow(unsafe_code)]
    fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError> {
        use windows::Win32::UI::Accessibility::IUIAutomationElement;
        unsafe {
            // 活动窗口:GetFocusedElement → 上溯至顶层窗口(父链顶端)
            let focused = self.automation.GetFocusedElement().map_err(|e| {
                tracing::debug!(error = %e, "GetFocusedElement 失败(无活动窗口)");
                PerceptionError::NoActiveWindow
            })?;
            let mut root_el: IUIAutomationElement = focused;
            while let Some(parent) = self.parent_of(&root_el) {
                root_el = parent;
            }
            let raw = self.read_node(&root_el, 0);
            Ok(build_snapshot(&raw))
        }
    }

    #[allow(unsafe_code)]
    fn element_from_point(
        &self,
        x: i32,
        y: i32,
    ) -> Result<Option<PerceptionNode>, PerceptionError> {
        use windows::Win32::Foundation::POINT;
        unsafe {
            let el = self
                .automation
                .ElementFromPoint(POINT { x, y })
                .map_err(|e| PerceptionError::Traverse(format!("ElementFromPoint: {e}")))?;
            let raw = self.read_node(&el, 0);
            let (name, value) = suppress(&raw);
            Ok(Some(PerceptionNode {
                role: raw.role,
                name,
                value,
                rect: raw.rect,
                is_password: raw.is_password,
                children: Vec::new(),
            }))
        }
    }
}

/// 父元素上溯(NULL → Err(empty) → None)
#[cfg(windows)]
#[allow(unsafe_code)]
impl UiaPerception {
    fn parent_of(
        &self,
        el: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    ) -> Option<windows::Win32::UI::Accessibility::IUIAutomationElement> {
        unsafe { self.walker.GetParentElement(el).ok() }
    }
}

/// ControlType 编号 → 归一化角色名(覆盖 37 报告枚举到的控件类型
/// Window/Text/Edit/Button/TitleBar/MenuBar/MenuItem/Pane/Document 及常用集;
/// 未知 → "custom")。
///
/// 全平台可编译(纯映射,便于单测穷举;设备面传入 `UIA_CONTROLTYPE_ID.0`)。
pub fn control_type_role(id: i32) -> &'static str {
    match id {
        50000 => "button",
        50001 => "calendar",
        50002 => "checkbox",
        50003 => "combobox",
        50004 => "edit",
        50005 => "password_edit",
        50006 => "image",
        50007 => "list_item",
        50008 => "list",
        50009 => "menu",
        50010 => "menu_bar",
        50011 => "menu_item",
        50012 => "progress_bar",
        50013 => "radio_button",
        50014 => "scroll_bar",
        50015 => "slider",
        50016 => "spinner",
        50017 => "status_bar",
        50018 => "tab",
        50019 => "tab_item",
        50020 => "text",
        50021 => "tool_bar",
        50022 => "tool_tip",
        50023 => "tree",
        50024 => "tree_item",
        50025 => "custom",
        50026 => "group",
        50027 => "thumb",
        50028 => "data_grid",
        50029 => "data_item",
        50030 => "document",
        50031 => "split_button",
        50032 => "window",
        50033 => "pane",
        50034 => "header",
        50035 => "header_item",
        50036 => "table",
        50037 => "title_bar",
        50038 => "separator",
        50039 => "semantic_zoom",
        50040 => "app_bar",
        _ => "custom",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::PASSWORD_REDACTION_PLACEHOLDER;

    /// 构造深度为 `depth` 的链式树(每层一个按钮,名称递增)
    fn chain(depth: usize) -> RawNode {
        let mut node = RawNode::new("button", "b0", "", EMPTY_RECT);
        for i in 1..depth {
            node = RawNode::new("button", format!("b{i}"), "", EMPTY_RECT).push(node);
        }
        node
    }

    #[test]
    fn rect_geometry_and_contains() {
        let rect = Rect::new(10, 20, 110, 70);
        assert_eq!(rect.width(), 100);
        assert_eq!(rect.height(), 50);
        assert!(rect.contains(10, 20));
        assert!(rect.contains(109, 69));
        // 半开区间:右/下边界不包含
        assert!(!rect.contains(110, 70));
        assert!(!rect.contains(9, 20));
        assert!(EMPTY_RECT.is_empty());
    }

    #[test]
    fn build_snapshot_parses_fixture_tree() {
        // 窗口 → [标题栏, 编辑框(普通), 按钮],编辑框带子节点(光标等)
        let root = RawNode::new("window", "测试窗口", "", Rect::new(0, 0, 800, 600))
            .push(RawNode::new(
                "title_bar",
                "测试窗口",
                "",
                Rect::new(0, 0, 800, 40),
            ))
            .push(
                RawNode::new("edit", "输入框", "hello", Rect::new(10, 50, 500, 90))
                    .push(RawNode::new("text", "光标", "", Rect::new(10, 50, 12, 90))),
            )
            .push(RawNode::new(
                "button",
                "确定",
                "",
                Rect::new(700, 50, 780, 90),
            ));
        let snap = build_snapshot(&root);
        assert_eq!(snap.node_count, 5);
        assert!(!snap.truncated);
        assert_eq!(snap.root.role, "window");
        assert_eq!(snap.root.name, "测试窗口");
        assert_eq!(snap.root.children.len(), 3);
        assert_eq!(snap.root.children[1].children.len(), 1);
        // 普通名称/值原样保留
        assert_eq!(snap.root.children[1].name, "输入框");
        assert_eq!(snap.root.children[1].value, "hello");
    }

    #[test]
    fn build_snapshot_truncates_depth() {
        // 深度 9 层(根为第 0 层,最深节点深度 8) > MAX_TREE_DEPTH 6
        let root = chain(9);
        let snap = build_snapshot(&root);
        assert!(snap.truncated, "深度超限应标记截断");
        // 保留 0..=6 层 = 7 个节点(深度 6 的节点其子被截断)
        assert_eq!(snap.node_count, 7);
        // 逐层下探:每层保留 1 个子节点,直至深度 MAX_TREE_DEPTH 的节点
        let mut node = &snap.root;
        for i in 0..MAX_TREE_DEPTH {
            assert_eq!(node.children.len(), 1, "第 {i} 层应保留 1 个子节点");
            node = &node.children[0];
        }
        // 深度 MAX_TREE_DEPTH 的节点:子节点被截断
        assert!(node.children.is_empty());
    }

    #[test]
    fn build_snapshot_truncates_node_count() {
        // 星形树:根 + 3000 个平铺子节点 → 节点数触顶 2000
        let children: Vec<RawNode> = (0..3000)
            .map(|i| RawNode::new("button", format!("b{i}"), "", EMPTY_RECT))
            .collect();
        let root = RawNode::new("window", "w", "", EMPTY_RECT);
        let mut root = root;
        root.children = children;
        let snap = build_snapshot(&root);
        assert!(snap.truncated, "节点数触顶应标记截断");
        assert_eq!(snap.node_count, MAX_TREE_NODES);
        assert_eq!(snap.root.children.len(), MAX_TREE_NODES - 1);
    }

    #[test]
    fn password_suppression_placeholder() {
        // IsPassword=true:name/value 均输出 <password>,不落实际字符
        let root = RawNode::new("window", "登录", "", EMPTY_RECT)
            .push(
                RawNode::new("edit", "secret-pwd-12345", "secret-pwd-12345", EMPTY_RECT)
                    .with_password(),
            )
            .push(RawNode::new("button", "登录", "", EMPTY_RECT));
        let snap = build_snapshot(&root);
        let pwd = &snap.root.children[0];
        assert_eq!(pwd.name, PASSWORD_PLACEHOLDER);
        assert_eq!(pwd.value, PASSWORD_PLACEHOLDER);
        assert!(pwd.is_password);
        assert!(!pwd.name.contains("secret"), "密码内容不得出现在快照");
        assert!(!pwd.value.contains("12345"), "密码内容不得出现在快照");
        // 非密码兄弟节点不受影响
        assert_eq!(snap.root.children[1].name, "登录");
    }

    #[test]
    fn keyname_pattern_redaction() {
        // 键名模式(大小写不敏感):名称/值命中 → <redacted>
        let root = RawNode::new("window", "配置", "", EMPTY_RECT)
            .push(RawNode::new("edit", "Password", "password123", EMPTY_RECT))
            .push(RawNode::new("edit", "api_token", "token-123", EMPTY_RECT))
            .push(RawNode::new("edit", "用户密码", "", EMPTY_RECT))
            .push(RawNode::new("edit", "标题", "普通文本", EMPTY_RECT));
        let snap = build_snapshot(&root);
        let kids = &snap.root.children;
        assert_eq!(kids[0].name, PASSWORD_REDACTION_PLACEHOLDER);
        assert_eq!(kids[0].value, PASSWORD_REDACTION_PLACEHOLDER);
        assert_eq!(kids[1].name, PASSWORD_REDACTION_PLACEHOLDER);
        assert_eq!(kids[1].value, PASSWORD_REDACTION_PLACEHOLDER);
        // 中文「密码」不在键名模式库(纯英文子串匹配),原样保留
        assert_eq!(kids[2].name, "用户密码");
        assert_eq!(kids[3].name, "标题");
        assert_eq!(kids[3].value, "普通文本");
    }

    #[test]
    fn element_at_point_hit_and_miss() {
        let root =
            RawNode::new("window", "w", "", Rect::new(0, 0, 800, 600))
                .push(RawNode::new("title_bar", "w", "", Rect::new(0, 0, 800, 40)))
                .push(
                    RawNode::new("pane", "内容", "", Rect::new(0, 40, 400, 600)).push(
                        RawNode::new("button", "保存", "", Rect::new(100, 100, 200, 150)),
                    ),
                );
        let snap = build_snapshot(&root);
        // 命中最深层:按钮内部 → 按钮
        let hit = element_at_point(&snap.root, 150, 120).expect("按钮内应命中");
        assert_eq!(hit.role, "button");
        assert_eq!(hit.name, "保存");
        // 标题栏区域 → 标题栏(最深)
        let hit = element_at_point(&snap.root, 400, 20).expect("标题栏应命中");
        assert_eq!(hit.role, "title_bar");
        // pane 内但非按钮区域 → pane(最深)
        let hit = element_at_point(&snap.root, 300, 500).expect("pane 内应命中");
        assert_eq!(hit.role, "pane");
        // 窗口内、任何子节点外(pane 右侧留白)→ 窗口自身
        let hit = element_at_point(&snap.root, 700, 500).expect("窗口内应命中");
        assert_eq!(hit.role, "window");
        // 未命中:窗口外
        assert!(element_at_point(&snap.root, 900, 700).is_none());
        // 未命中:空矩形元素(无几何)不应命中
        let empty = RawNode::new("text", "", "", EMPTY_RECT);
        let snap2 = build_snapshot(&empty);
        assert!(element_at_point(&snap2.root, 0, 0).is_none());
    }

    #[test]
    fn control_type_role_covers_report_set() {
        // 37 报告 §3.2 枚举到的控件类型全集
        assert_eq!(control_type_role(50032), "window");
        assert_eq!(control_type_role(50020), "text");
        assert_eq!(control_type_role(50004), "edit");
        assert_eq!(control_type_role(50000), "button");
        assert_eq!(control_type_role(50037), "title_bar");
        assert_eq!(control_type_role(50010), "menu_bar");
        assert_eq!(control_type_role(50011), "menu_item");
        assert_eq!(control_type_role(50033), "pane");
        assert_eq!(control_type_role(50030), "document");
        assert_eq!(control_type_role(50005), "password_edit");
        // 未知编号 → custom
        assert_eq!(control_type_role(99999), "custom");
    }
}
