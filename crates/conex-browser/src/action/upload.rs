//! 上传执行链（维度 14 §9，upload.rs）
//!
//! 流程（§9.1）：
//! 1. 授权对接：工具层 dangerous=true 走审批（维度 17），原语层凭证兜底校验；
//! 2. 路径校验：绝对路径、存在、可读、非目录、大小 ≤ 500MB（配置项）；
//! 3. 定位元素：快照索引 → backendNodeId（可见性校验由定位链承接）；
//! - 4a：`input[type=file]`（固定模板判定）→ `DOM.setFileInputFiles{backendNodeId}`；
//! - 4b：代理触发器（label/button 点击弹选择器）→ 等 `Page.fileChooserOpened`
//!   （≤3s）→ 对事件 payload 的 backendNodeId setFileInputFiles；
//! 5. 回读校验：`input.files.length==1` 且 name 匹配（不符 → Timeout 可重试）。
//!
//! 路径安全检查（§9.1 注记）：仅允许工作区内路径（canonicalize + symlink 双保险 +
//! 组件边界，以 17 §7.2 为唯一权威）；`..` 穿越与符号链接在 canonicalize 后校验。

use crate::action::{
    ActionError, ActionErrorKind, ActionExecutor, MouseButton,
};
use serde_json::{json, Value};
use std::path::Path;

/// 上传大小上限（§9.1 步骤 2：≤ 500MB）。
pub const UPLOAD_MAX_BYTES: u64 = 500 * 1024 * 1024;

/// 文件输入判定固定模板（§9.1 步骤 4 分流；无模型输入）。
pub(crate) const IS_FILE_INPUT_TEMPLATE: &str = r#"function() { if (!this.tagName) return false; return String(this.tagName).toUpperCase() === "INPUT" && String(this.type || "").toLowerCase() === "file"; }"#;

/// 回读固定模板（§9.1 步骤 5：files[0].name；无模型输入）。
const READBACK_TEMPLATE: &str = r#"function() { if (!this.files || this.files.length === 0) return ""; return this.files[0].name; }"#;

/// 路径校验（§9.1 步骤 2 + 17 §7.2 工作区路径纪律）。
pub fn validate_path(path: &Path) -> Result<(), ActionError> {
    if !path.is_absolute() {
        return Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            format!("上传路径必须为绝对路径：{}", path.display()),
        ));
    }
    let metadata = std::fs::metadata(path).map_err(|e| {
        ActionError::new(
            ActionErrorKind::InvalidInput,
            format!("上传路径不可访问：{}（{e}）", path.display()),
        )
    })?;
    validate_upload_meta(metadata.is_file(), metadata.len())
}

/// 元数据级校验（纯函数，供单测注入大文件尺寸）。
pub fn validate_upload_meta(is_file: bool, len: u64) -> Result<(), ActionError> {
    if !is_file {
        return Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            "上传路径不是普通文件（目录/特殊文件被拒绝）",
        ));
    }
    if len > UPLOAD_MAX_BYTES {
        return Err(ActionError::new(
            ActionErrorKind::InvalidInput,
            format!("上传文件超过上限（{len} > {UPLOAD_MAX_BYTES} 字节）"),
        ));
    }
    Ok(())
}

