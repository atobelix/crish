//! 定位与坐标解析（维度 14 §3，locate.rs）
//!
//! 定位链（§3.1）：快照索引 → backendNodeId → `pushNodesByBackendIdsToFrontend`
//! 取前端树 nodeId →（坐标场景）`getBoxModel` → 中心点/遮挡检测。
//!
//! - backendNodeId 是快照与执行之间的**唯一契约**，nodeId 每次 push 均可能变化，
//!   不允许跨动作缓存（§3.1）；
//! - 坐标计算（§3.3）：`content` 8 数字 = 4 角点（左上/右上/右下/左下），对边中点取
//!   中心；视口裁剪 + 零尺寸检测，无效 → `NotInteractive`（触发 scrollIntoView 重试）；
//! - 遮挡检测（§3.4）：`elementFromPoint` 固定模板，`false` → `NotInteractive`
//!   （禁止坐标测距魔术数字补偿）；
//! - 跨域 iframe 元素一期返回 `Unsupported`（U-4：二期启用 session 路由）。

use crate::action::{ActionError, ActionErrorKind, PageOps};
use serde_json::json;

/// 视口尺寸（§3.3 坐标裁剪输入）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewportSize {
    pub width: f64,
    pub height: f64,
}

/// 注入点（§3.3：getBoxModel 计算出的点击/滚轮坐标）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedPoint {
    pub x: f64,
    pub y: f64,
}

/// 定位产物（§3.1 两种路径：无坐标直注 / 坐标路径）。
#[derive(Debug, Clone, PartialEq)]
pub enum Located {
    /// 无坐标路径：backendNodeId + 已 push 的前端树 nodeId
    Node { backend: i64, node_id: i64 },
    /// 坐标路径：backendNodeId + nodeId + 注入点（已过遮挡检测）
    Point { backend: i64, point: ResolvedPoint },
}

/// 遮挡检测固定模板（参数仅 x/y 数字，经序列化注入；目标元素经 objectId 绑定 `this`）。
/// 注意：必须是普通函数（`Runtime.callFunctionOn` 仅对普通函数绑定 objectId 的
/// `this`，箭头函数取词法 `this`=window → `this.contains` 抛 TypeError，联调 E3 根因）。
const OCCLUSION_TEMPLATE: &str =
    r#"function(x, y) { const el = document.elementFromPoint(x, y); return el === this || this.contains(el); }"#;

/// 无坐标路径定位（§3.1：push 取 nodeId；空 nodeIds → NodeStale）。
pub async fn resolve_node_id(
    ops: &dyn PageOps,
    backend_node_id: i64,
) -> Result<i64, ActionError> {
    let ids = ops.push_nodes(&[backend_node_id]).await?;
    ids.first()
        .copied()
        .filter(|id| *id > 0)
        .ok_or_else(|| {
            ActionError::new(
                ActionErrorKind::NodeStale,
                "pushNodesByBackendIdsToFrontend 返回空 nodeIds（节点已过期）",
            )
        })
}

/// 坐标路径定位（§3.2/§3.3/§3.4）：push → box → 中心点 → 遮挡检测。
///
/// box 无效（零尺寸/视口外）时 `scrollIntoViewIfNeeded` 后重取 box，最多 `max_scrolls`
/// 次（§3.2 步骤 1-3），仍失败 → `NotInteractive`。
pub async fn resolve_click_point(
    ops: &dyn PageOps,
    backend_node_id: i64,
    viewport: &ViewportSize,
    max_scrolls: u32,
) -> Result<ResolvedPoint, ActionError> {
    let mut node_id = resolve_node_id(ops, backend_node_id).await?;
    let mut scrolled = 0u32;
    loop {
        let model = ops.box_model(node_id).await?;
        if let Some(point) = click_point_from_model(&model, viewport) {
            if occlusion_ok(ops, node_id, &point).await? {
                return Ok(point);
            }
            // 遮挡 false：不猜坐标补偿，直接 NotInteractive（§3.4，快照可能过时）
            return Err(ActionError::new(
                ActionErrorKind::NotInteractive,
                "元素被遮挡（elementFromPoint 非目标或其包含链）",
            ));
        }
        // box 无效（零尺寸/视口外）→ scrollIntoViewIfNeeded → 重取 box（§3.2）
        if scrolled >= max_scrolls {
            break;
        }
        ops.scroll_into_view(node_id).await?;
        scrolled += 1;
        // 滚动后 nodeId 可能变化：重新 push（backendNodeId 稳定）
        node_id = resolve_node_id(ops, backend_node_id).await?;
    }
    Err(ActionError::new(
        ActionErrorKind::NotInteractive,
        "元素不可见（box 无效：零尺寸/视口外，滚动后仍不可见）",
    ))
}

