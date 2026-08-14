//! UIA 结构化感知集成测试(04 §5 验收项 7 结构化辅助的单测面)。
//!
//! 覆盖:
//! - 树遍历解析(fixture 节点树 → 感知快照,角色/名称/值/矩形/子节点);
//! - 深度截断(6 层)与节点数截断(2000);
//! - 密码抑制(IsPassword 形态节点值不落,`<password>` 占位)与键名模式脱敏;
//! - element_from_point 命中/未命中(trait 注入 mock + 纯函数命中检测);
//! - 空树 / 无活动窗口容错。
//!
//! 真实验证(记事本探针,`#[ignore]` 默认不跑,非 CI 门禁):
//! ```text
//! cargo test -p conex-computer --test perception_source -- --ignored --nocapture
//! ```

use conex_computer::perception::EMPTY_RECT;
use conex_computer::perception::{
    build_snapshot, element_at_point, PerceptionError, PerceptionNode, PerceptionSnapshot,
    PerceptionSource, RawNode, Rect, MAX_TREE_DEPTH, MAX_TREE_NODES,
};
use conex_computer::security::{PASSWORD_PLACEHOLDER, PASSWORD_REDACTION_PLACEHOLDER};

// ===== fixture 构造 =====

/// 记事本形态 fixture:窗口 → 标题栏/菜单栏/编辑区(带文本值)
fn notepad_fixture() -> RawNode {
    RawNode::new("window", "无标题 - 记事本", "", Rect::new(0, 0, 800, 600))
        .push(RawNode::new(
            "title_bar",
            "无标题 - 记事本",
            "",
            Rect::new(0, 0, 800, 40),
        ))
        .push(
            RawNode::new("menu_bar", "菜单栏", "", Rect::new(0, 40, 800, 56))
                .push(RawNode::new(
                    "menu_item",
                    "文件",
                    "",
                    Rect::new(0, 40, 60, 56),
                ))
                .push(RawNode::new(
                    "menu_item",
                    "编辑",
                    "",
                    Rect::new(60, 40, 120, 56),
                )),
        )
        .push(RawNode::new(
            "edit",
            "文本编辑器",
            "你好,世界",
            Rect::new(0, 56, 800, 600),
        ))
}

/// 含密码框的登录窗口 fixture
fn login_fixture() -> RawNode {
    RawNode::new("window", "登录", "", Rect::new(100, 100, 500, 400))
        .push(RawNode::new(
            "text",
            "用户名",
            "user1",
            Rect::new(120, 140, 300, 160),
        ))
        .push(
            RawNode::new("edit", "userInput", "alice", Rect::new(120, 170, 300, 200)).push(
                RawNode::new("text", "", "alice", Rect::new(120, 170, 300, 200)),
            ),
        )
        .push(
            RawNode::new(
                "edit",
                "passInput",
                "s3cret-pass-xyz",
                Rect::new(120, 210, 300, 240),
            )
            .with_password(),
        )
        .push(RawNode::new(
            "button",
            "登录",
            "",
            Rect::new(200, 300, 300, 340),
        ))
}

/// mock 感知源(注入 fixture 树;命中检测 = 纯函数 [`element_at_point`] 语义)
struct MockSource {
    root: RawNode,
    hit_override: Option<Option<PerceptionNode>>,
}

impl MockSource {
    fn new(root: RawNode) -> Self {
        Self {
            root,
            hit_override: None,
        }
    }
}

impl PerceptionSource for MockSource {
    fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError> {
        Ok(build_snapshot(&self.root))
    }

    fn element_from_point(
        &self,
        x: i32,
        y: i32,
    ) -> Result<Option<PerceptionNode>, PerceptionError> {
        if let Some(override_value) = &self.hit_override {
            return Ok(override_value.clone());
        }
        let snap = build_snapshot(&self.root);
        Ok(element_at_point(&snap.root, x, y).cloned())
    }
}

// ===== 树遍历解析 =====

