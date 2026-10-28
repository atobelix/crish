/**
 * 协作子代理的后端持久化扩展字段（session_agents v6/v9/v14 列）。
 *
 * 独立成模块以控制 store/types.ts 体积；字段均为可选，旧载荷兼容。
 */

export interface SessionAgentRuntimeMeta {
  /** 任务类型（analysis/design/...；后端 v6 列，展示/审计用） */
  taskType?: string | undefined;
  /** 显式写路径白名单（后端 v6 列；恢复/展示用） */
  allowedWritePaths?: string[] | undefined;
  /** 子会话 id（后端 v9 列；子代理独立会话反查键） */
  subSessionId?: string | undefined;
  /**
   * spawn 时声明的能力档（read-only / all；后端 v14 列）。
   * 运行期生效值仍由引擎按父链钳制；前端仅展示。
   */
  capabilityMode?: string | undefined;
  /** 绑定的模型覆盖（None = 跟随引擎配置；后端 v14 列） */
  modelOverride?: string | undefined;
  /** 重启中断后可恢复（后端对账置 true；正常终态 false） */
  resumable?: boolean | undefined;
  /** 最近心跳 epoch ms（后端运行期周期刷新） */
  lastHeartbeatMs?: number | undefined;
}
