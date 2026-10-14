//! shell 工具 · 删除形态重定向 / 拦截（SR-06a-2 拆分子模块）
//!
//! 逻辑域：I2-S4 删除形态重定向（trash 服务接管）、复合链 / 间接执行包裹 /
//! 越界目标拦截、T-AB-04 cd 形态拦截、I2-S8 拦截/重定向审计发射、门禁路径串
//! （gate_path）。安全红线（命令白名单 / 路径校验 / 写路径互斥）与拆分前
//! 逐字一致；未经门禁（prepare）的命令不会到达执行面。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL-01…10 / ≠ 打开完成 / ≠ 结构债清零）。

use crate::audit::{security_audit_event, SecurityAuditSink};
use crate::context::ToolContext;
use crate::definition::ToolError;
use crate::tools::{delete::DEFAULT_TRASH_DIR_NAME, display_path, resolve_workspace_path};
use crate::write_paths::{claim_write_guard, ClaimMode};
use conex_fs::impact::ImpactAssessment;
use conex_fs::trash::TrashService;
use conex_sandbox::semantics::{CommandClass, SemanticAnalysis};
use conex_types::events::{SecurityAuditDecision, SecurityAuditOperation};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{TOOL_CD_BLOCKED, TOOL_COMMAND_BLOCKED};

/// 删除形态引导文案（模型可改走统一删除接口）
const DELETE_REDIRECT_GUIDANCE: &str =
    "如确需删除请改用 delete_file / delete_dir 工具（统一删除接口，可恢复）";

/// 拦截类审计发射（I2-S8：decision=blocked；targets 为被拦目标/命令原文；
/// 影响面未知 → 空载荷，与审计字段语义一致——操作未执行；
/// tool_call_id 取执行上下文真值，LK-03：工具执行 → 审计携带真实调用 id）
pub(crate) fn emit_blocked_audit(
    audit_sink: &Arc<dyn SecurityAuditSink>,
    ctx: &ToolContext,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
) {
    audit_sink.emit(&security_audit_event(
        &ctx.session_id,
        operation,
        targets,
        ImpactAssessment::default(),
        SecurityAuditDecision::Blocked,
        ctx.tool_call_id.clone(),
    ));
}

