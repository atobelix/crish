// 模型域操作实现（server 层 ModelsOps 的 Tauri 装配实现，G2/W-B）。
// 读写与桌面「设置 → 模型」页同一份真源：crate::config::models_store()
// 持有的 ModelsStore（统一模型树 UnifiedModelsConfig，落盘 models.yaml）；
// 提交走 ModelsStore::apply 的修订 CAS + crate::config::publish_snapshot
// 同一发布链（能力快照刷新 → provider 层重建 → models-config-changed
// 事件），桌面 UI 全局默认显示与引擎后续 run 随之生效——不另建移动端
// 专用模型表。
use std::sync::Arc;

use agent_provider::model_store::{ModelsSnapshot, ModelsStoreError};
use agent_provider::models::{ModelRef, UnifiedModelsConfig};
use conex_device_protocol::{
    ActiveModelInfo, DeviceErrorCode, ListModelsResult, ModelEntry, SetActiveModelResult,
};

use crate::server::backend::ModelsOps;
use crate::server::ServerError;

pub(crate) struct AppModelsOps {
    app: tauri::AppHandle,
}

impl AppModelsOps {
    pub(crate) fn create(app: tauri::AppHandle) -> Arc<dyn ModelsOps> {
        Arc::new(Self { app })
    }
}

fn map_store_error(error: ModelsStoreError) -> ServerError {
    ServerError::internal(format!(
        "模型配置存储错误（{}）：{}",
        error.code, error.message
    ))
}

/// 快照 → 配置树（解析失败 = 如实 internal 并携带解析信息，不伪造空目录）
fn snapshot_tree(snapshot: &ModelsSnapshot) -> Result<UnifiedModelsConfig, ServerError> {
    snapshot.tree.clone().ok_or_else(|| {
        let detail = snapshot
            .parse_error
            .as_ref()
            .map(|error| error.message.clone())
            .unwrap_or_else(|| "未知解析错误".to_string());
        ServerError::internal(format!("模型配置解析失败：{detail}"))
    })
}

/// 模型显示名解析（全树查找——含已停用条目，activeModel 原样回传时
/// 仍尽量给真实显示名；查不到回退 modelId）
fn resolve_display_name(tree: &UnifiedModelsConfig, target: &ModelRef) -> String {
    tree.providers
        .get(&target.provider_id)
        .and_then(|provider| {
            provider
                .models
                .iter()
                .find(|model| model.id == target.model_id)
        })
        .and_then(|model| model.display_name.clone())
        .unwrap_or_else(|| target.model_id.clone())
}

/// 统一模型树 → C38 响应投影（纯函数）：可选集 = 启用供应商下的启用
/// 模型（与桌面全局默认选择器同口径），按树内顺序；activeModel 按树内
/// active_model 原样解析（目标已停用/删除时仍如实回传），未设置时缺省
/// （桌面语义「不指定时在对话里选择」，移动端不得伪造）。
fn project_models(tree: &UnifiedModelsConfig) -> ListModelsResult {
    let active_ref = tree.active_model.as_ref();
    let mut models = Vec::new();
    for (provider_id, provider) in &tree.providers {
        if !provider.enabled {
            continue;
        }
        for model in &provider.models {
            if !model.enabled {
                continue;
            }
            models.push(ModelEntry {
                provider_id: provider_id.clone(),
                model_id: model.id.clone(),
                display_name: model
                    .display_name
                    .clone()
                    .unwrap_or_else(|| model.id.clone()),
                provider_display_name: provider.display_name.clone(),
                active: active_ref.is_some_and(|active| {
                    active.provider_id == *provider_id && active.model_id == model.id
                }),
                // G5b：视觉能力投影，与引擎出站守卫同口径
                // （modalities.input 含 image）；移动端据此决定
                // 图片直发或降级为元数据文本。
                vision: model.supports_image_input(),
            });
        }
    }
    let active_model = active_ref.map(|active| ActiveModelInfo {
        provider_id: active.provider_id.clone(),
        model_id: active.model_id.clone(),
        display_name: resolve_display_name(tree, active),
    });
    ListModelsResult {
        models,
        active_model,
    }
}

/// C39 目标校验（纯函数）：目标必须在可选集合内（供应商存在且启用、
/// 模型存在且启用）。与桌面提交归一「失效选择提交时清空」互补：远程
/// 面直接以 cmd.invalid 拒绝，不静默落库一个会被清空的选择。
fn validate_selectable(
    tree: &UnifiedModelsConfig,
    provider_id: &str,
    model_id: &str,
) -> Result<(), ServerError> {
    let invalid = |message: String| ServerError::protocol(DeviceErrorCode::CmdInvalid, message);
    let provider = tree
        .providers
        .get(provider_id)
        .ok_or_else(|| invalid(format!("供应商不存在：{provider_id}")))?;
    if !provider.enabled {
        return Err(invalid(format!("供应商已停用：{provider_id}")));
    }
    let model = provider
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| invalid(format!("模型不存在：{provider_id}/{model_id}")))?;
    if !model.enabled {
        return Err(invalid(format!("模型已停用：{provider_id}/{model_id}")));
    }
    Ok(())
}

impl ModelsOps for AppModelsOps {
    fn list_models(&self) -> Result<ListModelsResult, ServerError> {
        let store = crate::config::models_store().map_err(map_store_error)?;
        // 与桌面 workbench_read_models_yaml 同款：外部编辑引起变更时
        // 先经同一发布链同步桌面 UI，再回投影。
        let before = store.observed().map_err(map_store_error)?;
        let mut snapshot = store.read().map_err(map_store_error)?;
        if before != store.observed().map_err(map_store_error)? {
            crate::config::publish_snapshot(&self.app, &mut snapshot);
        }
        Ok(project_models(&snapshot_tree(&snapshot)?))
    }

