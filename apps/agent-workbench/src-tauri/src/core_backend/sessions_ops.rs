// 会话操作域实现（server 层 SessionsOps 的 Tauri 装配实现，G3）。
// 作用于桌面宿主的会话存储真源：Tauri 托管的 SharedDb（conex_db::LocalDb，
// sessions 表）——与桌面侧栏改名/置顶/归档/删除同一存储层。字段级写走
// conex-db 定向单列 UPDATE（桌面走 upsert_session_entry 全条目写，语义
// 等价、不互相踩踏）；删除走库层守卫删除（守卫与桌面孤儿清理豁免同源）
// + outputs_config 同一条产出回收站链，与桌面生产删除路径同结果。
use std::sync::Arc;

use conex_db::{DbFailure, LocalDb, SessionDeleteBlocker, SessionDeleteOutcome};
use conex_device_protocol::{DeviceErrorCode, OkResult};
use tauri::Manager;

use crate::server::backend::SessionsOps;
use crate::server::ServerError;
use crate::session_commands::SharedDb;

pub(crate) struct AppSessionsOps {
    app: tauri::AppHandle,
}

impl AppSessionsOps {
    pub(crate) fn create(app: tauri::AppHandle) -> Arc<dyn SessionsOps> {
        Arc::new(Self { app })
    }

    fn db(&self) -> LocalDb {
        self.app.state::<SharedDb>().local_db()
    }
}

fn map_db_error(error: DbFailure) -> ServerError {
    ServerError::internal(format!("会话存储错误（{}）：{}", error.kind, error.message))
}

fn not_found(session_id: &str) -> ServerError {
    ServerError::protocol(
        DeviceErrorCode::CmdNotFound,
        format!("会话不存在：{session_id}"),
    )
}

// ── 标题规范化（桌面 normalizeWritableSessionTitle 的宿主侧同口径移植）──
//
// 真源：crish-desktop `api/sessionTitle.ts` 的 sanitizeSessionTitleText +
// sessionSharedHelpers.ts 的 normalizeWritableSessionTitle（手动改名上限
// MANUAL_SESSION_TITLE_MAX_LEN = 48 码点）。规则：剥不可见字符 → 首尾
// ZWJ 剥离 → 空白折叠 → 剥 slash 命令 / markdown 标题 / 列表前缀 →
// 循环（≤4）剥引号 / 句末标点并重复前缀剥离 → 48 码点截断 + '…'。
// 清洗后为空 → None（命令层以 cmd.invalid 拒绝，不落库）。
// 差异说明：桌面用 \p{Cf} 正则覆盖全部 Unicode 格式字符，Rust 标准库
// 无类别表，此处以显式范围表覆盖 Cf 的全部已分配区块（双向控制、零宽、
// 标记块、变体选择符等）；Rust String 天然合法 UTF-8，无孤立代理对需清。

/// 手动改名标题码点上限（桌面 MANUAL_SESSION_TITLE_MAX_LEN）
const SESSION_TITLE_MAX_CHARS: usize = 48;

fn is_title_invisible(c: char) -> bool {
    let cp = c as u32;
    matches!(
        cp,
        // C0/C1 控制符（\t \n \r 不在此列——它们走空白折叠，与桌面一致）
        0x00..=0x08
            | 0x0B
            | 0x0C
            | 0x0E..=0x1F
            | 0x7F..=0x9F
            // Cf 显式追加的不可见非格式字符（组合图形连接符 / 韩文字母填充）
            | 0x034F
            | 0x115F
            | 0x3164
            // 变体选择符（Mn 类，桌面显式追加）
            | 0xFE00..=0xFE0F
            // Cf 格式字符区块（保留 U+200D ZWJ 不破坏 emoji 序列）
            | 0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B
            | 0x200C
            | 0x200E
            | 0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0000..=0xE007F
    )
}

fn strip_boundary_zwj(s: &str) -> String {
    s.trim_matches('\u{200D}').to_string()
}

fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 前缀剥离：连续 slash 命令 → markdown ATX 标题符 → 列表符（桌面顺序）
fn strip_title_prefixes(input: &str) -> String {
    let mut s = input.to_string();
    // 连续 slash 命令：`/help` `/cmd 正文` → 正文（`/` 后必须紧跟非空白）
    loop {
        let Some(rest) = s.strip_prefix('/') else {
            break;
        };
        match rest.chars().next() {
            Some(c) if !c.is_whitespace() => {
                let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
                s = rest[end..].trim_start_matches([' ', '\t']).to_string();
            }
            _ => break,
        }
    }
    // markdown ATX 标题（1-6 个 # + 空白）
    let hashes = s.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && s.chars().nth(hashes).is_some_and(|c| c.is_whitespace()) {
        s = s[hashes..].trim_start().to_string();
    }
    // 有序/无序列表前缀（中文「1、」后常无空格）
    let mut chars = s.char_indices();
    if let Some((_, first)) = chars.next() {
        if matches!(first, '-' | '*' | '•' | '·') {
            s = s[first.len_utf8()..].trim_start_matches(' ').to_string();
        } else if first.is_ascii_digit() {
            let digits_end = s
                .char_indices()
                .take_while(|(_, c)| c.is_ascii_digit())
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            if let Some(mark) = s[digits_end..].chars().next() {
                if matches!(mark, '.' | ')' | '、') {
                    s = s[digits_end + mark.len_utf8()..]
                        .trim_start_matches(' ')
                        .to_string();
                }
            }
        }
    }
    s
}

const TITLE_QUOTES: [char; 10] = [
    '"', '\'', '\u{201C}', '\u{201D}', '\u{2018}', '\u{2019}', '「', '」', '『', '』',
];
const TITLE_TRAILING_PUNCT: [char; 8] = ['。', '！', '？', '.', '!', '?', '…', '‥'];

/// 标题规范化（纯函数）：清洗后为空 → None
pub(crate) fn normalize_session_title(raw: &str) -> Option<String> {
    let stripped: String = raw.chars().filter(|c| !is_title_invisible(*c)).collect();
    let mut s = collapse_whitespace(&strip_boundary_zwj(&stripped));
    s = strip_title_prefixes(&s);
    // 后处理循环（≤4，与桌面同构）：剥引号/句末标点可能暴露新的首尾
    // 噪声与前导前缀，循环内重复执行保证规范化幂等
    for _ in 0..4 {
        let before = s.clone();
        s = s.trim_matches(|c| TITLE_QUOTES.contains(&c)).to_string();
        s = s
            .trim_end_matches(|c| TITLE_TRAILING_PUNCT.contains(&c))
            .to_string();
        s = strip_boundary_zwj(s.trim());
        s = strip_title_prefixes(s.trim());
        if s == before {
            break;
        }
    }
    if s.is_empty() {
        return None;
    }
    if s.chars().count() > SESSION_TITLE_MAX_CHARS {
        let kept: String = s.chars().take(SESSION_TITLE_MAX_CHARS).collect();
        return Some(format!("{kept}…"));
    }
    Some(s)
}

// ── 删除后产出清理（与桌面 cleanup_orphan_sessions 的 RUN-07 链同形）──

/// `session-outputs-cleanup` 事件载荷（camelCase；与
/// session_commands::cleanup_import 的同名事件同形，前端监听端共用）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionOutputsCleanupEvent {
    session_id: String,
    cleaned: bool,
    skipped_outside: bool,
    trash_root: String,
    notice: String,
}

fn emit_outputs_cleanup(
    app: &tauri::AppHandle,
    session_id: &str,
    output_dir: Option<&str>,
    output_root: Option<&str>,
) {
    use tauri::Emitter;
    let event = match crate::outputs_config::cleanup_session_outputs(
        app,
        session_id,
        output_dir,
        output_root,
    ) {
        Ok(cleanup) => {
            tracing::info!(
                target: "outputs",
                session_id,
                cleaned = cleanup.cleaned,
                trashed = ?cleanup.trashed_dirs,
                "远程删除会话产出目录清理完成"
            );
            SessionOutputsCleanupEvent {
                session_id: session_id.to_string(),
                cleaned: cleanup.cleaned,
                skipped_outside: cleanup.skipped_outside,
                trash_root: cleanup.trash_root,
                notice: cleanup.notice,
            }
        }
        Err(e) => {
            tracing::warn!(
                target: "outputs",
                session_id,
                error = %e,
                "远程删除会话产出目录清理失败（不阻断删除）"
            );
            SessionOutputsCleanupEvent {
                session_id: session_id.to_string(),
                cleaned: false,
                skipped_outside: false,
                trash_root: String::new(),
                notice: format!("会话产出目录清理失败：{e}"),
            }
        }
    };
    if let Err(e) = app.emit("session-outputs-cleanup", vec![event]) {
        tracing::warn!(target: "outputs", error = %e, "清理结果事件发送失败（清理本身已完成）");
    }
}

impl SessionsOps for AppSessionsOps {
    fn rename_session(&self, session_id: &str, title: &str) -> Result<OkResult, ServerError> {
        let normalized = normalize_session_title(title).ok_or_else(|| {
            ServerError::protocol(
                DeviceErrorCode::CmdInvalid,
                "标题清洗后为空（与桌面改名同口径：空标题不落库）".to_string(),
            )
        })?;
        let updated = self
            .db()
            .update_session_title(session_id, &normalized)
            .map_err(map_db_error)?;
        if !updated {
            return Err(not_found(session_id));
        }
        Ok(OkResult { ok: true })
    }