/// 删除形态重定向（I2-S4 主入口）：
/// - 间接执行包裹删除形态 → 整链拦截 + 引导（外层无法安全解析内层目标）；
/// - 复合链含删除段 → 整链拦截 + 引导（链内其他段副作用不可控，不代为执行）；
/// - 纯删除命令 → 解析目标（工作区外一律拒绝）→ trash 服务移入回收站 →
///   返回 TrashEntry 列表（entryId 供恢复）+ 影响面审计载荷。
///
/// 审计（I2-S8）：拦截分支发射 decision=blocked，成功重定向发射
/// decision=redirected（影响面来自预检）。
pub(crate) fn redirect_or_intercept_delete(
    analysis: &SemanticAnalysis,
    command: &str,
    workspace_root: &Path,
    cwd: &Path,
    trash_root: Option<PathBuf>,
    ctx: &ToolContext,
    audit_sink: Arc<dyn SecurityAuditSink>,
) -> Result<serde_json::Value, ToolError> {
    let display_cmd = if let Some(decoded) = &analysis.decoded_payload {
        format!("{command} [解码明文: {decoded}]")
    } else {
        command.to_string()
    };

    // 1. 间接执行包裹（bash -c 'rm x' / xargs rm 等）：内层目标无法安全解析，
    //    整链拦截 + 引导，防包裹绕过统一删除门禁
    if analysis.has_indirect_delete {
        emit_blocked_audit(
            &audit_sink,
            ctx,
            SecurityAuditOperation::Delete,
            vec![display_cmd.clone()],
        );
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!(
                "PermissionDenied: 检测到间接执行包裹的物理删除形态（eval / bash -c / xargs 等），已拦截；{DELETE_REDIRECT_GUIDANCE}。原始命令：{display_cmd}"
            ),
        ));
    }
    // 2. 复合链：任一段命中删除形态 → 整链拦截（其他段副作用不可控，不代为执行）
    let has_non_delete_segment = analysis
        .segments
        .iter()
        .any(|s| s.class != CommandClass::DeleteShape);
    if has_non_delete_segment {
        emit_blocked_audit(
            &audit_sink,
            ctx,
            SecurityAuditOperation::Delete,
            vec![display_cmd.clone()],
        );
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!(
                "PermissionDenied: 检测到复合命令链中的物理删除形态，整链已拦截（链内其他段副作用不可控）；{DELETE_REDIRECT_GUIDANCE}。原始命令：{display_cmd}"
            ),
        ));
    }
    // 3. 无法解析删除目标（如 rm --cached 无路径）→ 拦截 + 引导
    if analysis.delete_targets.is_empty() {
        emit_blocked_audit(
            &audit_sink,
            ctx,
            SecurityAuditOperation::Delete,
            vec![display_cmd.clone()],
        );
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!(
                "PermissionDenied: 检测到物理删除形态但无法解析删除目标；{DELETE_REDIRECT_GUIDANCE}。原始命令：{display_cmd}"
            ),
        ));
    }
    // 4. 解析目标：相对 cwd 解析 + 工作区包含性校验（越界一律拒绝，不引导不降级）
    let mut targets = Vec::new();
    for target in &analysis.delete_targets {
        match resolve_delete_target(workspace_root, cwd, target) {
            Ok(t) => targets.push(t),
            Err(e) => {
                emit_blocked_audit(
                    &audit_sink,
                    ctx,
                    SecurityAuditOperation::Delete,
                    vec![target.clone()],
                );
                return Err(e);
            }
        }
    }
    // T-D-08：删除重定向目标的硬沙箱越权拒绝（白名单下目标不在允许集 → 整链
    // 拒绝；未装配策略 = 不强制；先越权后互斥，串行叠加）
    for target in &targets {
        crate::write_paths::check_write_allowance_for_ctx(ctx, target)?;
    }
    // I4-M3：删除重定向目标的写路径互斥——全部目标先声明（Delete 模式）再执行，
    // 任一目标被占用 → 整链拒绝（不产生部分删除）；未接线（None）不强制；
    // 守卫集合随函数结束自动释放
    let mut claims = Vec::new();
    for target in &targets {
        claims.push(claim_write_guard(
            ctx,
            &target.display().to_string(),
            ClaimMode::Delete,
        )?);
    }
    // 5. trash 服务执行（模式 B：应用内回收站；未注入根时回退工作区 .crish-trash）
    let service_root = trash_root.unwrap_or_else(|| workspace_root.join(DEFAULT_TRASH_DIR_NAME));
    let service = TrashService::new(&service_root);
    // 影响面预检必须先于删除（目标移入回收站后原路径已不存在）
    let impact = conex_fs::impact::assess(&targets);
    let mut entries = Vec::new();
    for target in &targets {
        let display = display_path(workspace_root, target);
        if target == workspace_root || target == cwd {
            emit_blocked_audit(
                &audit_sink,
                ctx,
                SecurityAuditOperation::Delete,
                vec![display.clone()],
            );
            return Err(ToolError::new(
                TOOL_COMMAND_BLOCKED,
                format!(
                    "PermissionDenied: 删除目标为工作区根或当前工作目录，拒绝执行：{display}；{DELETE_REDIRECT_GUIDANCE}"
                ),
            ));
        }
        match service.trash_file(target, true) {
            Ok(entry) => {
                let mut v = serde_json::to_value(&entry).unwrap_or_else(|_| serde_json::json!({}));
                v["path"] = serde_json::Value::String(display);
                v["entryId"] = serde_json::Value::String(entry.id.clone());
                entries.push(v);
            }
            Err(e) => {
                return Err(ToolError::execution_failed(
                    "shell_command",
                    format!(
                        "删除重定向失败（{display}）：{e}；已移入回收站的条目可经 trash_restore 恢复"
                    ),
                ));
            }
        }
    }
    // 6. 审计：重定向成功（decision=redirected，影响面来自预检）——
    //    经审计 sink 发射（引擎侧接线后汇入事件流落库；未接线 no-op）；
    //    tool_call_id 取执行上下文真值（LK-03）
    let target_displays: Vec<String> = targets.iter().map(|t| t.display().to_string()).collect();
    audit_sink.emit(&security_audit_event(
        &ctx.session_id,
        SecurityAuditOperation::Delete,
        target_displays.clone(),
        impact,
        SecurityAuditDecision::Redirected,
        ctx.tool_call_id.clone(),
    ));
    // 7. 审计日志（结构化安全审计；工具结果经 tool-end 事件流落库）
    let entry_ids: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["entryId"].as_str())
        .collect();
    tracing::info!(
        target: "security.audit",
        kind = "delete-redirect",
        session_id = %ctx.session_id,
        command = %command,
        targets = ?target_displays,
        entry_ids = ?entry_ids,
        impact = ?impact,
        "删除形态重定向审计：shell 删除命令已改走回收站接口（可恢复）"
    );
    Ok(build_redirect_output(
        command,
        workspace_root,
        cwd,
        &targets,
        &entries,
        impact,
        &service_root,
    ))
}

