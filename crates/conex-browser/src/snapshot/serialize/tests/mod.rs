use super::*;
use crate::snapshot::collect::EnhancedNode;

fn opts<'a>(budgets: &'a BudgetConfig, previous: &'a HashSet<i64>) -> SerializeOptions<'a> {
    SerializeOptions::new(budgets, "test-session", previous)
}

/// §3.2 文档示例（登录页：搜索框 + shadow 组件 + 密码框 + iframe + canvas +
/// closed shadow）——根森林形态（每顶层元素一棵根树）。
fn login_fixture() -> Vec<EnhancedNode> {
    vec![
        EnhancedNode::element("input", 101)
            .attr("name", "q")
            .attr("placeholder", "搜索")
            .attr("aria-label", "搜索框")
            .bounds(0.0, 0.0, 300.0, 36.0),
        EnhancedNode::text_node("Search the web: 示例搜索结果页", 102),
        EnhancedNode::element("button", 103)
            .attr("aria-label", "搜索")
            .bounds(310.0, 0.0, 80.0, 36.0),
        // 开放 shadow：用户名/密码输入框
        EnhancedNode::element("div", 104)
            .marker(FrameMarker::ShadowOpen)
            .bounds(0.0, 60.0, 400.0, 120.0)
            .push(
                EnhancedNode::element("input", 105)
                    .attr("placeholder", "用户名")
                    .bounds(0.0, 0.0, 200.0, 32.0),
            )
            .push(
                EnhancedNode::element("input", 106)
                    .attr("type", "password")
                    .attr("placeholder", "密码")
                    .attr("value", "s3cret!")
                    .bounds(0.0, 40.0, 200.0, 32.0),
            ),
        EnhancedNode::element("button", 107).push(EnhancedNode::text_node("登录", 108)),
        EnhancedNode::element("a", 109)
            .attr("href", "/register")
            .push(EnhancedNode::text_node("注册", 110)),
        // 跨域 iframe 占位（无子文档）
        EnhancedNode::element("iframe", 111)
            .attr("src", "https://ads.example.com/ad.js")
            .marker(FrameMarker::Iframe)
            .bounds(0.0, 300.0, 300.0, 200.0),
        // canvas 盲区
        EnhancedNode::element("canvas", 112).bounds(400.0, 60.0, 200.0, 150.0),
        // closed shadow：AX 检出但无 backendNodeId 的不可操作元素
        EnhancedNode::element("div", 113)
            .marker(FrameMarker::ShadowClosed)
            .bounds(0.0, 520.0, 400.0, 80.0)
            .push(
                EnhancedNode::element("div", -1)
                    .attr("role", "button")
                    .bounds(0.0, 0.0, 100.0, 32.0)
                    .push(EnhancedNode::text_node("主题切换", -2)),
            ),
    ]
}

mod content;
mod golden_budget;
mod viewport_blind_zone;