/// 元素级滚动定位（§3.2 滚动容器路径）：scrollIntoViewIfNeeded → 取 box → 容器内注入点。
pub async fn resolve_scroll_point(
    ops: &dyn PageOps,
    backend_node_id: i64,
    viewport: &ViewportSize,
    max_scrolls: u32,
) -> Result<ResolvedPoint, ActionError> {
    let mut node_id = resolve_node_id(ops, backend_node_id).await?;
    let mut scrolled = 0u32;
    loop {
        let model = ops.box_model(node_id).await?;
        if let Some(point) = click_point_from_model(&model, viewport) {
            return Ok(point);
        }
        if scrolled >= max_scrolls {
            break;
        }
        ops.scroll_into_view(node_id).await?;
        scrolled += 1;
        node_id = resolve_node_id(ops, backend_node_id).await?;
    }
    Err(ActionError::new(
        ActionErrorKind::NotInteractive,
        "滚动容器内元素不可见（scrollIntoViewIfNeeded 后仍无有效 box）",
    ))
}

/// 从 getBoxModel 计算注入点（§3.3 公式）；None = box 无效（零尺寸/视口外）。
///
/// `content` 为 8 个数字 = 4 个点（左上/右上/右下/左下）；中心取对边中点；
/// 注入点必须落在 `[0, viewport.w/h)` 内；四角共点（零尺寸）视为不可见。
pub fn click_point_from_model(model: &crate::cdp::domains::BoxModel, viewport: &ViewportSize) -> Option<ResolvedPoint> {
    let content = &model.content;
    if content.len() < 8 {
        return None;
    }
    // 零尺寸检测（§3.3）：对边距离 < 0.5 视为共点（不可见）
    if (content[0] - content[4]).abs() < 0.5 && (content[1] - content[5]).abs() < 0.5 {
        return None;
    }
    let cx = (content[0] + content[4]) / 2.0;
    let cy = (content[1] + content[5]) / 2.0;
    // 视口裁剪（§3.3）：注入点必须落在 [0, w/h) 内
    if !(0.0..viewport.width).contains(&cx) || !(0.0..viewport.height).contains(&cy) {
        return None;
    }
    if !cx.is_finite() || !cy.is_finite() {
        return None;
    }
    Some(ResolvedPoint { x: cx, y: cy })
}

