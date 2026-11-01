// F6 模型域命令构造与响应解析（G2/W-B 数据层纯逻辑）
//
// 对齐依据：
// - 字段真源：crates/conex-device-protocol/contracts/device-protocol.json
//   （C38 listModels / C39 setActiveModel；commands 段 name/kind/paramsType/
//   resultType + types 段字段表）；
// - 语义对照：任务书的 GET /v1/models ≡ C38 listModels、POST /v1/models/active
//   ≡ C39 setActiveModel——现行命令面是 WS remote.* 命令面（与 listWorkspaces/
//   switchWorkspace 同形态同注册），无 HTTP /v1 模型端点；
// - 真源口径：两命令读写桌面统一模型树（UnifiedModelsConfig.activeModel），
//   与桌面「设置 → 模型」页的全局默认是同一份数据（用户裁决 Q3：切换 =
//   改全局默认，含桌面端生效），本文件不引入任何手机本地模型状态；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}，
//   kind 与 body.command 后缀必须一致（生成解析器校验）；
// - 响应解析：复用生成解析器（parseListModelsResult / parseSetActiveModelResult）
//   ——不手写第二套字段校验（M5 §1.3 组合纪律）。

import type {
  ListModelsResult,
  SetActiveModelParams,
  SetActiveModelResult,
  CommandRequest,
} from '@crish/shared-types';
import {
  parseListModelsResult as parseWireListModelsResult,
  parseSetActiveModelResult as parseWireSetActiveModelResult,
} from '@crish/shared-types';
import type { ParseResult } from '@crish/shared-types';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F6 模型域 2 条命令名（C38/C39，G2 增补） */
export type ModelCommandName = 'listModels' | 'setActiveModel';

/** F6 模型域 2 条命令 kind（协议层消息类别） */
export type ModelCommandKind = 'remote.listModels' | 'remote.setActiveModel';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.） */
export const MODEL_COMMAND_KIND: Record<ModelCommandName, ModelCommandKind> = {
  listModels: 'remote.listModels',
  setActiveModel: 'remote.setActiveModel',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface ModelCommandRequest {
  kind: ModelCommandKind;
  body: CommandRequest;
}

// ── 模型身份键 ──────────────────────────────────────────────────────────────

/**
 * 模型身份键：(providerId, modelId) 二元组的 JSON 编码——与桌面 modelRefKey
 * 同口径。裸 modelId 永不作身份（跨供应商可重名，桌面同名模型并存）。
 */
export function modelRefKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────

/** C38 可选模型列表 + 当前全局默认：参数恒空对象 */
export function buildListModelsRequest(): ModelCommandRequest {
  return {
    kind: 'remote.listModels',
    body: { command: 'listModels', params: {} },
  };
}

/** C39 切换全局默认模型：目标 = (providerId, modelId) 二元组（须在可选集内） */
export function buildSetActiveModelRequest(
  params: SetActiveModelParams
): ModelCommandRequest {
  return {
    kind: 'remote.setActiveModel',
    body: { command: 'setActiveModel', params: { ...params } },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** F6 模型域 2 条命令响应载荷联合（生成 resultType 全集） */
export type ModelCommandResultPayload = ListModelsResult | SetActiveModelResult;

/** 命令名 → 响应载荷类型映射（生成 resultType） */
export interface ModelCommandResultMap {
  listModels: ListModelsResult;
  setActiveModel: SetActiveModelResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷；
 * WsGateway.invoke 已解信封，此处校验 result 内容）。
 */
export function parseModelCommandResult<T extends ModelCommandName>(
  command: T,
  raw: unknown
): ParseResult<ModelCommandResultMap[T]> {
  const result = parseAnyModelCommandResult(command, raw);
  return result as ParseResult<ModelCommandResultMap[T]>;
}

function parseAnyModelCommandResult(
  command: ModelCommandName,
  raw: unknown
): ParseResult<ModelCommandResultPayload> {
  switch (command) {
    case 'listModels':
      return parseWireListModelsResult(raw);
    case 'setActiveModel':
      return parseWireSetActiveModelResult(raw);
  }
}
