//! 启动参数构建（维度 10 §3，纯函数，单测友好）
//!
//! 契约：
//! - §3.2 参数表全量按序输出（预置 → 用户配置 → 环境自适应 → WebRTC 收紧）；
//! - 每个 `--enable-features` 只允许出现一次（Chrome 仅认最后一个同名开关），
//!   所有 feature 合并进单条开关（§3.2 注记）；
//! - §3.4 红线参数「永不出现」：本模块对 `extra_args` 做逐项消毒，
//!   大小写/前缀变体一律剔除（单测穷举断言）；
//! - 环境自适应开关（--no-sandbox/--disable-dev-shm-usage）仅容器/CI/root 场景，
//!   由 `env_adaptive_flags()` 探测，默认不出现（§3.3）。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use std::path::Path;

/// 引擎模式（§3.1/§3.4/§3.5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EngineMode {
    /// 默认主路径：无窗口渲染（D-2 裁决：独立窗口直操面否决）。
    #[default]
    HeadlessNew,
    /// 配置项：离屏窗口（罕见站点兼容/DRM/WebGL 合成差异时切换，§3.5）。
    HeadedOffscreen,
}

/// 红线参数前缀（§3.4 全表 + 媒体/通知权限类 + 固定端口）。
///
/// 匹配语义：参数去掉前导 `-` 后与表项大小写不敏感比较；
/// `--remote-debugging-port` 由本模块固定输出 `=0`，任何外部注入一律剔除。
pub const RED_LINE_FLAGS: &[&str] = &[
    "enable-automation",
    "remote-allow-origins",
    "ignore-certificate-errors",
    "allow-file-access-from-files",
    "disable-web-security",
    "load-extension",
    "start-maximized",
    "restore-last-session",
    "use-fake-ui-for-media-stream",
    "disable-notifications",
    "remote-debugging-port",
];

/// build_args 输入（纯数据，测试直接构造）。
#[derive(Debug, Clone)]
pub struct ArgInputs<'a> {
    /// 会话/受管 profile 目录（→ `--user-data-dir`）。
    pub user_data_dir: &'a Path,
    /// 初始视口（面板尺寸，→ `--window-size`；§3.2 第 5 行）。
    pub viewport: (u32, u32),
    /// 引擎模式。
    pub mode: EngineMode,
    /// 导入 profile 场景：`--password-store=basic`/`--use-mock-keychain` 替换为真实 keychain（§3.2 第 23 行）。
    pub imported_profile: bool,
    /// 域名门禁启用（维度 17）→ WebRTC 传输层收紧（§3.2 第 22 行，置后防覆盖）。
    pub restrict_webrtc: bool,
    /// 维度 12/14 追加参数（enable-features 合并 + 红线消毒）。
    pub extra_args: &'a [String],
    /// 环境自适应参数（§3.3），由 `env_adaptive_flags()` 产出后传入。
    pub adaptive: &'a [String],
}