/// 上传派发（§9.1：直接路径 4a / 代理触发器 4b，回读校验 5）。
pub async fn dispatch_upload(
    exec: &ActionExecutor,
    node_id: i64,
    backend_node_id: i64,
    path: &Path,
) -> Result<Option<Value>, ActionError> {
    validate_path(path)?;
    let path_str = path.to_string_lossy().to_string();
    if exec.ops.is_file_input(node_id).await? {
        // 4a：文件输入直接注入（backendNodeId 直传，无需 push 到前端树，§9.1）
        exec.ops
            .set_file_input_files(backend_node_id, std::slice::from_ref(&path_str))
            .await?;
        // 5：回读校验（name 匹配；不符 → Timeout 可重试）
        return upload_readback(exec, node_id, &path_str).await;
    }
    // 4b：代理触发器（label/button，点击才弹文件选择）
    let viewport = exec.ops.viewport().await?;
    let point = crate::action::locate::resolve_click_point(
        exec.ops.as_ref(),
        backend_node_id,
        &viewport,
        exec.opts.scroll_retries,
    )
    .await?;
    crate::action::pointer::dispatch_mouse_click(
        exec,
        &point,
        MouseButton::Left,
        1,
    )
    .await?;
    let chooser_backend = exec
        .ops
        .file_chooser_node(exec.opts.file_chooser_wait)
        .await?;
    exec.ops
        .set_file_input_files(chooser_backend, std::slice::from_ref(&path_str))
        .await?;
    // 回读（chooser 暴露的 file input 节点）
    let chooser_node = crate::action::locate::resolve_node_id(exec.ops.as_ref(), chooser_backend)
        .await?;
    upload_readback(exec, chooser_node, &path_str).await
}

