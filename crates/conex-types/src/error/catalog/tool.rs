//! tool / browser / computer 域注册条目

use crate::error::{codes, CrishErrorCategory, CrishErrorInfo};

error_catalog_table! {
    // ── tool 域 ──
    m.insert(
        codes::TOOL_NOT_FOUND,
        CrishErrorInfo {
            code: codes::TOOL_NOT_FOUND,
            title: "工具未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.check_name",
        },
    );
    m.insert(
        codes::TOOL_INVALID_INPUT,
        CrishErrorInfo {
            code: codes::TOOL_INVALID_INPUT,
            title: "工具入参非法",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.tool.fix_input",
        },
    );
    m.insert(
        codes::TOOL_EXECUTION_FAILED,
        CrishErrorInfo {
            code: codes::TOOL_EXECUTION_FAILED,
            title: "工具执行失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.tool.retry",
        },
    );
    m.insert(
        codes::TOOL_PATH_ESCAPE,
        CrishErrorInfo {
            code: codes::TOOL_PATH_ESCAPE,
            title: "路径越界",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.tool.check_path",
        },
    );
    m.insert(
        codes::TOOL_VERSION_CONFLICT,
        CrishErrorInfo {
            code: codes::TOOL_VERSION_CONFLICT,
            title: "文档版本冲突",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.tool.refresh_and_retry",
        },
    );
    // T-D-08（REQ-D04 硬沙箱）：越权写拒绝——Permanent/不可重试（确定拒绝，
    // 目标路径与允许范围在错误消息载荷中，可指引调整或走权限申请通道）
    m.insert(
        codes::TOOL_WRITE_NOT_ALLOWED,
        CrishErrorInfo {
            code: codes::TOOL_WRITE_NOT_ALLOWED,
            title: "写入路径不在允许范围内",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.request_path_allowance",
        },
    );
    // F8-02（I4-M3 写路径互斥）：并发互斥冲突——Permanent/不可重试（确定拒绝，
    // 等待占用者释放后由主 agent 编排串行重试；错误消息载荷含占用者/时间/有效期）。
    // 与 write_not_allowed 语义独立：白名单放行但被占用仍返回本码
    m.insert(
        codes::TOOL_WRITE_PATH_CONFLICT,
        CrishErrorInfo {
            code: codes::TOOL_WRITE_PATH_CONFLICT,
            title: "写入路径互斥冲突",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.wait_retry",
        },
    );
    // session-integrity-repair 02 §4.1 F01：中断/取消/未知三码注册
    m.insert(
        codes::TOOL_ABORTED_BEFORE_DISPATCH,
        CrishErrorInfo {
            code: codes::TOOL_ABORTED_BEFORE_DISPATCH,
            title: "工具分发前已中止",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.aborted_before_dispatch",
        },
    );
    m.insert(
        codes::TOOL_CANCELLED,
        CrishErrorInfo {
            code: codes::TOOL_CANCELLED,
            title: "工具已被取消",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.cancelled",
        },
    );
    m.insert(
        codes::TOOL_OUTCOME_UNKNOWN,
        CrishErrorInfo {
            code: codes::TOOL_OUTCOME_UNKNOWN,
            title: "工具结果未知（崩溃自愈）",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.outcome_unknown",
        },
    );
    // X04 P4：执行期分类码（session-loop ToolErrorKind 双向映射登记）——
    // 仅超时可重试；审批/策略/控制类均为确定性拒绝，不可重试
    m.insert(
        codes::TOOL_TIMEOUT,
        CrishErrorInfo {
            code: codes::TOOL_TIMEOUT,
            title: "工具执行超时",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.tool.retry",
        },
    );
    m.insert(
        codes::TOOL_USER_DENIED,
        CrishErrorInfo {
            code: codes::TOOL_USER_DENIED,
            title: "用户拒绝执行",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.check_permission",
        },
    );
    m.insert(
        codes::TOOL_APPROVAL_EXPIRED,
        CrishErrorInfo {
            code: codes::TOOL_APPROVAL_EXPIRED,
            title: "审批已过期",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.request_approval",
        },
    );
    m.insert(
        codes::TOOL_REQUIRES_APPROVAL,
        CrishErrorInfo {
            code: codes::TOOL_REQUIRES_APPROVAL,
            title: "工具调用需要审批",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.request_approval",
        },
    );
    m.insert(
        codes::TOOL_SOFT_DENY,
        CrishErrorInfo {
            code: codes::TOOL_SOFT_DENY,
            title: "工具调用被软拒绝",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.check_policy",
        },
    );
    m.insert(
        codes::TOOL_POLICY_BLOCKED,
        CrishErrorInfo {
            code: codes::TOOL_POLICY_BLOCKED,
            title: "安全策略阻断",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.tool.check_policy",
        },
    );
    m.insert(
        codes::TOOL_STREAM_ERROR_BEFORE_DISPATCH,
        CrishErrorInfo {
            code: codes::TOOL_STREAM_ERROR_BEFORE_DISPATCH,
            title: "流式错误导致工具未派发",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.check_network",
        },
    );
    // ── browser 域（9 正式码：17 文档 §1.3，R-9-2/R-8/U-12 语义）──
    // R-9-2：恢复期工具门禁——Transient/可重试（等待恢复完成重试）
    m.insert(
        codes::TOOL_BROWSER_NOT_READY,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_NOT_READY,
            title: "浏览器恢复中",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.browser.wait_recovery",
        },
    );
    // 17 §4：域名门禁拦截——Permanent/不可重试（策略拒绝，需改目标域）
    m.insert(
        codes::TOOL_BROWSER_GATE_BLOCKED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_GATE_BLOCKED,
            title: "域名门禁拦截",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.browser.check_domain",
        },
    );
    // 17 §2.3：能力位默认关闭——Security/不可重试（需显式开启）
    m.insert(
        codes::TOOL_BROWSER_CAPABILITY_DISABLED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_CAPABILITY_DISABLED,
            title: "能力未开启",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.browser.enable_capability",
        },
    );
    // R-1：快照版本失效——Transient/可重试（重拍快照后重试）
    m.insert(
        codes::TOOL_BROWSER_STALE_SNAPSHOT,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_STALE_SNAPSHOT,
            title: "快照版本失效",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.browser.refresh_snapshot",
        },
    );
    // 节点过期——Transient/可重试（重拍快照后重试）
    m.insert(
        codes::TOOL_BROWSER_NODE_GONE,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_NODE_GONE,
            title: "元素已过期",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.browser.refresh_snapshot",
        },
    );
    // R-8：用户接管/急停吊销——Permanent/不可重试（不计入重试额度，编排层重试）
    m.insert(
        codes::TOOL_BROWSER_CANCELLED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_CANCELLED,
            title: "浏览器动作已取消",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.browser.none",
        },
    );
    // 17 §3：evaluate 白名单外——Security/不可重试
    m.insert(
        codes::TOOL_BROWSER_EVAL_FORBIDDEN,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_EVAL_FORBIDDEN,
            title: "evaluate 被拒",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.browser.check_eval_policy",
        },
    );
    // 15 MAX_TABS 上限——Permanent/不可重试
    m.insert(
        codes::TOOL_BROWSER_TAB_LIMIT_EXCEEDED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_TAB_LIMIT_EXCEEDED,
            title: "标签数量超限",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.browser.close_tabs",
        },
    );
    // P1 接线前——Permanent/不可重试（引擎侧接线后消除）
    m.insert(
        codes::TOOL_BROWSER_UNWIRED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_UNWIRED,
            title: "浏览器能力未接线",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.browser.check_supported",
        },
    );
    // ── computer 域（8 正式码：06 文档 §5 码表语义 + 任务分类裁决）──
    // 参数非法——Permanent/不可重试（模型修参后重试，非自动重试）
    m.insert(
        codes::TOOL_COMPUTER_INVALID_PARAMS,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_INVALID_PARAMS,
            title: "参数非法",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.fix_input",
        },
    );
    // 坐标越界——Permanent/不可重试（模型需取新感知）
    m.insert(
        codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS,
            title: "坐标越界",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.refresh_perception",
        },
    );
    // 提权窗口——Security/不可重试（UI-PIA 会话隔离，需用户手动操作）
    m.insert(
        codes::TOOL_COMPUTER_ELEVATED_WINDOW,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_ELEVATED_WINDOW,
            title: "提权窗口拒绝",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.computer.manual_operation",
        },
    );
    // 会话未开启——Permanent/不可重试（需用户重新显式开启）
    m.insert(
        codes::TOOL_COMPUTER_NOT_ENABLED,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_NOT_ENABLED,
            title: "会话未开启",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.enable_session",
        },
    );
    // 会话未就绪——Transient/可重试（等待会话注入/恢复完成）
    m.insert(
        codes::TOOL_COMPUTER_NOT_READY,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_NOT_READY,
            title: "电脑会话未就绪",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.computer.wait_retry",
        },
    );
    // 急停/取消——Permanent/不可重试（对齐 browser.cancelled，不计入重试额度）
    m.insert(
        codes::TOOL_COMPUTER_CANCELLED,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_CANCELLED,
            title: "电脑操作已取消",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.computer.none",
        },
    );
    // 能力缺失——Security/不可重试（UIA+视觉双通道皆无，缺依赖）
    m.insert(
        codes::TOOL_COMPUTER_CAPABILITY_UNAVAILABLE,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_CAPABILITY_UNAVAILABLE,
            title: "能力不可用",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.computer.check_capability",
        },
    );
    // 未接线——Permanent/不可重试（骨架占位，实施轮接线后消除）
    m.insert(
        codes::TOOL_COMPUTER_UNWIRED,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_UNWIRED,
            title: "电脑能力未接线",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.check_supported",
        },
    );
}