    fn set_active_model(
        &self,
        provider_id: &str,
        model_id: &str,
    ) -> Result<SetActiveModelResult, ServerError> {
        let store = crate::config::models_store().map_err(map_store_error)?;
        // 与桌面 setActiveModel 同款 CAS 纪律：修订冲突时重读一次再
        // 提交（不静默覆盖并发的桌面编辑），二次冲突如实上报。
        for attempt in 0..2 {
            let snapshot = store.read().map_err(map_store_error)?;
            let revision = snapshot.revision.clone();
            let mut tree = snapshot_tree(&snapshot)?;
            validate_selectable(&tree, provider_id, model_id)?;
            tree.active_model = Some(ModelRef::new(provider_id, model_id));
            match store.apply(tree, &revision) {
                Ok(mut committed) => {
                    crate::config::publish_snapshot(&self.app, &mut committed);
                    let committed_tree = committed
                        .tree
                        .as_ref()
                        .ok_or_else(|| ServerError::internal("模型切换提交后缺少配置树"))?;
                    let active = committed_tree
                        .active_model
                        .as_ref()
                        .ok_or_else(|| ServerError::internal("模型切换提交后活动模型缺失"))?;
                    return Ok(SetActiveModelResult {
                        ok: true,
                        active_model: ActiveModelInfo {
                            provider_id: active.provider_id.clone(),
                            model_id: active.model_id.clone(),
                            display_name: resolve_display_name(committed_tree, active),
                        },
                    });
                }
                Err(error) if error.code == "REVISION_CONFLICT" && attempt == 0 => continue,
                Err(error) => return Err(map_store_error(error)),
            }
        }
        unreachable!("CAS 重试循环必在两次尝试内返回")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_provider::models::{ModalitiesSpec, ModelSpec, ProviderSpec};

    fn fixture_tree() -> UnifiedModelsConfig {
        let mut tree = UnifiedModelsConfig::default();
        tree.providers.insert(
            "anthropic".to_string(),
            ProviderSpec {
                display_name: Some("Anthropic".to_string()),
                models: vec![
                    ModelSpec {
                        id: "claude-sonnet".to_string(),
                        display_name: Some("Claude Sonnet".to_string()),
                        modalities: Some(ModalitiesSpec {
                            input: vec!["text".to_string(), "image".to_string()],
                            output: vec!["text".to_string()],
                        }),
                        ..Default::default()
                    },
                    ModelSpec {
                        id: "claude-haiku".to_string(),
                        ..Default::default()
                    },
                    ModelSpec {
                        id: "claude-off".to_string(),
                        enabled: false,
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        );
        tree.providers.insert(
            "off-provider".to_string(),
            ProviderSpec {
                enabled: false,
                models: vec![ModelSpec {
                    id: "hidden".to_string(),
                    ..Default::default()
                }],
                ..Default::default()
            },
        );
        tree.active_model = Some(ModelRef::new("anthropic", "claude-sonnet"));
        tree
    }

    #[test]
    fn project_models_lists_only_enabled_with_active_flag() {
        let result = project_models(&fixture_tree());
        // 停用供应商与停用模型不进可选集
        assert_eq!(result.models.len(), 2);
        assert_eq!(result.models[0].model_id, "claude-sonnet");
        assert!(result.models[0].active);
        assert_eq!(result.models[0].display_name, "Claude Sonnet");
        assert_eq!(
            result.models[0].provider_display_name.as_deref(),
            Some("Anthropic")
        );
        // displayName 缺省回退 modelId
        assert_eq!(result.models[1].model_id, "claude-haiku");
        assert!(!result.models[1].active);
        assert_eq!(result.models[1].display_name, "claude-haiku");
        // G5b 视觉投影：modalities.input 含 image 的模型标 true，
        // 未声明 modalities 的模型标 false（与引擎守卫同口径）。
        assert!(result.models[0].vision);
        assert!(!result.models[1].vision);
        let active = result.active_model.expect("activeModel 应回传");
        assert_eq!(active.provider_id, "anthropic");
        assert_eq!(active.model_id, "claude-sonnet");
        assert_eq!(active.display_name, "Claude Sonnet");
    }

    #[test]
    fn project_models_without_active_is_honest_none() {
        let mut tree = fixture_tree();
        tree.active_model = None;
        let result = project_models(&tree);
        assert!(result.active_model.is_none());
        assert!(result.models.iter().all(|model| !model.active));
    }

    #[test]
    fn project_models_reports_disabled_active_verbatim() {
        let mut tree = fixture_tree();
        tree.active_model = Some(ModelRef::new("anthropic", "claude-off"));
        let result = project_models(&tree);
        // 可选集不含停用模型，但 activeModel 仍按真源原样回传
        assert!(result.models.iter().all(|model| !model.active));
        let active = result.active_model.expect("activeModel 应回传");
        assert_eq!(active.model_id, "claude-off");
    }

    #[test]
    fn validate_selectable_accepts_enabled_target() {
        assert!(validate_selectable(&fixture_tree(), "anthropic", "claude-haiku").is_ok());
    }

    #[test]
    fn validate_selectable_rejects_unknown_or_disabled() {
        let tree = fixture_tree();
        for (provider_id, model_id) in [
            ("missing", "claude-sonnet"),
            ("off-provider", "hidden"),
            ("anthropic", "missing"),
            ("anthropic", "claude-off"),
        ] {
            let error =
                validate_selectable(&tree, provider_id, model_id).expect_err("目标必须被拒绝");
            match error {
                ServerError::Protocol { code, .. } => {
                    assert_eq!(code, DeviceErrorCode::CmdInvalid);
                }
                other => panic!("应为 Protocol 错误，实际 {other:?}"),
            }
        }
    }
}
