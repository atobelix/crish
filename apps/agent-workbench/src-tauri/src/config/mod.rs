//! 模型配置宿主适配：持有一个核心存储，注册变更事件，不维护第二份配置树。
mod credentials;
pub(crate) mod persistence;
pub(crate) mod run_policy;

#[cfg(not(test))]
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};

use agent_provider::model_store::{
    CommittedModels, ModelsChange, ModelsSnapshot, ModelsStore, ModelsStoreError,
    ResolvedModelConfig,
};
use agent_provider::models::ModelRef;
use tauri::{Emitter, Manager};

pub(crate) use credentials::*;

#[cfg(not(test))]
static MODELS_STORE: OnceLock<Arc<ModelsStore>> = OnceLock::new();
#[cfg(test)]
static MODELS_STORE: Mutex<Option<Arc<ModelsStore>>> = Mutex::new(None);

fn create_store() -> Result<Arc<ModelsStore>, ModelsStoreError> {
    let config_dir = persistence::config_dir()?;
    #[cfg(test)]
    let path = if std::env::var_os("CRISH_WORKBENCH_CONFIG_DIR").is_some() {
        config_dir.join("models.yaml")
    } else {
        persistence::models_path()?
    };
    #[cfg(not(test))]
    let path = persistence::models_path()?;
    let store = Arc::new(ModelsStore::new(
        path,
        config_dir.join("secrets"),
        Some(config_dir),
    ));
    // 语法错误保存在核心状态；应用仍可打开编辑器修复，但新请求会被拒绝。
    if let Err(error) = store.read() {
        tracing::error!(error = %error, "模型配置初始化失败");
    }
    Ok(store)
}

pub(crate) fn models_store() -> Result<Arc<ModelsStore>, ModelsStoreError> {
    #[cfg(not(test))]
    {
        if let Some(store) = MODELS_STORE.get() {
            return Ok(store.clone());
        }
        let created = create_store()?;
        let _ = MODELS_STORE.set(created);
        MODELS_STORE
            .get()
            .cloned()
            .ok_or_else(|| ModelsStoreError::new("STORE_INIT", "模型配置存储未初始化"))
    }
    #[cfg(test)]
    {
        let mut slot = MODELS_STORE
            .lock()
            .map_err(|_| ModelsStoreError::new("STORE_LOCK", "测试配置锁不可用"))?;
        if slot.is_none() {
            *slot = Some(create_store()?);
        }
        slot.clone()
            .ok_or_else(|| ModelsStoreError::new("STORE_INIT", "模型配置存储未初始化"))
    }
}

pub(crate) fn current_snapshot() -> Result<Arc<CommittedModels>, ModelsStoreError> {
    models_store()?.committed()
}

pub(crate) fn resolve_model(reference: &ModelRef) -> Result<ResolvedModelConfig, ModelsStoreError> {
    models_store()?.resolve_model(reference)
}

pub(crate) fn resolve_active_model() -> Result<Option<ResolvedModelConfig>, ModelsStoreError> {
    models_store()?.resolve_active()
}

pub(crate) fn publish_snapshot(app: &tauri::AppHandle, snapshot: &mut ModelsSnapshot) {
    let change = ModelsChange {
        revision: snapshot.revision.clone(),
        valid: snapshot.parse_error.is_none(),
    };
    if let Err(error) = publish_change(app, change) {
        tracing::error!(error = %error, "已提交配置的窗口通知失败");
        snapshot.notification_error = Some(error.message);
    }
}

fn publish_change(app: &tauri::AppHandle, change: ModelsChange) -> Result<(), ModelsStoreError> {
    if let Some(state) = app.try_state::<Arc<crate::core_run_commands::CoreRunState>>() {
        state.reload_provider();
    }
    app.emit("models-config-changed", &change)
        .map_err(|_| ModelsStoreError {
            code: "CONFIG_EVENT".into(),
            message: "配置已保存，但窗口同步事件发送失败，请重新加载配置".into(),
            current_revision: Some(change.revision),
        })
}

pub(crate) fn init_models_store(app: &tauri::AppHandle) -> Result<(), ModelsStoreError> {
    let store = models_store()?;
    let handle = app.clone();
    let watcher = store.watch(move |change| {
        if let Err(error) = publish_change(&handle, change) {
            tracing::error!(error = %error, "模型配置变更通知失败");
        }
    })?;
    app.manage(Mutex::new(watcher));
    Ok(())
}

#[cfg(test)]
pub(crate) fn reset_config_stores_for_test() {
    if let Ok(mut slot) = MODELS_STORE.lock() {
        *slot = None;
    }
}

#[cfg(test)]
pub(crate) fn install_models_store_for_test(store: Arc<ModelsStore>) {
    *MODELS_STORE.lock().expect("测试配置锁") = Some(store);
}
/// IPC 的同步文件与系统凭据操作只在阻塞任务执行，不占 WebView 事件线程。
pub(crate) async fn blocking<T: Send + 'static>(
    operation: impl FnOnce(Arc<ModelsStore>) -> Result<T, ModelsStoreError> + Send + 'static,
) -> Result<T, ModelsStoreError> {
    tauri::async_runtime::spawn_blocking(move || operation(models_store()?))
        .await
        .map_err(|_| ModelsStoreError::new("CONFIG_TASK", "配置操作未能完成"))?
}
