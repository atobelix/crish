use super::*;

/// 退出状态 → 崩溃原因分类（§6.5：0 视为 Unknown / 21 profile 冲突 / 其他常规崩溃）。
pub(super) fn classify_exit(status: &std::process::ExitStatus) -> CrashReason {
    match status.code() {
        Some(0) => CrashReason::Unknown,
        Some(21) => CrashReason::ProcessExit(21),
        Some(other) => CrashReason::ProcessExit(other),
        None => CrashReason::Unknown,
    }
}

/// 提取 panic 载荷文本（&str / String / 其他载荷 → 兜底描述；M5 诊断面）。
pub(super) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "未知 panic 载荷".to_string()
    }
}

/// 杀进程树（失败仅告警）：杀树是停止/启动失败路径的最后兜底，失败不能改变
/// 停止语义（状态机仍须收敛），但必须留痕——否则「停止成功」而进程仍存活将
/// 无从诊断（platform::ProcessTreeKiller::kill_tree 契约要求调用方记 warning）。
pub(super) fn kill_tree_logged(
    killer: &mut dyn crate::browser::platform::ProcessTreeKiller,
    scene: &str,
) {
    if let Err(e) = killer.kill_tree() {
        tracing::warn!("杀进程树失败（{scene}）：{e}");
    }
}

/// 启动失败路径收尸：杀树 + 有界等待进程退出（2s，超时仅告警——调用方已
/// 决定返回启动错误，收尸结果不改变结论，但超时说明进程可能残留）。
pub(super) async fn kill_tree_and_reap(
    killer: &mut Box<dyn crate::browser::platform::ProcessTreeKiller>,
    child: &mut tokio::process::Child,
    scene: &str,
) {
    kill_tree_logged(killer.as_mut(), scene);
    match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
        Ok(Ok(_status)) => {}
        Ok(Err(e)) => tracing::warn!("收尸读取退出状态失败（{scene}）：{e}"),
        Err(_) => tracing::warn!("收尸超时（{scene}）：2s 内进程未退出，可能残留"),
    }
}
