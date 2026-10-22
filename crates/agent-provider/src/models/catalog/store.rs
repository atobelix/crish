//! 模型目录存储、文件包装与生命周期方法

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::models::catalog_types::UnifiedModelsConfig;

use super::entry::ModelCatalogEntry;
use super::live::{project_unified_to_catalog, LiveModels};

/// v2 文件级包装（v2 Schema §3.4；`version` 与 [ModelCatalog::version] 同语义，
/// 远程合并 / 覆盖回写后 +1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogFile {
    /// 文件版本号（内置静态表起始 0）
    pub version: u64,
    /// 字段集版本（"2.0"，防止旧消费方误解析新字段集）
    pub schema: String,
    /// 文件级更新时间（YYYY-MM-DD）
    pub updated_at: Option<String>,
    /// 条目映射（键 = vendor::model）
    pub entries: BTreeMap<String, ModelCatalogEntry>,
}

/// 目录变更错误（T-24：覆盖白名单拒绝；"失败不阻塞仅记录"语义下用于记录/计数）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CatalogError {
    /// 覆盖项含白名单外字段，或试图改动禁覆盖键（model / provider / vendor）
    #[error("覆盖白名单外字段：{0}")]
    ForbiddenField(String),
    /// 覆盖项结构非法（非对象 / 缺身份键 / 字段类型错误）
    #[error("覆盖项无效：{0}")]
    InvalidOverride(String),
}

/// 运行时模型目录（内置表 + 覆盖 + 扫描合并的单一真源；T-24 扩展
/// `with_overrides` / `upsert_from_scan` 变更入口，任何变更版本号 +1）
#[derive(Debug, Clone)]
pub struct ModelCatalog {
    /// 键 = "{vendor}::{model}"（同模型多通道按 provider 区分）
    /// （pub(crate)：request/cache.rs 等消费方单测需构造独立目录验证档位语义）
    pub(crate) entries: BTreeMap<String, ModelCatalogEntry>,
    /// 单调递增版本号（对齐 litellm `_model_cost_mutation_generation`；下游 memoize 失效键）
    pub(crate) version: u64,
}

impl ModelCatalog {
    /// 创建完全空白的模型目录（无任何默认供应商，落实最高产品原则：
    /// “软件默认是不带有任何供应商的，后面用户下载了可别一堆没用的供应商”）。
    pub fn empty() -> Self {
        Self {
            entries: BTreeMap::new(),
            version: 0,
        }
    }

    /// 内置表：catalog.json 编译期打包（无运行时 IO、用于单测与离线回落）。
    ///
    /// v2 文件级包装（schema §3.4：version / schema / updatedAt / entries），
    /// 解析失败即 panic——转录错误由"catalog.json serde 全量解析"单测钉死。
    ///
    /// **Stage 1 / ACT-104**：解析产物经 [`OnceLock`] 进程级缓存——首次
    /// 调用完成 serde 反序列化后，后续调用仅 `clone`（Arc 共享条目表），
    /// 避免重复解析。State 契约仍为 `Arc<RwLock<ModelCatalog>>`（可变
    /// 刷新 / `upsert_from_scan` 兼容）；**禁止**用只读 OnceCell 替换 State。
    pub fn bundled() -> Self {
        static BUNDLED: std::sync::OnceLock<ModelCatalog> = std::sync::OnceLock::new();
        BUNDLED
            .get_or_init(|| {
                let file: ModelCatalogFile = serde_json::from_str(include_str!("../catalog.json"))
                    .expect("内置 catalog.json 必须可解析（serde 全量解析测试钉死转录错误）");
                ModelCatalog {
                    // 预填资产的旧文件键只在加载时转换；运行索引采用 JSON 二元组。
                    entries: file
                        .entries
                        .into_iter()
                        .map(|(key, entry)| {
                            let (provider, model) = key
                                .split_once("::")
                                .expect("内置预填资产必须含完整供应商与模型键");
                            (ModelCatalogEntry::key(provider, model), entry)
                        })
                        .collect(),
                    version: 0,
                }
            })
            .clone()
    }

    /// 从 YAML 字符串构建运行时模型目录快照。
    ///
    /// 与 [LiveModels::from_yaml_str] / [UnifiedModelsConfig::from_yaml_str] 同一套 v2 解析：
    /// 先得到树，再投影本目录。禁止第二套 `DynamicYamlModalities` 解析器。
    ///
    /// **本函数不读盘**：`models.yaml` 的唯一读面是 `ModelsStore`（单写单读口），
    /// 目录快照只能由 [LiveModels::from_committed] 从已提交树投影。
    pub fn from_yaml_str(yaml_str: &str) -> Result<Self, String> {
        Ok(LiveModels::from_yaml_str(yaml_str)?.catalog)
    }

    /// 从已解析的 v2 树投影目录（不重新解析 yaml）。
    pub fn from_unified(tree: &UnifiedModelsConfig) -> Result<Self, String> {
        let mut normalized = tree.clone();
        normalized.normalize_for_commit()?;
        Ok(project_unified_to_catalog(&normalized))
    }

    /// 动态原子更新运行时目录快照（单调递增版本号）。
    pub fn reload(&mut self, new_catalog: Self) {
        self.entries = new_catalog.entries;
        self.version += 1;
    }

    /// 从 YAML 内容重载运行时快照（内存态，不读盘）。
    pub fn reload_from_yaml_str(&mut self, yaml_str: &str) -> Result<(), String> {
        let new_catalog = Self::from_yaml_str(yaml_str)?;
        self.reload(new_catalog);
        Ok(())
    }

    /// 当前版本号（下游 memoize 失效键；内置表为 0，T-24 覆盖/合并时 bump）
    pub fn version(&self) -> u64 {
        self.version
    }

    /// 全量条目只读迭代（键 = `"{vendor}::{model}"`，与 `entries` 同序）。
    ///
    /// 供 apps 层做**只读投影**（如 `workbench_read_bundled_catalog` 把内置目录
    /// 快照化返回给前端定价面）。`entries` 字段本身是 `pub(crate)`，外部 crate
    /// 无法直接访问，故提供本迭代器；不暴露可变句柄（目录只增不改）。
    pub fn iter_entries(&self) -> impl Iterator<Item = (&str, &ModelCatalogEntry)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }
}