#[test]
fn snapshot_parses_fixture_tree_full() {
    let source = MockSource::new(notepad_fixture());
    let snap = source.snapshot().expect("fixture 快照解析失败");
    assert_eq!(snap.root.role, "window");
    assert_eq!(snap.root.name, "无标题 - 记事本");
    assert_eq!(snap.root.rect, Rect::new(0, 0, 800, 600));
    assert_eq!(
        snap.node_count, 6,
        "窗口 + 标题栏 + 菜单栏 + 2 菜单项 + 编辑框 = 6"
    );
    assert!(!snap.truncated);
    // 树结构:window → [title_bar, menu_bar[menu_item×2], edit]
    assert_eq!(snap.root.children.len(), 3);
    assert_eq!(snap.root.children[1].role, "menu_bar");
    assert_eq!(snap.root.children[1].children.len(), 2);
    assert_eq!(snap.root.children[2].value, "你好,世界");
}

#[test]
fn snapshot_serializes_to_json() {
    let source = MockSource::new(notepad_fixture());
    let snap = source.snapshot().expect("fixture 快照解析失败");
    let json = serde_json::to_string(&snap).expect("序列化失败");
    let back: PerceptionSnapshot = serde_json::from_str(&json).expect("反序列化失败");
    assert_eq!(back, snap);
    // 结构化字段面可见(供模型面)
    assert!(json.contains("\"role\":\"window\""));
    assert!(json.contains("\"name\":\"无标题 - 记事本\""));
}

// ===== 深度 / 节点数截断 =====

/// 构造链式树:每层一个按钮,深度为 `depth`(含根)
fn chain_tree(depth: usize) -> RawNode {
    let mut node = RawNode::new("button", "b0", "", EMPTY_RECT);
    for i in 1..depth {
        node = RawNode::new("button", format!("b{i}"), "", EMPTY_RECT).push(node);
    }
    node
}

#[test]
fn depth_truncation_caps_at_max() {
    // 深度 10 > MAX_TREE_DEPTH 6:截断标记置位
    let root = chain_tree(10);
    let snap = build_snapshot(&root);
    assert!(snap.truncated);
    // 根为第 0 层;最大保留深度 = MAX_TREE_DEPTH(第 6 层节点的子不再展开)
    assert_eq!(
        snap.node_count,
        MAX_TREE_DEPTH + 1,
        "保留 0..=6 层共 7 节点"
    );
    // 逐层下探:每层保留 1 个子节点,直至深度 MAX_TREE_DEPTH 的节点
    let mut node = &snap.root;
    for i in 0..MAX_TREE_DEPTH {
        assert_eq!(node.children.len(), 1, "第 {i} 层应保留 1 个子节点");
        node = &node.children[0];
    }
    assert!(node.children.is_empty(), "深度触顶后不再展开子节点");
}

#[test]
fn node_count_truncation_caps_at_max() {
    // 根 + 10000 平铺子节点 → 节点数截断在 MAX_TREE_NODES
    let mut root = RawNode::new("window", "w", "", EMPTY_RECT);
    root.children = (0..10_000)
        .map(|i| RawNode::new("button", format!("b{i}"), "", EMPTY_RECT))
        .collect();
    let snap = build_snapshot(&root);
    assert!(snap.truncated);
    assert_eq!(snap.node_count, MAX_TREE_NODES);
    assert_eq!(snap.root.children.len(), MAX_TREE_NODES - 1);
}

#[test]
fn deep_and_wide_combined_truncation() {
    // 宽树 + 深链同时存在:两者截断均触发且不 panic
    let mut root = RawNode::new("window", "w", "", EMPTY_RECT);
    root.children = (0..MAX_TREE_NODES + 100)
        .map(|i| RawNode::new("button", format!("b{i}"), "", EMPTY_RECT).push(chain_tree(10)))
        .collect();
    let snap = build_snapshot(&root);
    assert!(snap.truncated);
    assert!(snap.node_count <= MAX_TREE_NODES);
}

// ===== 密码抑制 =====