/// 遮挡检测（§3.4 第二层）：目标元素是其本身或其包含链，返回 false → NotInteractive。
pub async fn occlusion_ok(
    ops: &dyn PageOps,
    node_id: i64,
    point: &ResolvedPoint,
) -> Result<bool, ActionError> {
    let object_id = ops.resolve_node(node_id).await?;
    // 参数为原始数值（call_function_on 内部统一包装 CallArgument.value，勿二次包装）
    let args = vec![json!(point.x), json!(point.y)];
    let value = ops
        .call_function_on(&object_id, OCCLUSION_TEMPLATE, &args)
        .await?;
    // 非布尔返回值 → 保守按被遮挡处理（fail-closed）
    Ok(value.as_bool().unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;
    use crate::cdp::domains::BoxModel;

    fn box_at(x: f64, y: f64, w: f64, h: f64) -> BoxModel {
        BoxModel {
            content: vec![x, y, x + w, y, x + w, y + h, x, y + h],
            padding: vec![x, y, x + w, y, x + w, y + h, x, y + h],
            border: vec![x, y, x + w, y, x + w, y + h, x, y + h],
            margin: vec![x, y, x + w, y, x + w, y + h, x, y + h],
            width: w as i64,
            height: h as i64,
        }
    }

    /// §3.3 中心点计算与视口裁剪/零尺寸判定。
    #[test]
    fn click_point_calculation() {
        let viewport = ViewportSize { width: 1280.0, height: 720.0 };
        let model = box_at(10.0, 20.0, 100.0, 50.0);
        let pt = click_point_from_model(&model, &viewport).expect("应算出中心");
        assert_eq!(pt.x, 60.0);
        assert_eq!(pt.y, 45.0);

        // 零尺寸：四角共点
        let empty = box_at(5.0, 5.0, 0.0, 0.0);
        assert!(click_point_from_model(&empty, &viewport).is_none());

        // 视口外：负坐标 / 超出右边界
        let off_left = box_at(-50.0, 0.0, 10.0, 10.0);
        assert!(click_point_from_model(&off_left, &viewport).is_none());
        let off_right = box_at(1300.0, 0.0, 10.0, 10.0);
        assert!(click_point_from_model(&off_right, &viewport).is_none());

        // 内容不足 8 数字（异常响应）
        let malformed = BoxModel {
            content: vec![1.0, 2.0],
            padding: vec![],
            border: vec![],
            margin: vec![],
            width: 0,
            height: 0,
        };
        assert!(click_point_from_model(&malformed, &viewport).is_none());
    }

    /// 直注路径：push → nodeId（无坐标原语共用）。
    #[tokio::test]
    async fn resolve_node_direct() {
        let ops = MockOps::new();
        let node_id = resolve_node_id(&ops, 11).await.expect("应解析出 nodeId");
        assert_eq!(node_id, 111);
    }

    /// 节点过期：push 返回空 → NodeStale。
    #[tokio::test]
    async fn resolve_node_stale_when_push_empty() {
        let ops = MockOps::new(); // 未登记 backend 99 → 返回 -1 → 视为空
        let err = resolve_node_id(&ops, 99).await.expect_err("应 NodeStale");
        assert_eq!(err.kind, ActionErrorKind::NodeStale);
    }

    /// 坐标路径：box → 中心点；遮挡通过才返回。
    #[tokio::test]
    async fn resolve_point_ok() {
        let ops = MockOps::new();
        let viewport = ViewportSize { width: 1280.0, height: 720.0 };
        let pt = resolve_click_point(&ops, 11, &viewport, 2)
            .await
            .expect("应解析出注入点");
        assert_eq!(pt.x, 50.0);
        assert_eq!(pt.y, 25.0);
    }

    /// getBoxModel 失败（"Could not compute box model"）→ NodeStale（§5.1 表）。
    #[tokio::test]
    async fn box_model_failure_is_node_stale() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().box_models.remove(&111);
        let viewport = ViewportSize { width: 1280.0, height: 720.0 };
        let err = resolve_click_point(&ops, 11, &viewport, 2)
            .await
            .expect_err("应 NodeStale");
        assert_eq!(err.kind, ActionErrorKind::NodeStale);
    }

    /// 视口外元素：scrollIntoView 重试（≤2 次）→ 仍不可见 → NotInteractive。
    #[tokio::test]
    async fn offscreen_scroll_retries_then_not_interactive() {
        let ops = MockOps::new();
        // box 在视口外（x=2000）→ scrollIntoView 后（mock 位置不变）仍不可见
        ops.state.lock().unwrap().box_models.insert(
            111,
            box_at(2000.0, 0.0, 100.0, 50.0),
        );
        let viewport = ViewportSize { width: 1280.0, height: 720.0 };
        let err = resolve_click_point(&ops, 11, &viewport, 2)
            .await
            .expect_err("应 NotInteractive");
        assert_eq!(err.kind, ActionErrorKind::NotInteractive);
        assert_eq!(ops.count(MockOp::ScrollIntoView), 2, "滚动重试最多 2 次");
    }

    /// 遮挡 false（elementFromPoint 非目标）→ NotInteractive，不派发。
    #[tokio::test]
    async fn occluded_is_not_interactive() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().occlusion = false;
        let viewport = ViewportSize { width: 1280.0, height: 720.0 };
        let err = resolve_click_point(&ops, 11, &viewport, 2)
            .await
            .expect_err("应 NotInteractive");
        assert_eq!(err.kind, ActionErrorKind::NotInteractive);
        assert_eq!(ops.count(MockOp::MouseEvent), 0, "被遮挡不得派发坐标");
    }

    /// 回归（联调 E3 根因 1）：遮挡模板必须为普通函数——`Runtime.callFunctionOn`
    /// 仅对普通函数绑定 objectId 的 `this`；箭头函数取词法 this=window，
    /// `this.contains` 抛 TypeError，真实浏览器点击在遮挡检测即失败。
    #[test]
    fn occlusion_template_is_regular_function() {
        assert!(
            OCCLUSION_TEMPLATE.starts_with("function("),
            "遮挡模板须为普通函数（callFunctionOn 需 this 绑定）：{OCCLUSION_TEMPLATE}"
        );
        assert!(
            !OCCLUSION_TEMPLATE.starts_with('('),
            "禁止箭头函数形态：{OCCLUSION_TEMPLATE}"
        );
        assert!(
            OCCLUSION_TEMPLATE.contains("el === this"),
            "模板须依赖 this 绑定目标元素"
        );
    }

    /// 回归（联调 E3 根因 2）：遮挡检测参数必须为原始数值——call_function_on
    /// 内部统一包装 CallArgument.value，调用方二次包装会让页面收到对象而非数字
    /// （elementFromPoint 入参 NaN → 误判遮挡）。
    #[tokio::test]
    async fn occlusion_passes_raw_coords() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().occlusion = true;
        let ok = occlusion_ok(&ops, 11, &ResolvedPoint { x: 10.0, y: 20.0 })
            .await
            .expect("遮挡检测执行");
        assert!(ok, "mock 放行时应判定未遮挡");
        let calls = ops.calls_of(MockOp::CallFunctionOn);
        assert!(!calls.is_empty(), "应发起 callFunctionOn 遮挡检测");
        let detail = &calls[0].detail;
        assert!(
            detail.contains("args=[Number(10.0), Number(20.0)]"),
            "参数应为原始数值：{detail}"
        );
        assert!(
            !detail.contains("{\"value\":"),
            "不得二次包装 CallArgument：{detail}"
        );
    }
}
