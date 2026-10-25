use super::common::{invalid_input, map_browser_err, not_ready, slot};
use crate::core_error::CoreError;
use crate::core_run_commands::CoreRunState;
use conex_browser::cdp::domains::Cookie as CdpCookie;
use conex_browser::import::storage_state::{
    build_import_plan, export_origins_from_cookies, export_storage_state,
    export_storage_state_with_origins, inject_origin_scripts, parse_storage_state,
    ExportAuthorization, ImportPlan, StorageStateError,
};
use serde::Serialize;
use std::sync::Arc;

/// 导入统计载荷（J1b，维度 16 §5.3/§5.4：数量脱敏，**不含任何 cookie value**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageImportPayload {
    /// 注入计划最终 cookie 数（同 (domain, name, path) 去重 + 空名过滤后）。
    pub cookies: usize,
    /// 含 localStorage 的 origin 数。
    pub origins: usize,
    /// localStorage 条目总数（注入计划面）。
    pub local_storage_items: usize,
    /// 已注册 origin 守卫恢复脚本数（§5.3 注入执行实际值）。
    pub injected_scripts: usize,
    /// 已直写 localStorage 条目数（§5.3 注入执行实际值）。
    pub injected_items: usize,
    /// 同键去重丢弃数（覆盖语义：最后一次出现者胜）。
    pub dropped_dupes: usize,
    /// 空 name 非法 cookie 跳过数（CDP setCookies 拒绝空 name）。
    pub skipped_empty_name: usize,
}