/// 判断是否为可安全清理的临时目录、构建缓存或回收站内部路径
pub(crate) fn is_safe_temp_or_cache_path(path: &Path) -> bool {
    let norm = conex_fs::ConexPathNormalizer::normalize(path);
    let s = norm.to_string_lossy();
    let upper = s.to_ascii_uppercase();

    // 检查系统 TEMP / TMP 目录
    if let Ok(temp_dir) = std::env::var("TEMP") {
        let norm_temp = conex_fs::ConexPathNormalizer::normalize(Path::new(&temp_dir));
        if conex_fs::ConexPathNormalizer::is_subpath(&norm, &norm_temp) {
            return true;
        }
    }
    if let Ok(tmp_dir) = std::env::var("TMP") {
        let norm_tmp = conex_fs::ConexPathNormalizer::normalize(Path::new(&tmp_dir));
        if conex_fs::ConexPathNormalizer::is_subpath(&norm, &norm_tmp) {
            return true;
        }
    }

    // 常见构建缓存 / 临时目录组件判定
    let safe_patterns = [
        "/TARGET/TMP",
        "/NODE_MODULES/.CACHE",
        "/.CRISH-TRASH",
        "/DIST",
        "/BUILD",
        "/.CACHE",
    ];
    for pattern in &safe_patterns {
        if upper.ends_with(pattern) || upper.contains(&format!("{pattern}/")) {
            return true;
        }
    }

    false
}

/// 解析删除目标：相对 cwd 拼接后做工作区包含性校验；通配符 / 特殊路径 /
/// 工作区外目标一律拒绝（I2-S4 内容 3：越界目标不引导不降级；放行合规临时目录清理）。
fn resolve_delete_target(
    workspace_root: &Path,
    cwd: &Path,
    target: &str,
) -> Result<PathBuf, ToolError> {
    let trimmed = target.trim();
    if trimmed.is_empty() || matches!(trimmed, "." | ".." | "~") || trimmed.starts_with('~') {
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!("删除目标为特殊路径，已拒绝：{target:?}；请改用 delete_file / delete_dir 指定明确路径"),
        ));
    }
    if trimmed.contains(['*', '?', '[']) {
        return Err(ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!("删除目标含通配符，已拒绝：{target:?}；请改用 delete_file / delete_dir 指定明确路径"),
        ));
    }
    let raw = Path::new(trimmed);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        cwd.join(raw)
    };

    // 允许安全清理临时构建目录、缓存目录或回收站
    if is_safe_temp_or_cache_path(&candidate) {
        return Ok(conex_fs::ConexPathNormalizer::normalize(&candidate));
    }

    resolve_workspace_path(workspace_root, &candidate.to_string_lossy()).map_err(|_| {
        ToolError::new(
            TOOL_COMMAND_BLOCKED,
            format!("删除目标在工作区外或越界，已拒绝：{target:?}"),
        )
    })
}

/// 重定向结果：TrashEntry 列表（entryId 供恢复）+ 影响面 + 引导文案
fn build_redirect_output(
    command: &str,
    workspace_root: &Path,
    cwd: &Path,
    targets: &[PathBuf],
    entries: &[serde_json::Value],
    impact: ImpactAssessment,
    trash_root: &Path,
) -> serde_json::Value {
    let target_displays: Vec<String> = targets
        .iter()
        .map(|t| display_path(workspace_root, t))
        .collect();
    let entry_ids: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["entryId"].as_str())
        .collect();
    let text = format!(
        "检测到物理删除形态，已重定向到删除接管接口（未物理删除）：{} 个目标已移入回收站（条目 {}）。\n\
         可恢复路径类型：应用内回收站。恢复：调用 trash_restore（entryId={}）。",
        entries.len(),
        entry_ids.join(", "),
        entry_ids.first().copied().unwrap_or(""),
    );
    serde_json::json!({
        "command": command,
        "cwd": cwd.display().to_string(),
        "redirected": true,
        "redirect": {
            "kind": "delete-redirect",
            "reason": "semantics 判定为删除形态（DeleteShape），已改走删除接管接口（回收站），未物理删除",
            "targets": target_displays,
            "guidance": DELETE_REDIRECT_GUIDANCE,
        },
        "trashEntries": entries,
        "impact": impact,
        "trashRoot": trash_root.to_string_lossy().into_owned(),
        "text": text,
    })
}