#[test]
fn password_suppression_placeholder_and_redaction() {
    let source = MockSource::new(login_fixture());
    let snap = source.snapshot().expect("fixture 快照解析失败");
    let kids = &snap.root.children;
    // 普通输入框:值原样
    assert_eq!(kids[1].value, "alice");
    // 密码框:name/value 均为 <password> 占位,内容不落
    let pwd = &kids[2];
    assert!(pwd.is_password);
    assert_eq!(pwd.name, PASSWORD_PLACEHOLDER);
    assert_eq!(pwd.value, PASSWORD_PLACEHOLDER);
    // 明文片段(s3cret / pass-xyz)不得出现在任何字段
    assert!(!pwd.name.contains("s3cret") && !pwd.value.contains("pass-xyz"));
    assert!(!pwd.name.contains("xyz") && !pwd.value.contains("s3cret"));
    // 快照序列化后同样不落明文
    let json = serde_json::to_string(&snap).expect("序列化失败");
    assert!(!json.contains("s3cret"));
    assert!(!json.contains("pass-xyz"));
}

#[test]
fn keyname_pattern_redaction_covers_values() {
    // 键名模式命中:名称与值都脱敏(password/passwd/pwd/secret/token,大小写不敏感)
    let root = RawNode::new("window", "设置", "", EMPTY_RECT)
        .push(RawNode::new("edit", "API Key", "token-abc", EMPTY_RECT))
        .push(RawNode::new("edit", "旧密码", "old-pwd-1", EMPTY_RECT))
        .push(RawNode::new("edit", "正常字段", "可见内容", EMPTY_RECT))
        .push(RawNode::new(
            "edit",
            "PasswordConfirm",
            "pw123456",
            EMPTY_RECT,
        ));
    let snap = build_snapshot(&root);
    let kids = &snap.root.children;
    // name 不含键名模式 → 原文保留;value 含 token → 脱敏
    assert_eq!(kids[0].name, "API Key");
    assert_eq!(kids[0].value, PASSWORD_REDACTION_PLACEHOLDER);
    // 中文名称不命中英文模式 → 原文;value 含 pwd → 脱敏
    assert_eq!(kids[1].name, "旧密码");
    assert_eq!(kids[1].value, PASSWORD_REDACTION_PLACEHOLDER);
    // 未命中任何模式 → 原文保留
    assert_eq!(kids[2].name, "正常字段");
    assert_eq!(kids[2].value, "可见内容");
    // 名称含 Password(大小写不敏感) → 脱敏;值 pw123456 不含键名 → 原文
    assert_eq!(kids[3].name, PASSWORD_REDACTION_PLACEHOLDER);
    assert_eq!(kids[3].value, "pw123456");
}

// ===== element_from_point 命中 / 未命中 =====

#[test]
fn element_from_point_hits_deepest() {
    let source = MockSource::new(notepad_fixture());
    // 编辑区中点 → 编辑框(最深命中)
    let hit = source
        .element_from_point(400, 300)
        .expect("命中查询失败")
        .expect("编辑区应命中");
    assert_eq!(hit.role, "edit");
    assert_eq!(hit.value, "你好,世界");
    // 菜单项内点 → 菜单项
    let hit = source
        .element_from_point(30, 48)
        .expect("命中查询失败")
        .expect("菜单区应命中");
    assert_eq!(hit.role, "menu_item");
    assert_eq!(hit.name, "文件");
    // 标题栏点 → 标题栏
    let hit = source
        .element_from_point(400, 20)
        .expect("命中查询失败")
        .expect("标题栏应命中");
    assert_eq!(hit.role, "title_bar");
}

#[test]
fn element_from_point_misses_outside() {
    let source = MockSource::new(notepad_fixture());
    // 窗口外 → 未命中
    assert!(source
        .element_from_point(900, 700)
        .expect("查询失败")
        .is_none());
    assert!(source
        .element_from_point(-5, -5)
        .expect("查询失败")
        .is_none());
}

#[test]
fn element_from_point_password_hit_redacted() {
    // 04 §4.5 联动③:命中密码框时文本同样不回传
    let source = MockSource::new(login_fixture());
    let hit = source
        .element_from_point(200, 225)
        .expect("命中查询失败")
        .expect("密码框区域应命中");
    assert!(hit.is_password);
    assert_eq!(hit.value, PASSWORD_PLACEHOLDER);
    // 未命中 override 路径(mock 显式返回 None)
    let mut source = MockSource::new(login_fixture());
    source.hit_override = Some(None);
    assert!(source.element_from_point(0, 0).expect("查询失败").is_none());
}

