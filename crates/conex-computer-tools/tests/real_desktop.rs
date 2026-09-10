//! 真实桌面端到端集成测试（49 报告 §2 迁移，R1-2 建议 3 入库护栏）。
//!
//! ## 迁移依据
//! 49 报告 §2 真实桌面 24 断言原在 temp rig（`cu-e2e/smoke/src/bin/real_desktop.rs`），
//! 依赖交互式桌面会话（Windows 11 session 1 实机）。按建议迁移入库并以
//! `#[ignore]` 标注——**非 CI 门禁**，需显式运行：
//! ```text
//! cargo test -p conex-computer-tools --test real_desktop -- --ignored --nocapture
//! ```
//!
//! ## 前置条件
//! - Windows + 交互式桌面会话（UIA 感知 + 输入注入需真实桌面）；
//! - 目标窗口 = 记事本（测试自启动 `notepad.exe <临时文件>`，收尾仅终止
//!   自身子进程，不误杀用户已开的记事本）；
//! - 运行期间请勿占用鼠标/键盘（真实注入会移动光标）。
//!
//! ## 覆盖面（对齐 49 报告断言编号）
//! - T1 RealComputerSession 构造（真实设备面）+ readiness + 缩放规格；
//! - T2 互斥真实链（浏览器活跃 → exclusive；release 回 Idle → 桌面态）；
//! - T3 computer_snapshot 真实 UIA 树（含记事本窗口 + 节点数）；
//! - T4 click 真实注入 + cursor_position 坐标闭环（0px 偏差）；
//! - T5 type 真实注入 + UIA 回读（0 丢字，emoji 完整）；
//! - T6 screenshot（PNG 魔数 + 解码尺寸 == spec 目标档）；
//! - T7 感知版本号单调推进（快照→光标→截屏）；
//! - T8 白名单拒绝真实链 → `tool.computer.elevated_window`；
//! - T9 已收敛：原停止链改为会话级中止令牌（输入框停止按钮）验证，覆盖见守卫中止自查与 run 停止 watcher，不在本文件单独断言。
//!
//! ## 测试面豁免说明（clippy 禁令）
//! 本文件为测试面拉起/终止记事本（`notepad.exe` / `taskkill /PID /T`）作为
//! 真实注入目标与收尾清理，属「非产品执行路径」——参照 conex-db /
//! orchestrator tests 先例，文件级 allow `clippy::disallowed_methods`
//! （仅本测试文件生效）。

// 测试面：真实桌面冒烟需拉起/终止记事本进程（非产品执行路径，无门禁面；
// 参数仅固定可执行名与临时文件路径，无用户自由参数）
#![allow(clippy::disallowed_methods)]

use agent_tools::context::ToolContext;
use agent_tools::definition::ToolError;
use agent_tools::registry::ToolRegistry;
use base64::Engine;
use conex_computer::activation::{ActivationGate, SessionMode};
use conex_computer::coord::Point;
use conex_computer::security::SessionEnablement;
use conex_computer::window_gate::{WhitelistEntry, WindowTargetGate};
use conex_computer::ComputerSession;
use conex_computer_tools::codes;
use conex_computer_tools::session::{ComputerOps, RealComputerSession};
use conex_computer_tools::{register_computer_tools, ComputerToolsConfig};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

// ===== 装配（真实守卫组件） =====

struct Rig {
    registry: ToolRegistry,
    activation: Arc<ActivationGate>,
    enablement: Arc<SessionEnablement>,
}

fn build_rig(session: Arc<dyn ComputerOps>) -> Rig {
    let activation = Arc::new(ActivationGate::new());
    let enablement = Arc::new(SessionEnablement::new());
    enablement.enable().expect("开启态可建立");
    let mut registry = ToolRegistry::new();
    register_computer_tools(
        &mut registry,
        ComputerToolsConfig {
            session: Some(session),
            enablement: Some(enablement.clone()),
            activation: Some(activation.clone()),
        },
    )
    .expect("注册应成功");
    Rig {
        registry,
        activation,
        enablement,
    }
}

async fn run_tool(rig: &Rig, name: &str, args: Value) -> Result<Value, ToolError> {
    let tool = rig
        .registry
        .get(name)
        .unwrap_or_else(|| panic!("工具 {name} 未注册"));
    let ctx = ToolContext::new("sess-real-desktop", std::path::PathBuf::from("."));
    tool.execute(&ctx, args).await
}

