// 模型域命令仓库（G2/W-B 接线层）：WsGateway.invoke → modelCommands 构造/解析
//
// 职责（对齐 M5 §1.2 repository 组合纪律：仓库 = 命令构造 + 网络发送 + 响应解析）：
// - 命令发送唯一入口：listModels / setActiveModel 两条（C38/C39）——读写桌面
//   统一模型树的全局默认（用户裁决 Q3），仓库不缓存、不落本地状态：每次
//   listModels 都是桌面真源的实时投影，切换结果以服务端回传为准；
// - 响应解析复用 modelCommands.parseModelCommandResult（生成面解析器）；
// - 错误归一化：invokeCommand 统一执行链（gatewayCommand.ts）——GatewayError
//   透传 code/retryable → ModelsCommandError；解析失败/未知异常 → internal；
// - 注入模式：gateway 实例构造注入（测试 mock；生产 = ReconnectingWsClient.gateway，
//   modelsWiring 装配，对齐 filesRepository 先例）。

import { WsGateway } from '@/network/WsGateway';
import { invokeCommand } from './gatewayCommand';
import {
  buildListModelsRequest,
  buildSetActiveModelRequest,
  parseModelCommandResult,
} from '@/domain/repositories/modelCommands';
import type {
  ModelCommandName,
  ModelCommandRequest,
  ModelCommandResultMap,
} from '@/domain/repositories/modelCommands';
import type {
  ListModelsResult,
  SetActiveModelParams,
  SetActiveModelResult,
} from '@crish/shared-types';

// ── 错误类型 ──────────────────────────────────────────────────────────────

/** 模型域命令错误（code = 协议错误码 / 本地映射码，UI 层映射文案） */
export class ModelsCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'ModelsCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常） */
export const MODELS_ERROR_INTERNAL = 'internal';

// ── 仓库接口（注入 mock 面；VM/接线层只依赖接口不依赖实现） ────────────────

export interface ModelsRepository {
  /** C38 可选模型列表 + 当前全局默认（桌面统一模型树实时投影） */
  listModels(): Promise<ListModelsResult>;
  /** C39 切换全局默认模型（持久化桌面同一真源；回传切换后的全局默认） */
  setActiveModel(params: SetActiveModelParams): Promise<SetActiveModelResult>;
}

// ── 网关实现 ──────────────────────────────────────────────────────────────

/** 经 WsGateway.invoke 发送 F6 模型命令并解析响应（注入 gateway，测试可注入假网关） */
export class GatewayModelsRepository implements ModelsRepository {
  constructor(private readonly gateway: WsGateway) {}

  listModels(): Promise<ListModelsResult> {
    return this.invoke('listModels', buildListModelsRequest());
  }

  setActiveModel(params: SetActiveModelParams): Promise<SetActiveModelResult> {
    return this.invoke('setActiveModel', buildSetActiveModelRequest(params));
  }

  /** 统一执行链转发（invokeCommand，gatewayCommand.ts；错误归一化为域错误类） */
  private invoke<T extends ModelCommandName>(
    command: T,
    req: ModelCommandRequest
  ): Promise<ModelCommandResultMap[T]> {
    return invokeCommand(
      this.gateway,
      req,
      command,
      (raw) => parseModelCommandResult(command, raw),
      (code, message, retryable) =>
        new ModelsCommandError(code, message, retryable)
    );
  }
}
