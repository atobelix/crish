//! 宿主路径解析。配置内容、凭据和原子写入由核心 ModelsStore 管理。

use agent_provider::model_store::ModelsStoreError;
use std::path::PathBuf;

pub(crate) fn models_path() -> Result<PathBuf, ModelsStoreError> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .map(|path| path.join(".conex").join("models.yaml"))
        .ok_or_else(|| ModelsStoreError::new("CONFIG_PATH", "无法定位用户模型配置目录"))
}

pub(crate) fn config_dir() -> Result<PathBuf, ModelsStoreError> {
    if let Some(path) =
        std::env::var_os("CRISH_WORKBENCH_CONFIG_DIR").filter(|path| !path.is_empty())
    {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os("APPDATA")
        .filter(|path| !path.is_empty())
        .map(|path| PathBuf::from(path).join("Crish").join("AgentWorkbench"))
        .or_else(|| {
            std::env::var_os("HOME").map(|path| PathBuf::from(path).join(".config").join("crish"))
        })
        .ok_or_else(|| ModelsStoreError::new("CONFIG_PATH", "无法定位系统凭据目录"))
}