// ===== 空树 / 无活动窗口容错 =====

#[test]
fn empty_tree_snapshot_ok() {
    // 空根节点(无任何属性):解析不失败,零节点
    let root = RawNode::new("custom", "", "", EMPTY_RECT);
    let snap = build_snapshot(&root);
    assert_eq!(snap.node_count, 1);
    assert!(!snap.truncated);
    assert_eq!(snap.root.role, "custom");
    assert!(snap.root.children.is_empty());
}

#[test]
fn no_active_window_returns_error() {
    // mock 模拟 GetFocusedElement 失败(锁屏 / 无焦点):返回 NoActiveWindow
    struct NoFocus;
    impl PerceptionSource for NoFocus {
        fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError> {
            Err(PerceptionError::NoActiveWindow)
        }
        fn element_from_point(
            &self,
            _x: i32,
            _y: i32,
        ) -> Result<Option<PerceptionNode>, PerceptionError> {
            Ok(None)
        }
    }
    assert_eq!(NoFocus.snapshot(), Err(PerceptionError::NoActiveWindow));
    // 错误文案带可读语义
    assert!(PerceptionError::NoActiveWindow
        .to_string()
        .contains("无活动窗口"));
}

#[test]
fn serde_snapshot_roundtrip_with_truncation() {
    // 截断快照同样可序列化(模型面消费不炸)
    let root = chain_tree(10);
    let snap = build_snapshot(&root);
    assert!(snap.truncated);
    let json = serde_json::to_string(&snap).expect("序列化失败");
    let back: PerceptionSnapshot = serde_json::from_str(&json).expect("反序列化失败");
    assert_eq!(back, snap);
    assert!(json.contains("\"truncated\":true"));
}

// ===== 真实验证(记事本探针,#[ignore] 默认不跑) =====

#[cfg(windows)]
#[allow(unsafe_code)]
mod live_probe {
    use super::*;
    use conex_computer::perception::UiaPerception;
    use windows::core::w;
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;

    /// 探针:找记事本窗口(类名 Notepad 或标题含「记事本」)→ UIA 快照
    /// (标题/按钮/矩形),打印节点清单。找不到窗口 → 打印说明并跳过
    /// (环境差异,非失败)。
    pub fn notepad_snapshot() -> Result<(), String> {
        let perception = UiaPerception::new().map_err(|e| format!("UIA 初始化失败: {e}"))?;
        // 先按类名找(经典 Win32 记事本);找不到再按标题找(UWP 化记事本)
        let mut hwnd = unsafe { FindWindowW(w!("Notepad"), None) }.unwrap_or_default();
        if hwnd.is_invalid() {
            hwnd = unsafe { FindWindowW(w!("ApplicationFrameWindow"), None) }.unwrap_or_default();
        }
        if hwnd.is_invalid() {
            println!("未找到记事本窗口(类名 Notepad / ApplicationFrameWindow),跳过探针");
            return Ok(());
        }
        let snap = perception
            .snapshot_window(hwnd)
            .map_err(|e| format!("记事本快照失败: {e}"))?;
        println!(
            "记事本 UIA 快照: 根={} 节点数={} 截断={} 根矩形={:?}",
            snap.root.role, snap.node_count, snap.truncated, snap.root.rect
        );
        assert!(snap.node_count > 0, "记事本窗口树不应为空");
        let mut buttons = 0;
        let mut edits = 0;
        let mut walk: Vec<&PerceptionNode> = vec![&snap.root];
        while let Some(node) = walk.pop() {
            println!(
                "  [{}] role={} name={:?} rect={:?} pwd={}",
                node.role, node.role, node.name, node.rect, node.is_password
            );
            if node.role == "button" {
                buttons += 1;
            }
            if node.role == "edit" {
                edits += 1;
            }
            walk.extend(node.children.iter());
        }
        println!("按钮数={buttons} 编辑框数={edits}");
        Ok(())
    }
}

#[test]
#[ignore]
#[cfg(windows)]
fn live_notepad_uia_snapshot() {
    if let Err(e) = live_probe::notepad_snapshot() {
        panic!("真实验证失败(记事本 UIA 快照): {e}");
    }
}
