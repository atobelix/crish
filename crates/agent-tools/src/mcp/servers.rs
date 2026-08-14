//! MCP server 配置管理（任务书 B5.4 / 03 §3.2 C 组 list-mcp-servers 契约）
//!
//! 配置面：server_id / command / args / env / transport（stdio）。
//! - `McpServerConfig`：单台 server 的启动配置，serde camelCase，
//!   与 TS 端 StdioServerParameters（command/args/env）形状一致
//! - `McpServerStore`：内存配置表（保序）+ 可选持久化钩子
//!   （`McpConfigPersistence`，异步 load/save；无钩子时为纯内存）
//!
//! 错误协议：非法配置 → config.invalid；重复注册 / 配置缺失 → config.invalid /
//! mcp.server_not_found（复用 conex-types 既有码表，不新增码）。

use crate::definition::ToolError;
use async_trait::async_trait;
use conex_types::error::codes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// MCP 传输方式（当前仅 stdio）
///
/// 序列化为小写字符串，缺省时回退 stdio（MCP 官方默认传输）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum McpTransport {
    /// stdio 子进程传输：命令经管道读写，JSON-RPC 消息按行分隔
    #[serde(rename = "stdio")]
    #[default]
    Stdio,
}

/// MCP server 启动配置（对齐 TS StdioServerParameters）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// 配置唯一键（list-mcp-servers 返回的 id；工具名前缀来源）
    pub server_id: String,
    /// 启动命令（可执行文件路径或 PATH 内命令名）
    pub command: String,
    /// 命令参数
    #[serde(default)]
    pub args: Vec<String>,
    /// 附加环境变量（与子进程继承的环境合并）
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 传输方式（当前仅 stdio）
    #[serde(default)]
    pub transport: McpTransport,
}

impl McpServerConfig {
    /// 最小构造（stdio 传输，空参数与空环境）
    pub fn new(server_id: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            server_id: server_id.into(),
            command: command.into(),
            args: Vec::new(),
            env: HashMap::new(),
            transport: McpTransport::Stdio,
        }
    }

    /// 链式设置命令参数
    pub fn with_args(mut self, args: Vec<String>) -> Self {
        self.args = args;
        self
    }

    /// 链式设置附加环境变量
    pub fn with_env(mut self, env: HashMap<String, String>) -> Self {
        self.env = env;
        self
    }

    /// 配置合法性校验（config.invalid）
    ///
    /// 规则：server_id 与 command 非空；env 键非空且不含 `=`（避免伪造环境赋值）。
    pub fn validate(&self) -> Result<(), ToolError> {
        if self.server_id.trim().is_empty() {
            return Err(ToolError::new(codes::CONFIG_INVALID, "server_id 不能为空"));
        }
        if self.command.trim().is_empty() {
            return Err(ToolError::new(
                codes::CONFIG_INVALID,
                format!("MCP server {} 的 command 不能为空", self.server_id),
            ));
        }
        for key in self.env.keys() {
            if key.is_empty() {
                return Err(ToolError::new(codes::CONFIG_INVALID, "环境变量键不能为空"));
            }
            if key.contains('=') {
                return Err(ToolError::new(
                    codes::CONFIG_INVALID,
                    format!("环境变量键不能包含 '='：{key:?}"),
                ));
            }
        }
        Ok(())
    }
}

/// 配置持久化钩子（可选；不提供时配置仅存内存）
///
/// 实现方负责自身存储（文件/数据库等）与失败语义；save 失败时
/// 变更方会收到错误（内存态已改，落盘态未改，由调用方决定处理）。
#[async_trait]
pub trait McpConfigPersistence: Send + Sync {
    /// 读取全部配置（启动时灌入内存表；实现方可按 server_id 排序）
    async fn load(&self) -> Result<Vec<McpServerConfig>, ToolError>;

    /// 全量写回（保存当前内存表快照）
    async fn save(&self, configs: &[McpServerConfig]) -> Result<(), ToolError>;
}

