//! 默认生产适配器：内存 / LocalDb 声明与产出清单存储、内存状态行源（自 wait_channel.rs 原样搬迁）

use std::collections::HashMap;
use std::sync::Mutex;

use agent_tools::tools::wait_subagents::{
    dispatch_outputs_value, parse_dispatch_outputs, DispatchDeclaration, SubagentOutput,
    SubagentWaitError, DISPATCH_META_KEY_AGENTS, DISPATCH_META_KEY_DISPATCHED_AT,
    DISPATCH_META_KEY_MODE, DISPATCH_META_KEY_OUTPUTS, DISPATCH_META_KEY_WAIT_MS,
};
use conex_db::LocalDb;
use conex_types::SessionAgent;

use super::{SubagentStatusSource, WaitStore, DECLARATION_CAP};

// ── 默认生产适配器 ────────────────────────────────────────────────

/// 内存持久化适配（引擎默认装配；conex-db session_meta 真适配在 R-CF3
/// 后续轮接线——键形状已冻结为 wait_subagents.rs:83-99 的 dispatch_* 与
/// `dispatch_outputs`，真适配用 [DispatchDeclaration::to_meta_pairs] /
/// `from_meta_pairs` 与 `dispatch_outputs_value` / `parse_dispatch_outputs`
/// 落读）
#[derive(Default)]
pub struct MemoryWaitStore {
    /// 声明列表（保留最近 [DECLARATION_CAP] 条；watchdog 取最近分发时刻）
    declarations: Mutex<Vec<DispatchDeclaration>>,
    /// 各子代理产出清单（单键 `dispatch_outputs` 整表覆盖，天然有界）
    outputs: Mutex<HashMap<String, Vec<SubagentOutput>>>,
}

impl MemoryWaitStore {
    /// 新建内存存储
    pub fn new() -> Self {
        Self::default()
    }

    /// 清空全部 dispatch 声明（watchdog 在子代理全终态时核销历史声明）
    pub fn clear_all(&self) {
        self.declarations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

impl WaitStore for MemoryWaitStore {
    fn load_all(&self) -> Vec<DispatchDeclaration> {
        self.declarations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn save(&self, declaration: &DispatchDeclaration) {
        let mut list = self.declarations.lock().unwrap_or_else(|e| e.into_inner());
        // 幂等：同一分发时刻的声明覆盖（同一次 wait 调用重复持久化）
        if let Some(slot) = list
            .iter_mut()
            .find(|d| d.dispatched_at_ms == declaration.dispatched_at_ms)
        {
            *slot = declaration.clone();
        } else {
            list.push(declaration.clone());
        }
        // 条数护栏：只保留最近 DECLARATION_CAP 条（按分发时刻取最新）
        if list.len() > DECLARATION_CAP {
            list.sort_by_key(|d| std::cmp::Reverse(d.dispatched_at_ms));
            list.truncate(DECLARATION_CAP);
        }
    }

    fn save_outputs(
        &self,
        outputs: &HashMap<String, Vec<SubagentOutput>>,
    ) -> Result<(), SubagentWaitError> {
        // 经序列化 → 解析往返落库：与 session_meta 真适配（conex-db）
        // 读取形状闭环一致——dispatch_outputs_value 容错恒非失败（失败
        // 回退 "{}"），解析容错归一（空路径条目剔除），落库即「读回
        // 与写入一致」的规范形态
        let value = dispatch_outputs_value(outputs);
        let parsed = parse_dispatch_outputs(Some(&value));
        *self.outputs.lock().unwrap_or_else(|e| e.into_inner()) = parsed;
        // 内存实现恒成功；PersistFailed 为未来 conex-db 适配预留出口
        Ok(())
    }

    fn load_outputs(&self) -> HashMap<String, Vec<SubagentOutput>> {
        self.outputs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// LocalDb session_meta 真适配（`dispatch_*` 五键 + `dispatch_outputs`
/// 键；单声明槽语义——键不可枚举且不引入索引键，DECLARATION_CAP 多槽
/// 语义退化为最新覆盖，见 D4 §8 D-2 / 02 定夺 W9；两个消费面
/// （wait_for_terminal 的 max(dispatched_at) 基准 wait_channel.rs:434-441、
/// watchdog 最近分发时刻扫描 watchdog.rs:112-150）均取最大值，单槽
/// 语义等价）
#[derive(Clone)]
pub struct LocalDbWaitStore {
    db: LocalDb,
}

impl LocalDbWaitStore {
    /// 新建真适配（db 由装配点提供；轮 2 装配替换时注入）
    pub fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl WaitStore for LocalDbWaitStore {
    fn load_all(&self) -> Vec<DispatchDeclaration> {
        // 逐键读 dispatch_* 四键 → from_meta_pairs 宽容解析（缺键 / 坏值
        // → None，fail-open 与内存版 load_all 语义对齐）
        let pairs: Vec<(&str, String)> = [
            DISPATCH_META_KEY_MODE,
            DISPATCH_META_KEY_WAIT_MS,
            DISPATCH_META_KEY_AGENTS,
            DISPATCH_META_KEY_DISPATCHED_AT,
        ]
        .into_iter()
        .filter_map(|k| self.db.get_session_meta(k).ok().flatten().map(|v| (k, v)))
        .collect();
        DispatchDeclaration::from_meta_pairs(pairs)
            .into_iter()
            .collect()
    }

    fn save(&self, declaration: &DispatchDeclaration) {
        // 单声明槽：最新覆盖（upsert 幂等；不引入多槽/索引新键）
        for (key, value) in declaration.to_meta_pairs() {
            let _ = self.db.set_session_meta(key, &value);
        }
    }

    fn save_outputs(
        &self,
        outputs: &HashMap<String, Vec<SubagentOutput>>,
    ) -> Result<(), SubagentWaitError> {
        // 整表覆盖语义（单键 upsert，天然有界；与内存版一致）
        self.db
            .set_session_meta(DISPATCH_META_KEY_OUTPUTS, &dispatch_outputs_value(outputs))
            .map_err(|e| SubagentWaitError::PersistFailed(e.to_string()))
    }

    fn load_outputs(&self) -> HashMap<String, Vec<SubagentOutput>> {
        // 缺失 / 损坏键 → 空表（parse 容错，fail-open）
        parse_dispatch_outputs(
            self.db
                .get_session_meta(DISPATCH_META_KEY_OUTPUTS)
                .ok()
                .flatten()
                .as_deref(),
        )
    }
}

/// 内存状态行源（引擎默认装配；conex-db session_agents 真适配在 R-CF3
/// 后续轮接线——表结构对齐 conex-db agents.rs 的
/// `load_session_agents` 行形状）
#[derive(Default)]
pub struct MemoryAgentSource {
    /// 会话子代理行（本会话；装配方 / 测试注入）
    agents: Mutex<Vec<SessionAgent>>,
}

impl MemoryAgentSource {
    /// 新建内存状态行源（空集合）
    pub fn new() -> Self {
        Self::default()
    }

    /// 注入子代理行（测试注入与引擎装配共用；幂等覆盖）
    pub fn set_agents(&self, agents: Vec<SessionAgent>) {
        *self.agents.lock().unwrap_or_else(|e| e.into_inner()) = agents;
    }
}

impl SubagentStatusSource for MemoryAgentSource {
    fn load_agents(&self) -> Vec<SessionAgent> {
        self.agents
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}