// ===== UIA 树辅助（对齐 48/49 rig：元素定位用 rect+名称复合判据） =====

/// 优先按名称定位编辑区（Win11 记事本编辑区 name="Text editor"），
/// 回退 DFS 首个 edit/document（48 报告坑 3：role 随焦点漂移）。
fn find_editor_preferred(node: &Value) -> Option<&Value> {
    if let Some(found) = find_named_editor(node) {
        return Some(found);
    }
    let role = node["role"].as_str().unwrap_or("");
    if role == "edit" || role == "document" {
        return Some(node);
    }
    if let Some(children) = node["children"].as_array() {
        for c in children {
            if let Some(found) = find_editor_preferred(c) {
                return Some(found);
            }
        }
    }
    None
}

fn find_named_editor(node: &Value) -> Option<&Value> {
    let role = node["role"].as_str().unwrap_or("");
    if role == "edit" || role == "document" {
        let name = node["name"].as_str().unwrap_or("").to_lowercase();
        for kw in ["text editor", "编辑器", "文本编辑器", "编辑区"] {
            if name.contains(kw) {
                return Some(node);
            }
        }
    }
    if let Some(children) = node["children"].as_array() {
        for c in children {
            if let Some(found) = find_named_editor(c) {
                return Some(found);
            }
        }
    }
    None
}

/// 树中是否含指定名字的节点（窗口标题匹配用，任意层级）。
fn tree_contains_name(node: &Value, needle: &str) -> bool {
    if node["name"]
        .as_str()
        .is_some_and(|n| n.to_lowercase().contains(&needle.to_lowercase()))
    {
        return true;
    }
    if let Some(children) = node["children"].as_array() {
        for c in children {
            if tree_contains_name(c, needle) {
                return true;
            }
        }
    }
    false
}

/// 物理矩形中心。
fn rect_center(node: &Value) -> Option<(i32, i32)> {
    let rect = node.get("rect")?;
    let left = rect["left"].as_i64()? as i32;
    let top = rect["top"].as_i64()? as i32;
    let right = rect["right"].as_i64()? as i32;
    let bottom = rect["bottom"].as_i64()? as i32;
    if right <= left || bottom <= top {
        return None;
    }
    Some(((left + right) / 2, (top + bottom) / 2))
}

/// 按物理坐标在树中取命中节点（对齐 UIA ElementFromPoint 语义）。
fn node_at_point(node: &Value, x: i32, y: i32) -> Option<&Value> {
    let rect = node.get("rect")?;
    let left = rect["left"].as_i64()? as i32;
    let top = rect["top"].as_i64()? as i32;
    let right = rect["right"].as_i64()? as i32;
    let bottom = rect["bottom"].as_i64()? as i32;
    if x < left || x >= right || y < top || y >= bottom {
        return None;
    }
    if let Some(children) = node["children"].as_array() {
        for c in children {
            if let Some(hit) = node_at_point(c, x, y) {
                return Some(hit);
            }
        }
    }
    Some(node)
}

// ===== 真实桌面全链（T1-T8，单测试顺序执行避免并行注入干扰） =====

/// 真实桌面端到端全链（49 报告 §2 T1-T8 迁移；原 T9 已收敛为会话级中止令牌，不单测）。
///
/// 单测试串行执行：真实注入共享同一桌面（鼠标/键盘），并行测试会互相
/// 干扰；每个阶段失败即 panic 并携带阶段上下文。
#[test]
#[ignore]
#[cfg(windows)]
fn real_desktop_full_chain() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("current_thread 运行时可建");
    if let Err(e) = rt.block_on(full_chain()) {
        panic!("真实桌面端到端失败：{e}");
    }
}

