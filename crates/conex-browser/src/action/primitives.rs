//! 原语便捷入口（§2.3 签名）：内部组装 ActionRequest 走统一流水线。

use super::{
    ActionError, ActionExecutor, ActionRequest, ActionSuccess, ElementRef, EvaluateRequest,
    MouseButton, PathBufLike, Primitive, ScrollDir, TabId, WaitCondition, WaitOptions, wait,
};
use std::path::Path;

impl ActionExecutor {
    // —— 原语便捷入口（§2.3 签名；内部组装 ActionRequest 走统一流水线）——

    pub async fn click(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        button: MouseButton,
        count: u8,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Click { button, count },
        })
        .await
    }

    pub async fn hover(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Hover,
        })
        .await
    }

    pub async fn drag(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        from: ElementRef,
        to: ElementRef,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(from),
            primitive: Primitive::Drag { to },
        })
        .await
    }

    pub async fn type_text(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        text: &str,
        submit_key: Option<&str>,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Type {
                text: text.to_string(),
                submit_key: submit_key.map(str::to_string),
            },
        })
        .await
    }

    pub async fn key(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        keys: &str,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: None,
            primitive: Primitive::Key {
                keys: keys.to_string(),
            },
        })
        .await
    }

    pub async fn scroll(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        dir: ScrollDir,
        amount: i32,
        el: Option<ElementRef>,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: el,
            primitive: Primitive::Scroll { dir, amount },
        })
        .await
    }

    pub async fn focus(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Focus,
        })
        .await
    }

    pub async fn select_option(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        value: &str,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::SelectOption {
                value: value.to_string(),
            },
        })
        .await
    }

    pub async fn upload_file(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        el: ElementRef,
        path: &Path,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: Some(el),
            primitive: Primitive::Upload {
                path: PathBufLike(path.to_path_buf()),
            },
        })
        .await
    }

    pub async fn evaluate(
        &self,
        tab_id: &TabId,
        snapshot_version: u64,
        request: EvaluateRequest,
    ) -> Result<ActionSuccess, ActionError> {
        self.execute(ActionRequest {
            tab_id: tab_id.clone(),
            snapshot_version,
            element: None,
            primitive: Primitive::Evaluate(request),
        })
        .await
    }

    /// wait_for 等待原语（§6：事件驱动 + 轮询兜底；条件面 R-5）。
    pub async fn wait_for(
        &self,
        cond: WaitCondition,
        opts: WaitOptions,
    ) -> Result<ActionSuccess, ActionError> {
        wait::wait_for(self, cond, opts).await
    }
}
