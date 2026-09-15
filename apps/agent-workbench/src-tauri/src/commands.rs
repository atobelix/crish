use crate::core_error::CoreError;

/// 安装更新 stub：当前仅返回成功，供前端闭环演示。
/// TODO: 接入真实更新下载/安装流程。
/// 错误协议（PS-04 T4.5 / F4 F1-02）：返回类型统一 `Result<Value, CoreError>`
/// （stub 无错误面，签名收敛保证前端按 {kind, detail} 协议消费）。
#[tauri::command]
pub(crate) async fn workbench_apply_update() -> Result<serde_json::Value, CoreError> {
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    /// 真漂移退役面（2026-09-15 债务清零 · 物理切除）：桌面壳原生 HTTP 请求
    /// 命令已从实现面物理删除（前端生产代码零消费，唯一调用点原在本
    /// `#[cfg(test)]` 内）。原两条断言（非法 method / 非 http(s) url →
    /// `CoreError::InvalidInput`）钉的正是被退役命令的运行时行为，随命令一并
    /// 退役；改钉「实现面不得复活」负向不变量（注册面负向断言见
    /// `tests/config_command_names_contract.rs`）。
    #[test]
    fn retired_http_command_is_physically_removed() {
        // needle 分片拼接：避免断言文案自身命中源文本
        let removed = concat!("workbench_http", "_request");
        assert!(
            !include_str!("commands.rs").contains(removed),
            "已退役命令 {removed} 严禁在实现面复活"
        );
    }

    /// T4.5-R5/R6（契约锁定）：`workbench_apply_update` 成功路径形状不变
    /// （`{ok: true}`）；签名收敛为 `Result<Value, CoreError>`（编译期断言
    /// 在修复提交随签名变更落地）。
    #[tokio::test]
    async fn apply_update_returns_ok_true_shape() {
        let res = workbench_apply_update().await.expect("stub 恒成功");
        assert_eq!(res["ok"], true, "update stub 返回形状不变");
    }
}
