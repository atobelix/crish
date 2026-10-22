//! 原语分类与入参校验：元素/坐标/滚动点需求判定、定位结果提取、validate_request。

use super::{
    ActionError, ActionErrorKind, ActionRequest, Located, MAX_TYPE_CHARS, Primitive, ResolvedPoint,
    keyboard, upload,
};

/// 需要元素的原语（参数校验 + 定位前置）。
fn requires_element(primitive: &Primitive) -> bool {
    matches!(
        primitive,
        Primitive::Click { .. }
            | Primitive::Hover
            | Primitive::Drag { .. }
            | Primitive::Type { .. }
            | Primitive::Focus
            | Primitive::SelectOption { .. }
            | Primitive::Upload { .. }
    )
}

/// 坐标路径原语（§3.2：click/hover/drag 需要真实渲染位置）。
pub(super) fn needs_coords(primitive: &Primitive) -> bool {
    matches!(
        primitive,
        Primitive::Click { .. } | Primitive::Hover | Primitive::Drag { .. }
    )
}

/// 元素级滚动（§3.2：scrollIntoViewIfNeeded → 取 box → 容器内滚轮）。
pub(super) fn needs_scroll_point(primitive: &Primitive) -> bool {
    matches!(primitive, Primitive::Scroll { .. })
}

pub(super) fn require_point(located: Option<&Located>) -> Result<&ResolvedPoint, ActionError> {
    match located {
        Some(Located::Point { point, .. }) => Ok(point),
        _ => Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            "该原语需要坐标定位（元素不可见/未解析出注入点）",
        )),
    }
}

pub(super) fn require_node(located: Option<&Located>) -> Result<&i64, ActionError> {
    match located {
        Some(Located::Node { node_id, .. }) => Ok(node_id),
        _ => Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            "该原语需要无坐标定位（元素未解析出 nodeId）",
        )),
    }
}

/// 入参校验（非法参数一律 InvalidInput 致命，不重试；E2E 级穷举见各模块测试）。
pub(super) fn validate_request(req: &ActionRequest) -> Result<(), ActionError> {
    if requires_element(&req.primitive) && req.element.is_none() {
        return Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            "该原语必须携带元素索引",
        ));
    }
    if let Some(el) = req.element {
        if el.backend_node_id <= 0 {
            return Err(ActionError::new(
                ActionErrorKind::InvalidInput,
                "元素 backendNodeId 非法（非正数）",
            ));
        }
    }
    match &req.primitive {
        Primitive::Click { count, .. } => {
            if !matches!(count, 1 | 2) {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("click count 仅允许 1|2，收到 {count}"),
                ));
            }
        }
        Primitive::Scroll { amount, .. } => {
            if *amount <= 0 {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("scroll 距离必须为正数，收到 {amount}"),
                ));
            }
        }
        Primitive::Type { text, submit_key } => {
            if text.is_empty() && submit_key.is_none() {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    "type 文本为空且未指定提交键",
                ));
            }
            if text.chars().count() > MAX_TYPE_CHARS {
                let count = text.chars().count();
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!("type 文本超长（{count} 字符 > {MAX_TYPE_CHARS} 上限）"),
                ));
            }
            if let Some(key) = submit_key {
                keyboard::parse_key_sequence(key).map_err(|_| {
                    ActionError::new(
                        ActionErrorKind::InvalidInput,
                        format!("非法提交键名：{key}"),
                    )
                })?;
            }
        }
        Primitive::Key { keys } => {
            keyboard::parse_key_sequence(keys).map_err(|_| {
                ActionError::new(ActionErrorKind::InvalidInput, format!("非法键名：{keys}"))
            })?;
        }
        Primitive::SelectOption { value } => {
            if value.is_empty() {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    "select_option 选项值不能为空",
                ));
            }
        }
        Primitive::Upload { path } => {
            upload::validate_path(path.0.as_path())?;
        }
        Primitive::Evaluate(request) => {
            if request.expression.is_empty() {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    "evaluate 表达式不能为空",
                ));
            }
            if request.timeout_ms > 2000 {
                return Err(ActionError::new(
                    ActionErrorKind::InvalidInput,
                    format!(
                        "evaluate 求值硬限 2000ms（17 §3.2），收到 {}ms",
                        request.timeout_ms
                    ),
                ));
            }
        }
        Primitive::Hover | Primitive::Focus | Primitive::Drag { .. } => {}
    }
    Ok(())
}