/// MCP server 配置表（内存 + 可选持久化钩子）
///
/// 语义对齐 TS McpLifecycleManager 的 controllers 配置集：
/// - add：重复 server_id 拒绝；update：不存在则报 server_not_found
/// - list：按插入顺序返回（配置面保序，与 ToolRegistry 保序一致）
/// - 有持久化钩子时，每次变更后自动全量保存
pub struct McpServerStore {
    configs: HashMap<String, McpServerConfig>,
    order: Vec<String>,
    persistence: Option<Arc<dyn McpConfigPersistence>>,
}

impl Default for McpServerStore {
    fn default() -> Self {
        Self::new()
    }
}

impl McpServerStore {
    /// 纯内存配置表（无持久化钩子）
    pub fn new() -> Self {
        Self {
            configs: HashMap::new(),
            order: Vec::new(),
            persistence: None,
        }
    }

    /// 带持久化钩子的配置表（变更后自动全量保存）
    pub fn with_persistence(persistence: Arc<dyn McpConfigPersistence>) -> Self {
        Self {
            configs: HashMap::new(),
            order: Vec::new(),
            persistence: Some(persistence),
        }
    }

    /// 从持久化钩子加载配置（覆盖当前内存态；无钩子时返回 0 且不报错）
    pub async fn load_from_persistence(&mut self) -> Result<usize, ToolError> {
        let Some(persistence) = &self.persistence else {
            return Ok(0);
        };
        let loaded = persistence.load().await?;
        self.configs.clear();
        self.order.clear();
        for config in loaded {
            self.insert_locked(config);
        }
        Ok(self.order.len())
    }

    /// 新增配置（重复 server_id → config.invalid；非法配置同样拒绝）
    pub async fn add(&mut self, config: McpServerConfig) -> Result<(), ToolError> {
        config.validate()?;
        if self.configs.contains_key(&config.server_id) {
            return Err(ToolError::new(
                codes::CONFIG_INVALID,
                format!("MCP server 配置已存在：{}", config.server_id),
            ));
        }
        self.insert_locked(config);
        self.persist().await
    }

    /// 更新配置（以 config.server_id 为键整体替换；不存在 → mcp.server_not_found）
    ///
    /// 注意：server_id 是键，不可通过 update 改名（改名 = remove + add）。
    pub async fn update(&mut self, config: McpServerConfig) -> Result<(), ToolError> {
        config.validate()?;
        if !self.configs.contains_key(&config.server_id) {
            return Err(ToolError::new(
                codes::MCP_SERVER_NOT_FOUND,
                format!("MCP server 配置不存在：{}", config.server_id),
            ));
        }
        self.configs.insert(config.server_id.clone(), config);
        self.persist().await
    }

    /// 删除配置（返回被删配置；不存在 → mcp.server_not_found）
    pub async fn remove(&mut self, server_id: &str) -> Result<McpServerConfig, ToolError> {
        let removed = self.configs.remove(server_id).ok_or_else(|| {
            ToolError::new(
                codes::MCP_SERVER_NOT_FOUND,
                format!("MCP server 配置不存在：{server_id}"),
            )
        })?;
        self.order.retain(|id| id != server_id);
        self.persist().await?;
        Ok(removed)
    }

    /// 按 id 查询（未配置返回 None）
    pub fn get(&self, server_id: &str) -> Option<&McpServerConfig> {
        self.configs.get(server_id)
    }

    /// 按插入顺序列出全部配置
    pub fn list(&self) -> Vec<McpServerConfig> {
        self.order
            .iter()
            .filter_map(|id| self.configs.get(id).cloned())
            .collect()
    }

    /// 已配置数量
    pub fn len(&self) -> usize {
        self.configs.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.configs.is_empty()
    }

    /// 显式全量保存（无钩子时 no-op）
    pub async fn persist(&self) -> Result<(), ToolError> {
        let Some(persistence) = &self.persistence else {
            return Ok(());
        };
        persistence.save(&self.list()).await
    }

