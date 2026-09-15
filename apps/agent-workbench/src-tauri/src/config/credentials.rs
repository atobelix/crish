//! 凭据命令仅委派核心配置事务。密钥不进入配置快照、事件或日志。
use agent_provider::credentials::SecretString;
use agent_provider::model_store::{CredentialState, ModelsSnapshot, ModelsStoreError};
use serde::Serialize;

#[tauri::command]
pub(crate) async fn config_secret_set(
    app: tauri::AppHandle,
    provider_id: String,
    api_key: String,
    expected_revision: String,
) -> Result<ModelsSnapshot, ModelsStoreError> {
    let mut snapshot = super::blocking(move |store| {
        store.set_credential(&provider_id, SecretString::new(api_key), &expected_revision)
    })
    .await?;
    super::publish_snapshot(&app, &mut snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn config_secret_clear(
    app: tauri::AppHandle,
    provider_id: String,
    expected_revision: String,
) -> Result<ModelsSnapshot, ModelsStoreError> {
    let mut snapshot =
        super::blocking(move |store| store.clear_credential(&provider_id, &expected_revision))
            .await?;
    super::publish_snapshot(&app, &mut snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn config_secret_get(
    provider_id: String,
) -> Result<CredentialState, ModelsStoreError> {
    super::blocking(move |store| store.credential_state(&provider_id)).await
}

#[tauri::command]
pub(crate) async fn config_secret_has(
    provider_id: String,
) -> Result<CredentialState, ModelsStoreError> {
    super::blocking(move |store| store.credential_state(&provider_id)).await
}

/// 显示密钥是明确的单次用户操作；普通状态查询永远不含明文。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RevealedCredential {
    #[serde(flatten)]
    status: CredentialState,
    revealed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

#[tauri::command]
pub(crate) async fn config_secret_reveal(
    provider_id: String,
    ui_confirm: bool,
) -> Result<RevealedCredential, ModelsStoreError> {
    super::blocking(move |store| {
        let status = store.credential_state(&provider_id)?;
        let api_key = if ui_confirm && status.has_key {
            Some(store.provider_key(&provider_id)?.as_str().to_string())
        } else {
            None
        };
        Ok(RevealedCredential {
            status,
            revealed: api_key.is_some(),
            api_key,
        })
    })
    .await
}
