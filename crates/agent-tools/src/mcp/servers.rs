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
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn default_true() -> bool {
    true
}

/// MCP 传输方式（stdio / sse）
///
/// 序列化为小写字符串，缺省时回退 stdio（MCP 官方默认传输）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum McpTransport {
    /// stdio 子进程传输：命令经管道读写，JSON-RPC 消息按行分隔
    #[serde(rename = "stdio")]
    #[default]
    Stdio,
    /// SSE HTTP/SSE 传输：网络端点传输
    #[serde(rename = "sse")]
    Sse,
}

/// MCP server 启动配置（对齐 TS StdioServerParameters 与 SSE 配置）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// 配置唯一键（list-mcp-servers 返回的 id；工具名前缀来源）
    pub server_id: String,
    /// 启动命令（可执行文件路径或 PATH 内命令名，stdio 传输有效）
    #[serde(default)]
    pub command: String,
    /// 命令参数
    #[serde(default)]
    pub args: Vec<String>,
    /// 附加环境变量（与子进程继承的环境合并）
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// 传输方式（stdio 或 sse）
    #[serde(default)]
    pub transport: McpTransport,
    /// SSE 传输端点 URL（如 http://localhost:8080/sse）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 是否在引擎启动时自动拉起
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// 禁用的工具名列表
    #[serde(default)]
    pub disabled_tools: Vec<String>,
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
            url: None,
            auto_start: true,
            disabled_tools: Vec::new(),
        }
    }

    /// 构造 SSE 传输配置
    pub fn new_sse(server_id: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            server_id: server_id.into(),
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            transport: McpTransport::Sse,
            url: Some(url.into()),
            auto_start: true,
            disabled_tools: Vec::new(),
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

    /// 链式设置 auto_start
    pub fn with_auto_start(mut self, auto_start: bool) -> Self {
        self.auto_start = auto_start;
        self
    }

    /// 链式设置 disabled_tools
    pub fn with_disabled_tools(mut self, disabled_tools: Vec<String>) -> Self {
        self.disabled_tools = disabled_tools;
        self
    }

    /// 配置合法性校验（config.invalid）
    ///
    /// 规则：server_id 非空；
    /// 若 stdio 传输：command 非空；
    /// 若 sse 传输：url 非空；
    /// env 键非空且不含 `=`（避免伪造环境赋值）。
    pub fn validate(&self) -> Result<(), ToolError> {
        if self.server_id.trim().is_empty() {
            return Err(ToolError::new(codes::CONFIG_INVALID, "server_id 不能为空"));
        }
        match self.transport {
            McpTransport::Stdio => {
                if self.command.trim().is_empty() {
                    return Err(ToolError::new(
                        codes::CONFIG_INVALID,
                        format!("MCP server {} 的 command 不能为空", self.server_id),
                    ));
                }
            }
            McpTransport::Sse => {
                let Some(url) = &self.url else {
                    return Err(ToolError::new(
                        codes::CONFIG_INVALID,
                        format!("MCP server {} 的 url 不能为空", self.server_id),
                    ));
                };
                if url.trim().is_empty() {
                    return Err(ToolError::new(
                        codes::CONFIG_INVALID,
                        format!("MCP server {} 的 url 不能为空", self.server_id),
                    ));
                }
            }
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

/// 本地文件 MCP 配置持久化实现（生产级）
///
/// 将配置全量原子写入 `<app_dir>/mcp_servers.json`。
/// 写入策略：先写临时文件并 flush，再原子 rename 覆盖目标文件，
/// 防止断电或进程强杀产生截断的破损 JSON 配置文件。
pub struct LocalFileMcpPersistence {
    file_path: PathBuf,
}

impl LocalFileMcpPersistence {
    /// 传入应用数据目录（自动拼接 mcp_servers.json）或具体文件路径
    pub fn new(app_dir_or_file: impl Into<PathBuf>) -> Self {
        let mut path = app_dir_or_file.into();
        if path.is_dir() || path.extension().is_none() {
            path = path.join("mcp_servers.json");
        }
        Self { file_path: path }
    }

    /// 显式指定具体配置文件路径
    pub fn with_file_path(file_path: impl Into<PathBuf>) -> Self {
        Self {
            file_path: file_path.into(),
        }
    }

    /// 配置文件路径
    pub fn file_path(&self) -> &Path {
        &self.file_path
    }
}

#[async_trait]
impl McpConfigPersistence for LocalFileMcpPersistence {
    async fn load(&self) -> Result<Vec<McpServerConfig>, ToolError> {
        if !self.file_path.exists() {
            return Ok(Vec::new());
        }
        let content = std::fs::read_to_string(&self.file_path).map_err(|e| {
            ToolError::new(codes::CONFIG_INVALID, format!("读取 MCP 配置文件失败: {e}"))
        })?;
        if content.trim().is_empty() {
            return Ok(Vec::new());
        }
        let configs: Vec<McpServerConfig> = serde_json::from_str(&content).map_err(|e| {
            ToolError::new(codes::CONFIG_INVALID, format!("解析 MCP 配置文件失败: {e}"))
        })?;
        Ok(configs)
    }

    // 豁免理由：原子替换 MCP 配置文件，失败清理自家创建的临时文件与旧文件覆盖清理（非产品数据，不进回收站）
    #[allow(clippy::disallowed_methods)]
    async fn save(&self, configs: &[McpServerConfig]) -> Result<(), ToolError> {
        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::new(codes::CONFIG_INVALID, format!("创建配置目录失败: {e}"))
            })?;
        }
        let json_str = serde_json::to_string_pretty(configs).map_err(|e| {
            ToolError::new(codes::CONFIG_INVALID, format!("序列化 MCP 配置失败: {e}"))
        })?;
        let tmp_path = self.file_path.with_extension(format!(
            "tmp.{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::write(&tmp_path, json_str).map_err(|e| {
            ToolError::new(codes::CONFIG_INVALID, format!("写入 MCP 临时文件失败: {e}"))
        })?;
        if let Err(e) = std::fs::rename(&tmp_path, &self.file_path) {
            // 覆盖式重试前的清理：目标可能不存在（首次写入）——失败不影响重试，
            // 但若不是 NotFound 说明存在残留，必须留痕。
            if let Err(remove_err) = std::fs::remove_file(&self.file_path) {
                if remove_err.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(
                        path = %self.file_path.display(),
                        "清理 MCP 配置文件失败（将继续尝试覆盖写入）：{}",
                        remove_err
                    );
                }
            }
            std::fs::rename(&tmp_path, &self.file_path).map_err(|e2| {
                if let Err(cleanup_err) = std::fs::remove_file(&tmp_path) {
                    tracing::warn!(
                        path = %tmp_path.display(),
                        "清理 MCP 临时文件失败：{}",
                        cleanup_err
                    );
                }
                ToolError::new(
                    codes::CONFIG_INVALID,
                    format!("原子替换 MCP 配置文件失败: {e} / {e2}"),
                )
            })?;
        }
        Ok(())
    }
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

    #[tokio::test]
    async fn local_file_mcp_persistence_atomic_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "test_mcp_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let persistence = Arc::new(LocalFileMcpPersistence::new(&dir));

        let mut store = McpServerStore::with_persistence(persistence.clone());
        let stdio_cfg = sample("local_stdio", "my-cmd")
            .with_args(vec!["--verbose".to_string()])
            .with_auto_start(true)
            .with_disabled_tools(vec!["dangerous_eval".to_string()]);
        let sse_cfg = McpServerConfig::new_sse("remote_sse", "http://127.0.0.1:8080/sse")
            .with_auto_start(false);

        store.add(stdio_cfg.clone()).await.unwrap();
        store.add(sse_cfg.clone()).await.unwrap();
        assert_eq!(store.len(), 2);

        // 新建 store 从相同 persistence 加载
        let mut loaded_store = McpServerStore::with_persistence(persistence.clone());
        let count = loaded_store.load_from_persistence().await.unwrap();
        assert_eq!(count, 2);

        let s1 = loaded_store.get("local_stdio").unwrap();
        assert_eq!(s1.command, "my-cmd");
        assert_eq!(s1.transport, McpTransport::Stdio);
        assert!(s1.auto_start);
        assert_eq!(s1.disabled_tools, vec!["dangerous_eval"]);

        let s2 = loaded_store.get("remote_sse").unwrap();
        assert_eq!(s2.transport, McpTransport::Sse);
        assert_eq!(s2.url.as_deref(), Some("http://127.0.0.1:8080/sse"));
        assert!(!s2.auto_start);

        // 再次保存更新以验证覆盖写入
        loaded_store.remove("local_stdio").await.unwrap();
        assert_eq!(loaded_store.len(), 1);

        let mut reloaded = McpServerStore::with_persistence(persistence);
        reloaded.load_from_persistence().await.unwrap();
        assert_eq!(reloaded.len(), 1);
        assert!(reloaded.get("local_stdio").is_none());
        assert!(reloaded.get("remote_sse").is_some());
    }

    #[test]
    fn sse_validation() {
        let valid_sse = McpServerConfig::new_sse("srv", "http://localhost:3000/sse");
        assert!(valid_sse.validate().is_ok());

        let invalid_sse = McpServerConfig {
            server_id: "srv".to_string(),
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            transport: McpTransport::Sse,
            url: None,
            auto_start: true,
            disabled_tools: Vec::new(),
        };
        assert_eq!(invalid_sse.validate().unwrap_err().code(), "config.invalid");

        let empty_url_sse = McpServerConfig::new_sse("srv", "   ");
        assert_eq!(
            empty_url_sse.validate().unwrap_err().code(),
            "config.invalid"
        );
    }
}