    /// 内部插入（调用方已保证不重复）
    fn insert_locked(&mut self, config: McpServerConfig) {
        self.order.push(config.server_id.clone());
        self.configs.insert(config.server_id.clone(), config);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用持久化钩子：内存快照（记录每次 save 的全量副本）
    struct FakePersistence {
        saved: std::sync::Mutex<Vec<Vec<McpServerConfig>>>,
    }

    impl FakePersistence {
        fn new() -> Self {
            Self {
                saved: std::sync::Mutex::new(Vec::new()),
            }
        }

        // PE-07 T07.6：下列 2 处 expect 属测试专属持久化（cfg(test)），非运行时路径，
        // 按任务书「测试 expect 保留但标注」处置，保持不动。
        fn snapshots(&self) -> Vec<Vec<McpServerConfig>> {
            self.saved
                .lock()
                .expect("测试持久化锁中毒后不可恢复")
                .clone()
        }
    }

    #[async_trait]
    impl McpConfigPersistence for FakePersistence {
        async fn load(&self) -> Result<Vec<McpServerConfig>, ToolError> {
            // 无预置内容，加载为空
            Ok(Vec::new())
        }

        async fn save(&self, configs: &[McpServerConfig]) -> Result<(), ToolError> {
            self.saved
                .lock()
                .expect("测试持久化锁中毒后不可恢复")
                .push(configs.to_vec());
            Ok(())
        }
    }

    fn sample(server_id: &str, command: &str) -> McpServerConfig {
        McpServerConfig::new(server_id, command)
    }

    #[tokio::test]
    async fn add_get_list_keeps_order() {
        let mut store = McpServerStore::new();
        assert!(store.is_empty());
        store.add(sample("a", "cmd-a")).await.unwrap();
        store.add(sample("b", "cmd-b")).await.unwrap();
        store.add(sample("c", "cmd-c")).await.unwrap();
        assert_eq!(store.len(), 3);
        assert_eq!(
            store
                .list()
                .iter()
                .map(|c| c.server_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        assert_eq!(store.get("b").unwrap().command, "cmd-b");
        assert!(store.get("nope").is_none());
    }

    #[tokio::test]
    async fn duplicate_add_rejected() {
        let mut store = McpServerStore::new();
        store.add(sample("a", "cmd")).await.unwrap();
        let err = store.add(sample("a", "other")).await.unwrap_err();
        assert_eq!(err.code(), "config.invalid");
        assert!(err.to_string().contains("已存在"));
        // 原配置未被覆盖
        assert_eq!(store.get("a").unwrap().command, "cmd");
        assert_eq!(store.len(), 1);
    }

    #[tokio::test]
    async fn update_replaces_and_keeps_position() {
        let mut store = McpServerStore::new();
        store.add(sample("a", "cmd-a")).await.unwrap();
        store.add(sample("b", "cmd-b")).await.unwrap();
        let mut updated = sample("b", "cmd-b2");
        updated.args = vec!["--x".to_string()];
        store.update(updated).await.unwrap();
        let b = store.get("b").unwrap();
        assert_eq!(b.command, "cmd-b2");
        assert_eq!(b.args, vec!["--x"]);
        // 顺序不变
        assert_eq!(
            store
                .list()
                .iter()
                .map(|c| c.server_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
    }

    #[tokio::test]
    async fn update_missing_returns_server_not_found() {
        let mut store = McpServerStore::new();
        let err = store.update(sample("nope", "cmd")).await.unwrap_err();
        assert_eq!(err.code(), "mcp.server_not_found");
    }

    #[tokio::test]
    async fn remove_returns_removed_and_missing_errors() {
        let mut store = McpServerStore::new();
        store.add(sample("a", "cmd-a")).await.unwrap();
        store.add(sample("b", "cmd-b")).await.unwrap();
        let removed = store.remove("a").await.unwrap();
        assert_eq!(removed.server_id, "a");
        assert!(store.get("a").is_none());
        assert_eq!(store.len(), 1);
        let err = store.remove("a").await.unwrap_err();
        assert_eq!(err.code(), "mcp.server_not_found");
        // 其余顺序保持
        assert_eq!(store.list()[0].server_id, "b");
    }

    #[tokio::test]
    async fn validate_rejects_bad_config() {
        let mut store = McpServerStore::new();
        // 空 server_id
        let err = store.add(sample("", "cmd")).await.unwrap_err();
        assert_eq!(err.code(), "config.invalid");
        // 空 command
        let err = store.add(sample("a", "")).await.unwrap_err();
        assert_eq!(err.code(), "config.invalid");
        // env 键为空
        let mut bad = sample("a", "cmd");
        bad.env.insert(String::new(), "v".to_string());
        let err = store.add(bad).await.unwrap_err();
        assert_eq!(err.code(), "config.invalid");
        // env 键含 '='
        let mut bad = sample("a", "cmd");
        bad.env.insert("A=B".to_string(), "v".to_string());
        let err = store.add(bad).await.unwrap_err();
        assert_eq!(err.code(), "config.invalid");
        assert!(store.is_empty());
    }

    #[test]
    fn serde_camel_case_roundtrip() {
        let mut config = sample("filesystem", "npx");
        config.args = vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-filesystem".to_string(),
        ];
        config
            .env
            .insert("PATH".to_string(), "/usr/bin".to_string());
        let value = serde_json::to_value(&config).unwrap();
        // 字段 camelCase：serverId / args / env / transport
        assert_eq!(value["serverId"], "filesystem");
        assert_eq!(value["command"], "npx");
        assert_eq!(value["transport"], "stdio");
        assert_eq!(value["args"][1], "@modelcontextprotocol/server-filesystem");
        let back: McpServerConfig = serde_json::from_value(value).unwrap();
        assert_eq!(back, config);
    }

    #[test]
    fn serde_defaults_transport_and_missing_fields() {
        // 缺 transport / args / env 时回退默认值
        let raw = r#"{"serverId":"s1","command":"cmd"}"#;
        let config: McpServerConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(config.transport, McpTransport::Stdio);
        assert!(config.args.is_empty());
        assert!(config.env.is_empty());
    }

    #[tokio::test]
    async fn persistence_hook_saves_snapshot_on_each_mutation() {
        let persistence = Arc::new(FakePersistence::new());
        let mut store = McpServerStore::with_persistence(persistence.clone());
        store.add(sample("a", "cmd-a")).await.unwrap();
        store.add(sample("b", "cmd-b")).await.unwrap();
        assert_eq!(persistence.snapshots().len(), 2);
        assert_eq!(persistence.snapshots()[0].len(), 1);
        assert_eq!(persistence.snapshots()[1].len(), 2);
        store.remove("a").await.unwrap();
        assert_eq!(persistence.snapshots().len(), 3);
        assert_eq!(persistence.snapshots()[2].len(), 1);
        assert_eq!(persistence.snapshots()[2][0].server_id, "b");
    }

    #[tokio::test]
    async fn persistence_load_seeds_store() {
        // 先经 store A 写入，再经共享钩子新建 store B 加载
        let persistence = Arc::new(FakePersistence::new());
        {
            let mut store = McpServerStore::with_persistence(persistence.clone());
            store.add(sample("a", "cmd-a")).await.unwrap();
        }
        let mut store = McpServerStore::with_persistence(persistence.clone());
        let loaded = store.load_from_persistence().await.unwrap();
        assert_eq!(loaded, 0); // 假钩子 load 为空
        assert!(store.is_empty());
    }

    #[tokio::test]
    async fn memory_only_store_persist_is_noop() {
        let mut store = McpServerStore::new();
        store.add(sample("a", "cmd")).await.unwrap();
        store.persist().await.unwrap(); // 无钩子：no-op 不报错
        assert_eq!(store.len(), 1);
    }
}