/// 全链实现（对齐 49 bin 顺序；阶段错误携带断言上下文）。
#[cfg(windows)]
async fn full_chain() -> Result<(), String> {
    // ── T0 前置：清空临时文件 + 启动记事本 ──
    let target_file = std::env::temp_dir().join("conex-e2e-49-notepad.txt");
    std::fs::write(&target_file, "").map_err(|e| format!("清空临时文件失败：{e}"))?;
    let mut notepad = std::process::Command::new("notepad.exe")
        .arg(&target_file)
        .spawn();
    if notepad.is_err() {
        return Err(format!("启动记事本失败：{:?}", notepad.err()));
    }
    std::thread::sleep(Duration::from_secs(2));

    let chain = async {
        // ── T1 会话初始化：RealComputerSession（真实设备面） ──
        let real = RealComputerSession::new().map_err(|e| format!("T1 会话构造失败：{e}"))?;
        let session: Arc<dyn ComputerOps> = Arc::new(real);
        session
            .readiness()
            .map_err(|e| format!("T1b readiness 失败：{e}"))?;

        // 辅助会话：读取缩放规格（物理→API 换算；仅读数不派发动作）
        let helper = ComputerSession::new().map_err(|e| format!("T1c 辅助会话失败：{e}"))?;
        let spec = *helper.scale_spec();

        // ── T2 互斥真实链：浏览器活跃 → exclusive；release → 桌面态 ──
        let rig = build_rig(session.clone());
        rig.activation.request_browser().expect("可进浏览器态");
        let e = run_tool(&rig, "computer_snapshot", json!({}))
            .await
            .expect_err("浏览器活跃时快照应拒绝");
        if e.code() != codes::TOOL_SESSION_EXCLUSIVE {
            return Err(format!("T2a 期望 exclusive，实得 {e}"));
        }
        let prev = rig.activation.release();
        if prev != SessionMode::BrowserActive {
            return Err(format!("T2b release 应返回 BrowserActive，实得 {prev:?}"));
        }
        rig.activation
            .request_desktop()
            .map_err(|e| format!("T2c 桌面激活失败：{e}"))?;
        if !rig.activation.current().is_desktop() {
            return Err(format!(
                "T2c 应处于 DesktopActive，实得 {:?}",
                rig.activation.current()
            ));
        }

        // ── T3 computer_snapshot：真实 UIA 树 ──
        let snap = run_tool(&rig, "computer_snapshot", json!({}))
            .await
            .map_err(|e| format!("T3a snapshot 失败：{e}"))?;
        let tree = &snap["tree"];
        if !tree_contains_name(tree, "Notepad") && !tree_contains_name(tree, "记事本") {
            return Err(format!("T3b 树应含记事本窗口，根名={}", tree["name"]));
        }
        let node_count = snap["nodeCount"].as_u64().unwrap_or(0);
        if node_count <= 10 {
            return Err(format!("T3c 节点数应 >10，实得 {node_count}"));
        }

        // ── T4 click：编辑区中心 → 光标坐标闭环 ──
        let edit_node =
            find_editor_preferred(tree).ok_or_else(|| "T4a 树无 edit/document 节点".to_string())?;
        let center = rect_center(edit_node).ok_or_else(|| "T4b 编辑区 rect 无效".to_string())?;
        let api = spec.phys_to_api(Point::new(center.0, center.1));
        let r = run_tool(
            &rig,
            "computer_click",
            json!({ "coordinate": [api.x, api.y] }),
        )
        .await
        .map_err(|e| format!("T4c click 注入失败：{e}"))?;
        if r["ok"] != true {
            return Err(format!("T4c click 未返回 ok：{r}"));
        }
        let pos = run_tool(&rig, "computer_cursor_position", json!({}))
            .await
            .map_err(|e| format!("T4d cursor_position 失败：{e}"))?;
        let x = pos["x"].as_i64().unwrap_or(-1);
        let y = pos["y"].as_i64().unwrap_or(-1);
        let (dx, dy) = ((x - api.x as i64).abs(), (y - api.y as i64).abs());
        if dx > 2 || dy > 2 {
            return Err(format!(
                "T4d 光标偏差超 2px：cursor=({x},{y}) target=({},{}) dx={dx} dy={dy}",
                api.x, api.y
            ));
        }

        // ── T5 type：真实注入 + UIA 回读（0 丢字） ──
        let text = "Conex-E2E-49 你好 中文输入测试 hello world ❤";
        let r = run_tool(&rig, "computer_type", json!({ "text": text }))
            .await
            .map_err(|e| format!("T5a type 注入失败：{e}"))?;
        let typed = r["typedChars"].as_u64().unwrap_or(0);
        if typed != text.chars().count() as u64 {
            return Err(format!(
                "T5b typedChars 不符：typed={typed} expected={}",
                text.chars().count()
            ));
        }
        std::thread::sleep(Duration::from_millis(500));
        let snap2 = run_tool(&rig, "computer_snapshot", json!({}))
            .await
            .map_err(|e| format!("T5c 回读快照失败：{e}"))?;
        let tree2 = &snap2["tree"];
        let readback = find_editor_preferred(tree2)
            .and_then(|n| n["value"].as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        let hitback = node_at_point(tree2, center.0, center.1)
            .and_then(|n| n["value"].as_str().map(|s| s.to_string()))
            .unwrap_or_default();
        if readback != text && !hitback.contains(text) {
            return Err(format!(
                "T5c UIA 回读 ≠ 注入文本：readback={readback:?} hitback={hitback:?}"
            ));
        }

        // ── T6 screenshot：PNG 魔数 + 尺寸 == spec 目标档 ──
        let shot = run_tool(&rig, "computer_screenshot", json!({}))
            .await
            .map_err(|e| format!("T6 screenshot 失败：{e}"))?;
        let data = shot["image"]["data"]
            .as_str()
            .ok_or_else(|| "T6a data 缺失".to_string())?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| format!("T6a base64 解码失败：{e}"))?;
        let png_magic =
            bytes.len() > 8 && bytes[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        if !png_magic {
            return Err("T6a PNG 魔数缺失".to_string());
        }
        let img = image::load_from_memory(&bytes).map_err(|e| format!("T6b 解码失败：{e}"))?;
        let (w, h) = (img.width(), img.height());
        let declared_w = shot["displayWidthPx"].as_u64().unwrap_or(0);
        let declared_h = shot["displayHeightPx"].as_u64().unwrap_or(0);
        if w as u64 != declared_w || h as u64 != declared_h {
            return Err(format!(
                "T6b 解码尺寸与返回形状不符：decoded={w}x{h} declared={declared_w}x{declared_h}"
            ));
        }
        if w != spec.target_w || h != spec.target_h {
            return Err(format!(
                "T6c 尺寸应等于 spec 目标档：declared={w}x{h} target={}x{}",
                spec.target_w, spec.target_h
            ));
        }

        // ── T7 感知版本号单调推进（快照→光标→截屏） ──
        let v1 = run_tool(&rig, "computer_snapshot", json!({}))
            .await
            .map_err(|e| format!("T7 snapshot 失败：{e}"))?;
        let v2 = run_tool(&rig, "computer_cursor_position", json!({}))
            .await
            .map_err(|e| format!("T7 cursor 失败：{e}"))?;
        let v3 = run_tool(&rig, "computer_screenshot", json!({}))
            .await
            .map_err(|e| format!("T7 screenshot 失败：{e}"))?;
        let (pv1, pv2, pv3) = (
            v1["perceptionVersion"].as_u64().unwrap_or(0),
            v2["perceptionVersion"].as_u64().unwrap_or(0),
            v3["perceptionVersion"].as_u64().unwrap_or(0),
        );
        if !(pv1 >= 1 && pv2 > pv1 && pv3 > pv2) {
            return Err(format!("T7 版本应单调推进：pv1={pv1} pv2={pv2} pv3={pv3}"));
        }

        // ── T8 白名单拒绝真实链：with_gate 注入不匹配白名单 ──
        let gated = RealComputerSession::new()
            .map_err(|e| format!("T8 门禁会话构造失败：{e}"))?
            .with_gate(Arc::new(WindowTargetGate::new(vec![WhitelistEntry::new(
                "绝不匹配的标题",
                None,
            )])));
        let gated_session: Arc<dyn ComputerOps> = Arc::new(gated);
        let rig2 = build_rig(gated_session);
        rig2.activation
            .request_desktop()
            .map_err(|e| format!("T8 桌面激活失败：{e}"))?;
        let e2 = run_tool(&rig2, "computer_click", json!({}))
            .await
            .expect_err("白名单外窗口应拒绝");
        if e2.code() != codes::TOOL_COMPUTER_ELEVATED_WINDOW {
            return Err(format!("T8 期望 elevated_window，实得 {e2}"));
        }

        Ok(())
    }
    .await;

    // 收尾：仅终止本测试拉起的记事本**进程树**（Win11 notepad 为双进程
    // 结构：launcher stub + 实际窗口进程；`child.kill()` 只杀 launcher 会
    // 残留窗口进程，须 taskkill /T 整树终止——用 PID 限定不误杀用户已开
    // 的记事本实例，与 49 rig 的 taskkill /IM 全量终止相比更克制），
    // 无论断言成败
    if let Ok(child) = notepad.as_mut() {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .output();
    }

    chain
}
