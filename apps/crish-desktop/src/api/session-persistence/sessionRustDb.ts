/**
 * Stream D: Rust SQLite 会话持久化层 · 门面（barrel）
 *
 * 设计目标（系统化改造，非补丁式）：
 *   - 用 SQLite（conex-db）作为唯一会话存储，替代 localStorage + IndexedDB + 磁盘镜像三层冗余
 *   - 全部 14 个 API 走 Tauri invoke → Rust spawn_blocking → SQLite
 *   - 命令缺失（浏览器 / 旧壳 / 测试环境）→ 回退到 localStorage 同步路径
 *   - JS ↔ Rust 数据形状转换在此层完成（toolCalls/blocks 数组 ↔ JSON 字符串）
 *
 * 数据形状差异：
 *   - JS SessionMessage.toolCalls   ↔ Rust SessionMessage.tool_calls_json  (JSON 字符串)
 *   - JS SessionMessage.blocks      ↔ Rust SessionMessage.blocks_json     (JSON 字符串)
 *   - JS SessionMessage.toolCallResults ↔ Rust SessionMessage.tool_call_results_json
 *   - JS SessionMessage.streamTextOffset ↔ Rust SessionMessage.stream_text_offset (仅命名差异，serde camelCase 已对齐)
 *   - JS SessionMessage.thinkingTime ↔ Rust SessionMessage.thinking_time (serde camelCase 已对齐)
 *   - JS SessionAgent.subagentPath  ↔ Rust SessionAgent.subagent_path_json (JSON 字符串)
 *   - JS SessionIndexEntry.pinnedMessageIds: string[] ↔ Rust SessionIndexEntry.pinned_message_ids: Option<String> (JSON 字符串)
 *
 * 命令错误协议：invokeResult 三态（ok/missing/error）。
 *   - ok → 返回 Rust 数据
 *   - missing → 返回 null，调用方回退到 localStorage
 *   - error → 返回 null，调用方回退到 localStorage（错误细节仅日志记录）
 * Rust 侧 CoreError（serde tagged enum）序列化形态保留，但 JS 侧不按 kind 路由——
 * 当前所有错误一律回退 localStorage，避免单点错误阻塞会话读写。
 *
 * 拆分结构（G-03 HARD 治理，2026-08-13）：
 *   - sessionRustDbWire.ts     JS ↔ Rust 形状转换层（纯函数）
 *   - sessionRustDbFallback.ts localStorage 同步回退 + 降级戳
 *   - sessionRustDbSql.ts      SQLite invoke API 面 + 写竞态防线（队列 + 版本戳 CAS）
 *   - sessionRustDbHydrate.ts  hydrate / persist 复合 API
 *   本门面仅 re-export 公开 API，调用方零改动（含 sessionSharedHelpers 的
 *   setPersistenceStatus 接线与 ConnectionLifecycle 动态 import 面）。
 */

export {
  cleanupLegacyLocalStorageSessionsGuarded,
  getSessionMeta,
  importFromLocalStorage,
  loadSessionBody,
  readAgentsOverCapMeta,
  setSessionMeta,
  type ImportFromLocalStorageData,
  type LegacyCleanupGuardResult,
} from './sessionRustDbSql';

export {
  hydrateSessionsFromRust,
  persistAllSessionsRust,
  persistAllSessionsSyncViaLocalStorage,
} from './sessionRustDbHydrate';
