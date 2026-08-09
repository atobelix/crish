//! 数据导入与持久化：公共类型（维度 16 §0.3 types.rs）
//!
//! 全部类型可 serde 序列化（profile_meta.json 落盘 / Tauri command 参数面），
//! 不承载任何 cookie/密码内容（§7.1 隐私最小化：meta 仅存路径与判定数字）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 浏览器家族（§2.1 `family` 字段；S0 修订后家族仅用于前置检测与向导文案，
/// 不再作为回读校验的判定输入——FamilyMismatch 已撤销）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserFamily {
    /// Google Chrome（含 Canary）。
    Chrome,
    /// Microsoft Edge（含 Beta/Dev/Canary 变体）。
    Edge,
    /// 开源 Chromium。
    Chromium,
    /// 自定义目录无法从路径推断家族。
    Unknown,
}

/// 来源浏览器（§2.1 探测结果；也是 `profile_meta.source` 的落盘形态，§7.1）。
///
/// 发现阶段 `profile_dir`/`display_name` 为空（浏览器级），
/// 选定 profile 后经 [`BrowserSource::with_profile`] 组合为完整来源。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserSource {
    /// 家族（同家族约束矩阵输入，§4.4）。
    pub family: BrowserFamily,
    /// 展示名（如 "Google Chrome"）。
    pub browser_name: String,
    /// 用户数据目录（仅存路径，不存内容）。
    pub user_data_dir: PathBuf,
    /// profile 子目录名（Default / Profile 1 …；发现阶段为空）。
    pub profile_dir: String,
    /// info_cache 解析出的展示名（§2.2 回退链；发现阶段为空）。
    pub display_name: String,
}

impl BrowserSource {
    /// 与所选 profile 组合为完整来源（复制 / 落盘用，§2.2 → §3.3）。
    pub fn with_profile(&self, profile: &ChromeProfile) -> Self {
        BrowserSource {
            family: profile.family,
            browser_name: self.browser_name.clone(),
            user_data_dir: profile.user_data_dir.clone(),
            profile_dir: profile.directory.clone(),
            display_name: profile.display_name.clone(),
        }
    }
}

/// profile 列表项（Local State info_cache 读取结果，§2.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChromeProfile {
    /// profile 目录名（Default / Profile 1 …）。
    pub directory: String,
    /// 展示名（name → user_name → directory 回退链）。
    pub display_name: String,
    /// 「未重命名」标注（UI 用，§2.2）。
    pub is_using_default_name: bool,
    /// 家族（探测结果携带，供复制与回读校验）。
    pub family: BrowserFamily,
    /// 所属用户数据目录。
    pub user_data_dir: PathBuf,
}

/// App-Bound 前置检测结论（S0 实证修订 §4.1 / S0-02 §2.3）：
/// 以来源 Local State 的 `os_crypt.app_bound_encrypted_key` 字段存在性为准。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppBoundStatus {
    /// 字段存在 ⇒ App-Bound 加密启用（同家族可迁移、跨家族不可行，复制前提示）。
    Detected,
    /// 字段缺失 / Local State 缺失或损坏（按未启用处理——S0 实测本机形态）。
    Absent,
}

/// 来源运行状态（§3.2 锁检测三态）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunningStatus {
    /// Singleton* 锁文件存在 ⇒ 来源浏览器运行中，阻断复制。
    Running,
    /// 无锁文件、无进程命中、无 DB 残留 ⇒ 可复制。
    NotRunning,
    /// 仅进程探测或 *-wal+*-shm 伴生命中 ⇒ UI 询问用户确认后继续。
    Uncertain { reason: String },
}

/// 回读校验结论（§4.3 修订版：`FamilyMismatch` 分类已撤销）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerifyConclusion {
    /// 可读：登录态可用。
    Readable,
    /// 数据不可用（无持久 cookie / 库损坏 / 解密失败）→ 引导面板内登录。
    Unreadable,
}

/// 回读校验报告（§4.3：落盘 `profile_meta.verify_result`，验收 S3 要求）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VerifyReport {
    pub conclusion: VerifyConclusion,
    /// 目标 Cookies 库持久 cookie 行数（`expires_utc > 0`）。
    pub n_db: u64,
    /// CDP 实读持久 cookie 数（MVP 未接线时为 None，见 verify::CdpCookieReader）。
    pub n_cdp: Option<u64>,
    /// App-Bound 前置检测结论。
    pub app_bound: AppBoundStatus,
    /// 校验时间（unix 秒字符串）。
    pub checked_at: String,
    /// 附加说明（分支原因等）。
    pub notes: String,
}

/// profile 来源（§7.1 `origin`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileOrigin {
    /// 面板内引导登录（主路径，§1）。
    GuidedLogin,
    /// 最小文件集 profile 复制（迁移路径，§3）。
    Copied,
    /// storage_state 导入（辅助通道，§5；P1 实施）。
    StorageState,
}

/// profile 状态（§7.1 `state`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileState {
    /// 可用。
    Active,
    /// 回读校验不可用标记（供用户改选同家族二进制重试 / 确认放弃后 trash）。
    Disabled,
    /// 已入回收站。
    Trashed,
}

/// profile_meta.json（§7.1；persist 开关**唯一**存于此，R-2 / U-11，
/// 撤销 panel-state.json 双源）。不含任何 cookie/密码内容。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileMeta {
    /// 内部唯一标识（uuid，目录名 = profile_name 可用户命名）。
    pub profile_id: String,
    /// 来源通道。
    pub origin: ProfileOrigin,
    /// 来源信息（origin=copied 时记录；仅存路径不存内容）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<BrowserSource>,
    /// 持久化开关（唯一权威；默认 false，§7.2）。
    pub persist: bool,
    /// 回读校验结论（验收 S3：结论落盘）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_result: Option<VerifyReport>,
    /// 创建时间（unix 秒字符串）。
    pub created_at: String,
    /// 最近使用时间。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    /// 生命周期状态。
    pub state: ProfileState,
}
