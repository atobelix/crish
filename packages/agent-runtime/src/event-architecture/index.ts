/**
 * Conex 事件架构 - 公共导出
 *
 * 提供：
 * 1. Canonical Event 模型
 * 2. Adapter 接口与 Runtime Adapter 实现
 * 3. Event Schema Registry
 * 4. 内置 Schema 定义
 */

export {
  // 核心值导出
  RuntimeCanonicalAdapter,
  EventSchemaRegistry,
  createCanonicalEvent,
  createDefaultSchemaRegistry,

  // Schema 定义
  RUNTIME_EVENT_SCHEMAS,
} from "./canonical-event";

export type {
  // 核心类型
  ConexEventDomain,
  ConexEventSourceLayer,
  ConexDiagnostic,
  ConexCanonicalEvent,

  // Adapter 接口
  ConexCanonicalAdapter,
  AdapterContext,

  // Schema
  SchemaValidationResult,
  SchemaValidationError,
  EventSchemaDefinition,
} from "./canonical-event";