/// 导出 storage_state（J1b 接线 + P1-3 导出侧 origins 聚合，维度 16 §5.2
/// 实读面）。
///
/// ## 契约
/// - 入参 `authorized: bool`：**导出需显式授权**（§5.2）——前端必须先展示
///   授权对话框（含将导出的 cookie 数量与域名清单预览），用户确认后才传
///   `true`；`false` → 命令拒绝（未授权，**不执行实读**，零副作用）；
/// - 返回：标准 storage_state JSON（Playwright 兼容 `{ cookies, origins }`，
///   §5.1），**内存传递不落盘**（§5.4 强制面；写盘仅走前端显式「另存为」）；
///   origins 面（P1-3 接线）：origin 清单由 cookie domain 推导（协议按
///   secure 标志），经会话 LocalStorageChannel（`DOMStorage.getDOMStorageItems`）
///   逐 origin 实读聚合，输出标准形态 `{ origin, localStorage: [{ name, value }] }`；
///   返回 JSON 含 cookie value 明文——前端须防日志/审计泄露（§5.4 脱敏纪律：
///   日志/事件负载一律不输出 value）；
/// - 错误：未连接/恢复期 → `tool.browser.not_ready:<原因>`（不触发惰性启动，
///   须先 `browser_start`）；未授权 → 拒绝文案；CDP 实读失败 → 透传原因。
#[tauri::command]
pub(crate) async fn browser_export_storage_state(
    authorized: bool,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<String, CoreError> {
    // 授权先行：未授权直接拒绝，不执行实读（§5.2 显式授权，零副作用）
    if !authorized {
        return Err(CoreError::InvalidInput(
            "storage_state 导出未获显式授权（须授权对话框确认后 authorized=true）".to_string(),
        ));
    }
    let ops = slot(core.inner()).storage_ops();
    let cookies = ops
        .get_all_cookies()
        .await
        .map_err(|e| map_browser_err(not_ready(e)))?;
    // 导出侧 origins 聚合（P1-3 接线）：origin 清单由 cookie domain 推导
    // （协议按 secure 标志，非法 host 跳过），经会话 LocalStorageChannel
    // 逐 origin 实读；无 cookie / 推导不出合法 origin 时无需通道，直接返回
    // 空 origins（零 CDP 读取）
    let origins = export_origins_from_cookies(&cookies);
    let state = if origins.is_empty() {
        export_storage_state(&cookies, ExportAuthorization::Confirmed)
            .map_err(|e| map_browser_err(invalid_input(e.to_string())))?
    } else {
        // 通道不可用（未连接/无活动标签）→ not_ready（storage 命令不触发惰性启动）
        let channel = slot(core.inner())
            .local_storage_channel()
            .map_err(|e| map_browser_err(not_ready(e)))?;
        export_storage_state_with_origins(
            &cookies,
            &origins,
            ExportAuthorization::Confirmed,
            channel.as_ref(),
        )
        .await
        .map_err(|e| match e {
            // 防御性再检失败（推导面已过滤，正常不可达）：输入面错误
            StorageStateError::InvalidOrigin { .. } => {
                map_browser_err(invalid_input(e.to_string()))
            }
            // CDP 实读失败 → 透传原因（契约）
            other => CoreError::Internal(other.to_string()),
        })?
    };
    Ok(state.to_json())
}

/// 导入 storage_state（J1b 接线，维度 16 §5.3 注入面）。
///
/// ## 契约
/// - 入参 `json`：标准 storage_state JSON（§5.1；大小 ≤10MB、cookie ≤5000，
///   超限/非法 → `tool.invalid_input`）；
/// - 返回：脱敏统计载荷 `{ cookies, origins, localStorageItems, injectedScripts,
///   injectedItems, droppedDupes, skippedEmptyName }`（§5.4：不含任何
///   cookie value）；
/// - 错误：未连接/恢复期 → `tool.browser.not_ready:<原因>`；解析失败/超限/
///   domain/origin 守卫拒绝 → `tool.invalid_input:<原因>`；CDP 注入失败 → 透传。
///
/// ## 注入面（cookie + localStorage 两机制合并执行）
/// ① cookie 走 browser 级 `Storage.setCookies`（`to_cdp_params` 类型化参数：
/// 会话 cookie 移除 expires 字段、sameSite 归一化、同键幂等去重覆盖语义）；
/// ② localStorage 经 [inject_origin_scripts]（§5.3 注入执行）：每 origin
/// `Page.addScriptToEvaluateOnNewDocument` 注册**origin 守卫恢复脚本**
/// （脚本内先校验 `window.location.origin` 再 `setItem`，防跨站污染——守卫
/// 由解析层生成，K3 接线面）→ `DOMStorage.setDOMStorageItem` 直写当前页。
///
/// ## 执行序与回验（N8，M4 遗留 2 落地）
/// cookie 先于 localStorage 注入；注入后回读比对（`Storage.getCookies`
/// 回读，按注入计划逐键核对，见 [verify_cookie_injection]）——差异**仅记录
/// 日志不回滚**（取舍与理由见实现处注释）；localStorage 注入失败 → 返回
/// 错误（cookie 已注入不回滚——重导覆盖语义下幂等，无错误累积）。
#[tauri::command]
pub(crate) async fn browser_import_storage_state(
    json: String,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StorageImportPayload, CoreError> {
    let state =
        parse_storage_state(&json).map_err(|e| map_browser_err(invalid_input(e.to_string())))?;
    let plan = build_import_plan(&state);
    let params = plan.to_cdp_params();
    let ops = slot(core.inner()).storage_ops();
    ops.set_cookies(params)
        .await
        .map_err(|e| map_browser_err(not_ready(e)))?;
    // N8 回验（M4 遗留 2 落地）：注入后 `Storage.getCookies` 回读比对——
    // 以注入计划为基准逐键核对（域去点容差 + value 严格相等，见
    // verify_cookie_injection）。差异**只记录不回滚**，取舍与理由：
    // - 回滚需注入前快照（每次导入多一次实读、CDP 往返翻倍）且重注入会
    //   覆盖回读窗口内的并发变更（用户/页面在回验期间写入的 cookie）；
    // - 差异多为浏览器拒绝面（SameSite=None 未配 Secure、过期 cookie 等）
    //   或 CDP 域归一化差异，属可诊断信息而非注入失败——命令已尽力注入，
    //   回读失败（会话断连）时注入面同样可能已部分生效，报错反而掩盖；
    // - 重导覆盖语义幂等，下次导入自愈；诊断面经 warn 日志留痕。
    match ops.get_all_cookies().await {
        Ok(read_back) => {
            let missing = verify_cookie_injection(&plan, &read_back);
            if !missing.is_empty() {
                tracing::warn!(
                    target: "browser",
                    expected = plan.stats.cookies,
                    missing = missing.len(),
                    missing_keys = missing.join(","),
                    "storage_state 注入后回验差异（N8：记录不回滚）"
                );
            }
        }
        Err(error) => {
            // 回读失败（会话断连等）：注入已尽力生效，回验是增强面，跳过不阻断
            tracing::warn!(
                target: "browser",
                error = %error,
                "storage_state 注入后回验读回失败（跳过回验）"
            );
        }
    }
    // localStorage 注入（§5.3）：origin 守卫脚本注册 + DOMStorage 直写，
    // 经会话通道（BrowserSlot::local_storage_channel，未连接 → not_ready）
    let mut injected_scripts = 0usize;
    let mut injected_items = 0usize;
    if !plan.origin_scripts.is_empty() {
        let channel = slot(core.inner())
            .local_storage_channel()
            .map_err(|e| map_browser_err(not_ready(e)))?;
        let stats = inject_origin_scripts(channel.as_ref(), &plan)
            .await
            .map_err(|e| {
                match e {
                    // 防御性再检失败（非法 origin）：输入面错误
                    StorageStateError::InvalidOrigin { .. } => {
                        map_browser_err(invalid_input(e.to_string()))
                    }
                    other => CoreError::Internal(format!("localStorage 注入失败：{other}")),
                }
            })?;
        injected_scripts = stats.scripts;
        injected_items = stats.items;
    }
    Ok(StorageImportPayload {
        cookies: plan.stats.cookies,
        origins: plan.stats.origins,
        local_storage_items: plan.stats.local_storage_items,
        injected_scripts,
        injected_items,
        dropped_dupes: plan.stats.dropped_dupes,
        skipped_empty_name: plan.stats.skipped_empty_name,
    })
}

/// N8 回验比对纯函数（M4 遗留 2 落地）：以注入计划为基准，回读 cookie
/// 逐键核对。
///
/// 键 = `(domain 去前导点, name, path)`——CDP 对 host-only cookie 存无点域、
/// 域 cookie 存有点域，去点容差避免归一化误报；value 严格相等（注入效果
/// 的最终判据）。仅比对键+value，不比 expires/sameSite 等浏览器可归一化
/// 字段（避免二次归一化差异误报）。
///
/// 返回缺失键清单（`domain:name:path`；空 = 回验通过）。纯函数便于单测，
/// 命令层仅消费结果（记录日志，见 [browser_import_storage_state]）。
pub(crate) fn verify_cookie_injection(plan: &ImportPlan, read_back: &[CdpCookie]) -> Vec<String> {
    let mut missing = Vec::new();
    for c in &plan.cookies {
        let domain = c
            .domain
            .as_deref()
            .unwrap_or_default()
            .trim_start_matches('.');
        let path = c.path.as_deref().unwrap_or_default();
        let matched = read_back.iter().any(|rc| {
            rc.domain.trim_start_matches('.') == domain
                && rc.name == c.name
                && rc.path == path
                && rc.value == c.value
        });
        if !matched {
            missing.push(format!("{domain}:{}:{path}", c.name));
        }
    }
    missing
}
