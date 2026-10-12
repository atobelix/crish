//! MCP debug socket 加固（PE-07 T07.5：I-01 修复）
//!
//! 决策（AU-04 C21 唯一化 + 插件 rev=c7d271a 已支持 token 认证）：
//! - 路径 1 落地：`tauri-plugin-mcp` 原生 token 认证（不配置 auth_token 时
//!   插件自动生成随机 token，写入 `%TEMP%\tauri-mcp-4000.token` 边车文件，
//!   客户端经 `tauri-plugin-mcp-server` 桥自动发现；也可用
//!   `TAURI_MCP_AUTH_TOKEN` 环境变量固定）；
//! - 默认开启（2026-08-21 用户裁决，取代 PE-07 T07.5 / I-01「默认关闭」旧口径）：
//!   debug 构建启动即注册插件；仅 `CRISH_MCP_SOCKET=0`（精确匹配）时显式关闭，
//!   其余取值一律开启；
//! - release 双保险：注册点本身 `#[cfg(debug_assertions)]` 隔离 +
//!   插件自身 `allow_release_builds=false` 默认拒绝（双保险，防漏加 cfg）；
//! - 仅 loopback：`tcp_localhost(4000)`（127.0.0.1:4000，绑定不可改）；
//! - 命令面：`execute_js` 等高危命令由前端 `workbench_dev_mcp_enabled()` 查询
//!   `{enabled, execEnabled}` 后按需注册（execEnabled 需二次 env `CRISH_DEV_MCP_EXEC=1`）。
//!
//! 接线说明（集成 agent 在 main.rs）：
//! - debug 分支：`let builder = dev_mcp::register_if_enabled(builder);`
//!   （替代原无条件注册 tauri_plugin_mcp 的段落）
//! - 命令 `workbench_dev_mcp_enabled` 注册进 make_handlers（debug/release 均可，
//!   仅读环境变量，无 State 依赖）。

/// `CRISH_MCP_SOCKET` 环境变量名：默认开启；仅精确等于 "0" 时显式关闭
#[allow(dead_code)]
const MCP_SOCKET_ENV: &str = "CRISH_MCP_SOCKET";

// G11a 备注（登记先行面）：MCP_EXEC_ENV / mcp_exec_enabled / McpEnabledState /
// workbench_dev_mcp_enabled 为 command_manifest 登记先行（registered=false，
// 契约测试锚定 surface=gui），PE-07 T07.5 接线在途——dead_code 静音待接线。
/// `CRISH_DEV_MCP_EXEC` 环境变量名：二次显式开启 execute_js 等高危命令
#[allow(dead_code)]
const MCP_EXEC_ENV: &str = "CRISH_DEV_MCP_EXEC";
/// MCP socket 固定端口（loopback）
#[allow(dead_code)]
const MCP_SOCKET_PORT: u16 = 4000;

/// 读取开关环境变量（默认开启型）：仅精确等于 "0" 关闭，其余取值一律开启
/// （防 `CRISH_MCP_SOCKET=false` / `=no` 之类的近似取值误关；未设时默认开启）。
#[allow(dead_code)]
fn env_flag_default_on(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value != "0")
        .unwrap_or(true)
}

/// 读取开关环境变量（默认关闭型）：仅精确等于 "1" 生效，其余取值一律关闭
/// （防 `CRISH_DEV_MCP_EXEC=0` / `=true` 之类的近似取值误开）。
fn env_flag_default_off(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1")
        .unwrap_or(false)
}

/// MCP socket 是否开启（debug 构建默认开启 + `CRISH_MCP_SOCKET=0` 显式关闭；
/// release 由插件自身拒绝兜底）。
#[allow(dead_code)]
pub(crate) fn mcp_socket_enabled() -> bool {
    env_flag_default_on(MCP_SOCKET_ENV)
}

/// execute_js 等高危命令是否显式开启（二次 env，语义不变：仍须精确 "1"）。
#[allow(dead_code)]
pub(crate) fn mcp_exec_enabled() -> bool {
    env_flag_default_off(MCP_EXEC_ENV)
}

/// debug 构建下默认注册 tauri-plugin-mcp（2026-08-21 用户裁决）。
/// - 未设 `CRISH_MCP_SOCKET` 或取值非 "0"：注册插件（loopback 4000 + 原生
///   token 认证，不配置 auth_token 由插件自动生成随机 token）；
/// - `CRISH_MCP_SOCKET=0`（精确）：原样返回 builder（不注册插件，端口不监听）。
///
/// release 构建下该函数不参与编译（main.rs 由 `#[cfg(debug_assertions)]` 分支调用），
/// 插件自身的 `allow_release_builds=false` 作为第二重保险。
#[cfg(debug_assertions)]
pub(crate) fn register_if_enabled(
    builder: tauri::Builder<tauri::Wry>,
) -> tauri::Builder<tauri::Wry> {
    if !mcp_socket_enabled() {
        return builder;
    }
    builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("crish-agent-workbench".to_string())
            .start_socket_server(true)
            .tcp_localhost(MCP_SOCKET_PORT)
            // 不配置 auth_token：插件自动生成随机 token 并写入
            // `%TEMP%\tauri-mcp-4000.token`（0600），请求须携带 authToken 握手；
            // 需要固定 token 时用 TAURI_MCP_AUTH_TOKEN 环境变量（插件原生支持）。
            .stub_dialogs(true),
    ))
}

/// MCP 状态查询结果（camelCase 序列化，对齐 commandManifest 契约
/// `{ enabled, execEnabled }`）。
#[allow(dead_code)]
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 环境变量测试串行锁（env 为进程级状态，防并行测试互踩）
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// 清理开关环境变量
    fn clear_env() {
        std::env::remove_var(MCP_SOCKET_ENV);
        std::env::remove_var(MCP_EXEC_ENV);
    }

    /// 2026-08-21 裁决用例 1：socket 默认开启（未设 env → enabled=true）；
    /// exec 无二次 env 时仍默认关闭。
    #[test]
    fn socket_enabled_by_default_exec_disabled() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_env();
        assert!(mcp_socket_enabled());
        assert!(!mcp_exec_enabled());
    }

    /// 2026-08-21 裁决用例 2：socket 仅精确 "0" 显式关闭，
    /// 其余取值（含近似值）一律开启（防误关）。
    #[test]
    fn socket_env_only_exact_zero_disables() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(MCP_SOCKET_ENV, "0");
        assert!(!mcp_socket_enabled(), "exact `0` must disable");

        for value in ["1", "true", "TRUE", "no", "false", " 0", "0 ", "2", ""] {
            std::env::set_var(MCP_SOCKET_ENV, value);
            assert!(mcp_socket_enabled(), "value `{value}` must not disable");
        }
        clear_env();
    }

    /// exec 二次开关语义不变：仅精确 "1" 开启，其余取值一律关闭。
    #[test]
    fn exec_env_only_exact_one() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var(MCP_SOCKET_ENV);
        std::env::set_var(MCP_EXEC_ENV, "1");
        assert!(mcp_exec_enabled());

        for value in ["0", "true", "TRUE", "yes", " 1", "1 ", "2", ""] {
            std::env::set_var(MCP_EXEC_ENV, value);
            assert!(!mcp_exec_enabled(), "value `{value}` must not enable");
        }
        clear_env();
    }
}