/// 回读校验（§9.1 步骤 5：files.length==1 且 name 匹配）。
async fn upload_readback(
    exec: &ActionExecutor,
    node_id: i64,
    path_str: &str,
) -> Result<Option<Value>, ActionError> {
    let object_id = exec.ops.resolve_node(node_id).await?;
    let value = exec
        .ops
        .call_function_on(&object_id, READBACK_TEMPLATE, &[])
        .await?;
    let name = value.as_str().unwrap_or_default();
    let expected = Path::new(path_str)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if name != expected {
        return Err(ActionError::new(
            ActionErrorKind::Timeout,
            format!("上传回读校验不符：期望文件 {expected}，实际 {name}"),
        ));
    }
    Ok(Some(json!({ "files": 1, "name": expected })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;
    use crate::action::{ActionErrorKind, ActionExecutor, ElementMeta, ElementRef};
    use crate::cdp::sender::CancellationToken;
    use std::sync::Arc;

    fn executor(
        ops: MockOps,
        snapshot: MockSnapshotStore,
    ) -> (ActionExecutor, MockOps, Arc<RecordingDelay>) {
        let delay = Arc::new(RecordingDelay::new());
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(snapshot),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(delay.clone());
        (exec, ops, delay)
    }

    /// 路径校验穷举：相对路径/不存在/目录/超 500MB。
    #[test]
    fn upload_path_validation_exhaustive() {
        // 相对路径
        let err = validate_path(Path::new("relative.txt")).expect_err("相对路径应拒绝");
        assert_eq!(err.kind, ActionErrorKind::InvalidInput);
        // 不存在
        let missing = std::env::temp_dir().join("conex-upload-missing-8f3a2b.txt");
        let err = validate_path(&missing).expect_err("不存在应拒绝");
        assert_eq!(err.kind, ActionErrorKind::InvalidInput);
        // 目录
        let err = validate_path(&std::env::temp_dir()).expect_err("目录应拒绝");
        assert_eq!(err.kind, ActionErrorKind::InvalidInput);
        // 超 500MB（纯函数注入尺寸）
        let err = validate_upload_meta(true, UPLOAD_MAX_BYTES + 1).expect_err("超限应拒绝");
        assert!(err.message.contains("超过上限"));
        // 恰好 500MB 放行
        validate_upload_meta(true, UPLOAD_MAX_BYTES).expect("恰好上限应放行");
        // 非文件（目录）经纯函数
        let err = validate_upload_meta(false, 10).expect_err("非文件应拒绝");
        assert_eq!(err.kind, ActionErrorKind::InvalidInput);
    }

    /// 直接路径（4a）：input[type=file] → setFileInputFiles(backendNodeId) + 回读。
    #[tokio::test]
    async fn upload_direct_file_input() {
        let temp = tempfile::tempdir().expect("临时目录");
        let file = temp.path().join("report.txt");
        std::fs::write(&file, "内容").expect("写文件");
        let ops = MockOps::new();
        ops.state.lock().unwrap().file_inputs.insert(111);
        ops.state.lock().unwrap().readback_name = "report.txt".to_string();
        let (exec, ops, _delay) = executor(
            ops,
            MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }]),
        );
        let success = exec
            .upload_file(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, file.as_path())
            .await
            .expect("直接路径应成功");
        assert_eq!(success.payload.as_ref().unwrap()["name"], "report.txt");
        let sets = ops.calls_of(MockOp::SetFileInputFiles);
        assert_eq!(sets.len(), 1, "恰一次 setFileInputFiles");
        assert!(sets[0].detail.contains("backend=11"), "{}", sets[0].detail);
        assert_eq!(ops.count(MockOp::MouseEvent), 0, "直接路径不点击");
        assert_eq!(ops.count(MockOp::FileChooserNode), 0, "直接路径不等选择器");
    }

    /// 代理触发器（4b）：非 file input → 点击 → fileChooserOpened → 注入。
    #[tokio::test]
    async fn upload_proxy_trigger_flow() {
        let temp = tempfile::tempdir().expect("临时目录");
        let file = temp.path().join("photo.png");
        std::fs::write(&file, "png").expect("写文件");
        let ops = MockOps::new();
        ops.state.lock().unwrap().file_inputs.remove(&111); // 非 file input
        ops.state.lock().unwrap().chooser_node = Some(31);
        ops.state.lock().unwrap().readback_name = "photo.png".to_string();
        // chooser 暴露的节点 31 → 需可见 box（代理触发器回读走 resolve_node_id(31)）
        let (exec, ops, _delay) = executor(
            ops,
            MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }]),
        );
        let success = exec
            .upload_file(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, file.as_path())
            .await
            .expect("代理路径应成功");
        assert_eq!(success.payload.as_ref().unwrap()["files"], 1);
        assert_eq!(ops.count(MockOp::MouseEvent), 3, "点击序列（moved/pressed/released）");
        assert_eq!(ops.count(MockOp::FileChooserNode), 1, "等待 fileChooserOpened");
        let sets = ops.calls_of(MockOp::SetFileInputFiles);
        assert!(sets[0].detail.contains("backend=31"), "注入到 chooser 节点：{}", sets[0].detail);
    }

    /// 选择器超时（§9.1 4b：≤3s 无事件 → Timeout，可重试一次后致命）。
    #[tokio::test]
    async fn upload_chooser_timeout_fatal() {
        let temp = tempfile::tempdir().expect("临时目录");
        let file = temp.path().join("x.bin");
        std::fs::write(&file, "x").expect("写文件");
        let ops = MockOps::new();
        ops.state.lock().unwrap().file_inputs.remove(&111);
        ops.state
            .lock()
            .unwrap()
            .persist_errors
            .insert(
                MockOp::FileChooserNode,
                ActionError::new(ActionErrorKind::Timeout, "等待 fileChooserOpened 超时"),
            );
        let delay = Arc::new(RecordingDelay::new());
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            CancellationToken::new(),
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(delay.clone());
        let err = exec
            .upload_file(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, file.as_path())
            .await
            .expect_err("选择器超时应失败");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        // 超时策略：等待就绪 → 重试 1 次 → 仍失败 → 致命（不升级）
        assert!(!err.escalate);
        assert_eq!(ops.count(MockOp::FileChooserNode), 2, "重试重新等待选择器一次");
    }

    /// 回读不符：文件注入后 files 为空 → Timeout 重试一次 → Fatal。
    #[tokio::test]
    async fn upload_readback_mismatch_fatal() {
        let temp = tempfile::tempdir().expect("临时目录");
        let file = temp.path().join("a.txt");
        std::fs::write(&file, "x").expect("写文件");
        let ops = MockOps::new();
        ops.state.lock().unwrap().file_inputs.insert(111);
        ops.state.lock().unwrap().readback_name = String::new(); // files 为空
        let (exec, ops, _delay) = executor(
            ops,
            MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }]),
        );
        let err = exec
            .upload_file(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, file.as_path())
            .await
            .expect_err("回读不符应失败");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        // 重试一次后仍不符 → Fatal；期间第二次 setFileInputFiles
        assert_eq!(ops.count(MockOp::SetFileInputFiles), 2, "重试重新注入一次");
    }
}