    fn set_session_pinned(&self, session_id: &str, pinned: bool) -> Result<OkResult, ServerError> {
        let updated = self
            .db()
            .update_session_pinned(session_id, pinned)
            .map_err(map_db_error)?;
        if !updated {
            return Err(not_found(session_id));
        }
        Ok(OkResult { ok: true })
    }

    fn set_session_archived(
        &self,
        session_id: &str,
        archived: bool,
    ) -> Result<OkResult, ServerError> {
        let updated = self
            .db()
            .update_session_archived(session_id, archived)
            .map_err(map_db_error)?;
        if !updated {
            return Err(not_found(session_id));
        }
        Ok(OkResult { ok: true })
    }

    fn delete_session(&self, session_id: &str) -> Result<OkResult, ServerError> {
        match self
            .db()
            .delete_session_guarded(session_id)
            .map_err(map_db_error)?
        {
            SessionDeleteOutcome::Deleted {
                output_dir,
                output_root,
            } => {
                emit_outputs_cleanup(
                    &self.app,
                    session_id,
                    output_dir.as_deref(),
                    output_root.as_deref(),
                );
                Ok(OkResult { ok: true })
            }
            SessionDeleteOutcome::NotFound => Err(not_found(session_id)),
            SessionDeleteOutcome::Blocked(SessionDeleteBlocker::EngineHydrated) => {
                Err(ServerError::protocol(
                    DeviceErrorCode::CmdDenied,
                    "引擎子代理会话不可删除（与桌面孤儿清理豁免同源）".to_string(),
                ))
            }
            SessionDeleteOutcome::Blocked(SessionDeleteBlocker::ActiveRun) => {
                Err(ServerError::protocol(
                    DeviceErrorCode::CmdSessionBusy,
                    "会话有正在运行的任务，无法删除".to_string(),
                ))
            }
            SessionDeleteOutcome::Blocked(SessionDeleteBlocker::PendingInputs) => {
                Err(ServerError::protocol(
                    DeviceErrorCode::CmdSessionBusy,
                    "会话有未处理的输入，无法删除".to_string(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_strips_invisibles_and_collapses_whitespace() {
        assert_eq!(
            normalize_session_title("  修复\u{200B} 登录\n\t问题  "),
            Some("修复 登录 问题".to_string())
        );
        // 全角空格折叠
        assert_eq!(
            normalize_session_title("标题\u{3000}测试"),
            Some("标题 测试".to_string())
        );
        // 双向控制符剥离
        assert_eq!(
            normalize_session_title("ab\u{202E}cd"),
            Some("abcd".to_string())
        );
    }

    #[test]
    fn normalize_strips_prefixes_quotes_and_trailing_punct() {
        assert_eq!(
            normalize_session_title("/help 如何部署？"),
            Some("如何部署".to_string())
        );
        assert_eq!(
            normalize_session_title("## 周报汇总。"),
            Some("周报汇总".to_string())
        );
        assert_eq!(
            normalize_session_title("「迭代计划」"),
            Some("迭代计划".to_string())
        );
        assert_eq!(
            normalize_session_title("- 待办清单"),
            Some("待办清单".to_string())
        );
        assert_eq!(
            normalize_session_title("1、需求评审"),
            Some("需求评审".to_string())
        );
        // 引号剥除后暴露的 slash 命令在循环内继续剥离（幂等口径）
        assert_eq!(normalize_session_title("\"/help\""), None);
    }

    #[test]
    fn normalize_empty_after_cleaning_is_none() {
        assert_eq!(normalize_session_title(""), None);
        assert_eq!(normalize_session_title("   "), None);
        assert_eq!(normalize_session_title("\u{200B}\u{FEFF}"), None);
        assert_eq!(normalize_session_title("/help"), None);
        assert_eq!(normalize_session_title("。。。"), None);
    }

    #[test]
    fn normalize_truncates_to_48_chars_with_ellipsis() {
        let long = "题".repeat(60);
        let result = normalize_session_title(&long).expect("应有标题");
        assert_eq!(result.chars().count(), 49);
        assert!(result.ends_with('…'));
        let exact = "题".repeat(48);
        assert_eq!(normalize_session_title(&exact), Some(exact));
        // emoji 序列中间 ZWJ 保留
        assert_eq!(
            normalize_session_title("家庭👨‍👩‍👧会议"),
            Some("家庭👨‍👩‍👧会议".to_string())
        );
    }
}