/// 参数 flag 提取：去前导 `-`，保留 `=` 前部分，小写。
fn flag_of(arg: &str) -> String {
    let trimmed = arg.trim_start_matches('-');
    trimmed
        .split('=')
        .next()
        .map(|f| f.trim())
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// 是否命中红线（大小写不敏感，前缀变体统一命中）。
pub fn is_red_line(arg: &str) -> bool {
    let flag = flag_of(arg);
    RED_LINE_FLAGS.iter().any(|r| *r == flag)
}

/// 抽取 `--enable-features=` 的合并值（大小写不敏感前缀，保留原文大小写）。
fn feature_value_of(arg: &str) -> Option<&str> {
    let trimmed = arg.trim_start_matches('-');
    if trimmed.to_ascii_lowercase().starts_with("enable-features=") {
        trimmed.split_once('=').map(|(_, v)| v)
    } else {
        None
    }
}

/// 消毒用户参数：剔除红线项，抽取 enable-features 合并值，其余透传。
fn sanitize_extra(extra: &[String]) -> (Vec<&str>, Vec<&str>) {
    let mut kept = Vec::new();
    let mut features = Vec::new();
    for arg in extra {
        if is_red_line(arg) {
            continue;
        }
        if let Some(rest) = feature_value_of(arg) {
            for f in rest.split(',') {
                let f = f.trim();
                if !f.is_empty() {
                    features.push(f);
                }
            }
        } else {
            kept.push(arg.as_str());
        }
    }
    (kept, features)
}

/// 构建启动参数（§3.2 全量 + 追加顺序）。
pub fn build_args(inputs: &ArgInputs<'_>) -> Vec<String> {
    let (extra_kept, extra_features) = sanitize_extra(inputs.extra_args);
    let mut all_features: Vec<&str> = Vec::new();
    for f in extra_features {
        all_features.push(f);
    }
    // 预置参数（§3.2 第 1-24 行，按表顺序）
    let mut args: Vec<String> = Vec::new();
    args.push("--remote-debugging-port=0".to_string()); // 1 随机端口（内核分配，D-9）
    args.push("--remote-debugging-address=127.0.0.1".to_string()); // 2 显式 loopback
    args.push(format!("--user-data-dir={}", inputs.user_data_dir.display())); // 3 独立 profile
    match inputs.mode {
        EngineMode::HeadlessNew => {
            args.push("--headless=new".to_string()); // 4 无窗口渲染
        }
        EngineMode::HeadedOffscreen => {
            // §3.5：去掉 --headless=new，离屏定位（Selenium 系成熟做法）
            args.push("--window-position=-32000,-32000".to_string());
        }
    }
    args.push(format!(
        "--window-size={},{}",
        inputs.viewport.0, inputs.viewport.1
    )); // 5 初始视口
    args.push("--no-first-run".to_string()); // 6
    args.push("--no-default-browser-check".to_string()); // 7
    args.push("--disable-background-networking".to_string()); // 8
    args.push("--disable-component-update".to_string()); // 9
    args.push("--disable-sync".to_string()); // 10
    args.push("--disable-backgrounding-occluded-windows".to_string()); // 11 screencast 帧连续性
    args.push("--disable-renderer-backgrounding".to_string()); // 12 多标签协同
    args.push("--disable-hang-monitor".to_string()); // 13
    args.push("--disable-prompt-on-repost".to_string()); // 14
    args.push("--disable-popup-blocking".to_string()); // 15 登录/SSO 弹窗流
    args.push("--disable-extensions".to_string()); // 16 最小权限
    args.push("--disable-default-apps".to_string()); // 17
    args.push("--metrics-recording-only".to_string()); // 18
    args.push("--hide-crash-restore-bubble".to_string()); // 19 崩溃自动重启 UX 必需
    args.push("--disable-features=Translate".to_string()); // 20
    if !all_features.is_empty() {
        args.push(format!("--enable-features={}", all_features.join(","))); // 21 单开关合并
    }
    // keychain 语义（§3.2 第 23 行）：临时 profile 不触碰系统密码库；导入 profile 用真实 keychain
    if !inputs.imported_profile {
        args.push("--password-store=basic".to_string());
        args.push("--use-mock-keychain".to_string());
    }
    args.push("--no-pings".to_string()); // 24
    // headless 恒定追加：渲染兼容参数（§3.3），无 GPU 环境防静默崩溃
    if inputs.mode == EngineMode::HeadlessNew {
        args.push("--enable-unsafe-swiftshader".to_string());
    }
    // 用户配置参数（消毒后）
    args.extend(extra_kept.iter().map(|s| s.to_string()));
    // 环境自适应参数（§3.3：仅容器/CI/root 场景由调用方注入）
    args.extend(inputs.adaptive.iter().cloned());
    // WebRTC 收紧（§3.2 第 22 行：置后防覆盖）
    if inputs.restrict_webrtc {
        args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string());
    }
    args
}

/// 环境自适应探测（§3.3）：CI 环境变量 / unix 容器特征 / root。
/// 桌面首发场景默认返回空（即不输出任何降级开关）。
/// 豁免 clippy 子进程禁令：`id -u` 为固定参数系统工具探测（无用户自由参数、
/// 同步等待、不脱离会话存活），与「内部进程管理原语」同豁免面。
#[allow(clippy::disallowed_methods)]
pub fn env_adaptive_flags() -> Vec<String> {
    let mut flags = Vec::new();
    if is_ci_or_container() {
        flags.push("--no-sandbox".to_string());
        flags.push("--disable-dev-shm-usage".to_string());
    }
    flags
}