/// 门禁比较用路径串：剥离 `\\?\` 前缀、反斜杠转斜杠、Windows 小写
/// （与 CommandGatekeeper 内部 normalize 方式一致，避免误升级审批）
#[allow(dead_code)]
pub(crate) fn gate_path(p: &Path) -> String {
    let s = crate::tools::strip_verbatim_prefix(p)
        .to_string_lossy()
        .replace('\\', "/");
    #[cfg(windows)]
    {
        s.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        s
    }
}

// ==================== T-AB-04：cd 形态拦截 ====================

/// cd 形态拦截（T-AB-04：判定优先级「门禁 → 删除形态 → cd 形态 → 执行」，
/// 由调用方保证删除形态先行；本函数只处理残留 cd 形态）：
/// - 纯 cd 命令（单段整体分类 == CdShape）→ 结构化错误 tool.cd_blocked，
///   文案引导使用 `Cwd` 参数；
/// - 复合链含 cd 段（多段）或间接执行内层含 cd → 整链拦截 + 引导（链内其他段依赖目录状态，
///   不代为执行）；
/// - PowerShell -WorkingDirectory (-wd) 启动参数目录篡改 → 拦截并引导使用 Cwd。
pub(crate) fn intercept_cd_shape(analysis: &SemanticAnalysis, command: &str) -> Option<ToolError> {
    // 1. 检查分析结果本身是否判定为 CdShape 或包含 CdShape 段
    let is_cd = analysis.overall_class == CommandClass::CdShape
        || analysis.segments.iter().any(|s| s.class == CommandClass::CdShape);

    // 复用分析结果的拆段（参照 :276-293 整链拦截模式）：命令 + 参数重建
    // 段字符串（引号内容已剥离，`echo "cd x"` 段首为 echo 不命中）
    let segments: Vec<String> = analysis
        .segments
        .iter()
        .map(|s| {
            if s.args.is_empty() {
                s.command.clone()
            } else {
                format!("{} {}", s.command, s.args.join(" "))
            }
        })
        .collect();

    let classified_cd = !segments.is_empty()
        && conex_sandbox::semantics::classify_command_segments(&segments) == CommandClass::CdShape;

    if !is_cd && !classified_cd {
        return None;
    }

    // 2. 检查是否为 PowerShell 启动参数 (-WorkingDirectory / -wd) 目录篡改逃逸
    let is_wd_escape = analysis.segments.iter().any(|s| {
        (s.command == "powershell" || s.command == "pwsh")
            && s.args.iter().any(|a| conex_sandbox::is_ps_working_directory_flag(a))
    });

    let message = if is_wd_escape {
        "检测到 PowerShell 启动参数 (-WorkingDirectory / -wd) 目录篡改，已拦截；请使用工具级 Cwd 参数指定工作目录，禁止在命令行中切换初始目录"
    } else {
        let pure_cd = segments.len() == 1
            && analysis.segments.len() == 1
            && analysis.segments[0].class == CommandClass::CdShape
            && !analysis.segments[0].command.eq_ignore_ascii_case("cmd")
            && !analysis.segments[0].command.eq_ignore_ascii_case("cmd.exe")
            && !analysis.segments[0].command.eq_ignore_ascii_case("powershell")
            && !analysis.segments[0].command.eq_ignore_ascii_case("pwsh");

        if pure_cd {
            "请使用 Cwd 参数指定工作目录，而非 cd 命令"
        } else {
            "检测到复合命令链中的 cd 形态，整链已拦截（链内其他段依赖目录状态，不代为执行）；请使用 Cwd 参数指定工作目录"
        }
    };

    let display_cmd = if let Some(decoded) = &analysis.decoded_payload {
        format!("{command} [解码明文: {decoded}]")
    } else {
        command.to_string()
    };

    Some(ToolError::new(
        TOOL_CD_BLOCKED,
        format!("{message}。原始命令：{display_cmd}"),
    ))
}