/// CI 环境变量（GITHUB_ACTIONS/Jenkins/GitLab 等）或容器特征（/.dockerenv、cgroup）。
pub fn is_ci_or_container() -> bool {
    for var in [
        "CI",
        "GITHUB_ACTIONS",
        "GITLAB_CI",
        "JENKINS_URL",
        "TF_BUILD",
        "CIRCLECI",
        "BUILDKITE",
    ] {
        if std::env::var_os(var).is_some_and(|v| !v.is_empty()) {
            return true;
        }
    }
    #[cfg(unix)]
    {
        if std::path::Path::new("/.dockerenv").exists() {
            return true;
        }
        if let Ok(cgroup) = std::fs::read_to_string("/proc/1/cgroup") {
            if cgroup.contains("docker") || cgroup.contains("podman") || cgroup.contains("lxc") {
                return true;
            }
        }
        // unix euid=0（root）：id -u 探测，失败视为非 root
        if let Ok(out) = std::process::Command::new("id").arg("-u").output() {
            if let Ok(text) = String::from_utf8(out.stdout) {
                if text.trim() == "0" {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_inputs<'a>() -> ArgInputs<'a> {
        ArgInputs {
            user_data_dir: Path::new("C:\\profile\\sess"),
            viewport: (1280, 720),
            mode: EngineMode::HeadlessNew,
            imported_profile: false,
            restrict_webrtc: false,
            extra_args: &[],
            adaptive: &[],
        }
    }

    /// §3.2 参数表全量断言（第 1-24 行关键项）。
    #[test]
    fn contains_required_flags() {
        let args = build_args(&base_inputs());
        let joined = args.join("\n");
        for flag in [
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--user-data-dir=C:\\profile\\sess",
            "--headless=new",
            "--window-size=1280,720",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-hang-monitor",
            "--disable-prompt-on-repost",
            "--disable-popup-blocking",
            "--disable-extensions",
            "--disable-default-apps",
            "--metrics-recording-only",
            "--hide-crash-restore-bubble",
            "--disable-features=Translate",
            "--password-store=basic",
            "--use-mock-keychain",
            "--no-pings",
            "--enable-unsafe-swiftshader",
        ] {
            assert!(joined.contains(flag), "缺少参数：{flag}；实际：{joined}");
        }
    }

    /// §3.4 红线参数注入后永不出现（8 项主红线 + 权限类 + 固定端口），
    /// 含大小写/前缀变体穷举。
    #[test]
    fn never_contains_red_lines() {
        let variants = [
            // 精确形式
            "--enable-automation",
            "--remote-allow-origins=*",
            "--ignore-certificate-errors",
            "--allow-file-access-from-files",
            "--disable-web-security",
            "--load-extension",
            "--start-maximized",
            "--restore-last-session",
            "--use-fake-ui-for-media-stream",
            "--disable-notifications",
            "--remote-debugging-port=9222",
            // 大小写变体
            "--ENABLE-AUTOMATION",
            "--Enable-Automation",
            "--REMOTE-ALLOW-ORIGINS=*",
            "--Ignore-Certificate-Errors",
            "--ALLOW-FILE-ACCESS-FROM-FILES",
            "--Disable-Web-Security",
            "--LOAD-EXTENSION",
            "--Start-Maximized",
            "--RESTORE-LAST-SESSION",
            "--Use-Fake-Ui-For-Media-Stream",
            "--Disable-Notifications",
            "--Remote-Debugging-Port=9242",
            // 无前缀/去横线变体（flag 语义仍命中）
            "enable-automation",
            "remote-allow-origins=http://x",
            "ignore-certificate-errors=true",
            "disable-web-security",
            "load-extension=/path/to/ext",
            "restore-last-session",
            "start-maximized",
            "remote-debugging-port=0", // 即使 =0 也不接受外部注入（固定由本模块输出）
        ];
        let extra: Vec<String> = variants.iter().map(|s| s.to_string()).collect();
        let mut inputs = base_inputs();
        inputs.extra_args = &extra;
        let args = build_args(&inputs);
        let lower_joined = args.join(" ").to_ascii_lowercase();
        for v in variants {
            let flag = v
                .trim_start_matches('-')
                .split('=')
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            if flag == "remote-debugging-port" {
                // 只允许本模块输出的 =0 单例
                assert_eq!(
                    lower_joined.matches("remote-debugging-port").count(),
                    1,
                    "固定端口参数必须且仅出现一次：{v}"
                );
            } else {
                assert!(
                    !lower_joined.contains(&flag),
                    "红线参数变体泄漏：{v} → {lower_joined}"
                );
            }
        }
    }

    /// 合并后全局仅一个 `--enable-features=` 开关。
    #[test]
    fn single_enable_features_switch() {
        let extra: Vec<String> = vec![
            "--enable-features=A,B".to_string(),
            "--enable-features=C".to_string(),
            "--enable-features=D,E".to_string(),
        ];
        let mut inputs = base_inputs();
        inputs.extra_args = &extra;
        let args = build_args(&inputs);
        let joined = args.join(" ");
        assert_eq!(
            joined.matches("--enable-features=").count(),
            1,
            "enable-features 必须合并为单开关：{joined}"
        );
        assert!(joined.contains("--enable-features=A,B,C,D,E"));
    }

    /// 无 feature 注入时不出 enable-features 开关（可选的单开关语义）。
    #[test]
    fn enable_features_absent_when_empty() {
        let args = build_args(&base_inputs());
        assert!(!args.join(" ").contains("--enable-features="));
    }

    /// 导入 profile 场景：password-store/use-mock-keychain 被替换（不出现）。
    #[test]
    fn imported_profile_swaps_keychain() {
        let mut inputs = base_inputs();
        inputs.imported_profile = true;
        let args = build_args(&inputs);
        let joined = args.join(" ");
        assert!(!joined.contains("--password-store=basic"));
        assert!(!joined.contains("--use-mock-keychain"));
    }

    /// headed 离屏模式：无 --headless=new，含离屏定位与窗口尺寸。
    #[test]
    fn headed_offscreen_mode() {
        let mut inputs = base_inputs();
        inputs.mode = EngineMode::HeadedOffscreen;
        let args = build_args(&inputs);
        let joined = args.join(" ");
        assert!(!joined.contains("--headless=new"));
        assert!(joined.contains("--window-position=-32000,-32000"));
        assert!(joined.contains("--window-size=1280,720"));
        assert!(!joined.contains("--enable-unsafe-swiftshader"), "headed 模式无 swiftshader");
    }

    /// WebRTC 收紧：仅 restrict_webrtc=true 时出现，且位于末尾（防覆盖）。
    #[test]
    fn webrtc_tightening_only_when_gated() {
        let args = build_args(&base_inputs());
        assert!(!args.join(" ").contains("force-webrtc"));

        let mut inputs = base_inputs();
        inputs.restrict_webrtc = true;
        let args = build_args(&inputs);
        assert_eq!(
            args.last().map(String::as_str),
            Some("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
            "WebRTC 收紧必须置后"
        );
    }

    /// 环境自适应：注入 adaptive 参数 → 透传；默认（桌面）不出 no-sandbox。
    #[test]
    fn adaptive_flags_passthrough() {
        let args = build_args(&base_inputs());
        assert!(!args.join(" ").contains("--no-sandbox"), "桌面首发默认不加降级开关");
        let adaptive = vec![
            "--no-sandbox".to_string(),
            "--disable-dev-shm-usage".to_string(),
        ];
        let mut inputs = base_inputs();
        inputs.adaptive = &adaptive;
        let args = build_args(&inputs);
        let joined = args.join(" ");
        assert!(joined.contains("--no-sandbox"));
        assert!(joined.contains("--disable-dev-shm-usage"));
    }

    /// 普通 extra 参数透传（非红线非 feature）。
    #[test]
    fn extra_args_passthrough() {
        let extra = vec!["--autoplay-policy=no-user-gesture-required".to_string()];
        let mut inputs = base_inputs();
        inputs.extra_args = &extra;
        let args = build_args(&inputs);
        assert!(args.join(" ").contains("--autoplay-policy=no-user-gesture-required"));
    }

    /// 参数顺序：预置参数在最前，WebRTC 置后，环境自适应介于其间。
    #[test]
    fn ordering_preset_then_user_then_adaptive_then_webrtc() {
        let extra = vec!["--autoplay-policy=no-user-gesture-required".to_string()];
        let adaptive = vec!["--no-sandbox".to_string()];
        let mut inputs = base_inputs();
        inputs.extra_args = &extra;
        inputs.adaptive = &adaptive;
        inputs.restrict_webrtc = true;
        let args = build_args(&inputs);
        let pos = |needle: &str| {
            args.iter()
                .position(|a| a.starts_with(needle))
                .expect("参数必须存在")
        };
        assert!(pos("--user-data-dir") < pos("--autoplay-policy"));
        assert!(pos("--autoplay-policy") < pos("--no-sandbox"));
        assert!(pos("--no-sandbox") < pos("--force-webrtc-ip"));
    }

    /// 环境自适应探测本身：CI 变量注入 → 判定（env 隔离）。
    #[test]
    fn ci_env_detection() {
        let old: Vec<(&str, Option<String>)> = ["CI", "GITHUB_ACTIONS"]
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        std::env::set_var("CI", "1");
        assert!(is_ci_or_container());
        std::env::remove_var("CI");
        for (k, v) in old {
            match v {
                Some(v) => std::env::set_var(k, v),
                None => std::env::remove_var(k),
            }
        }
    }
}
