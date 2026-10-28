// 文件域命令仓库（R2-06b 接线层 · R4 批次6 执行链下沉）：WsGateway.invoke → filesCommands 构造/解析
//
// 职责（对齐 M5 §1.2 repository 组合纪律：仓库 = 命令构造 + 网络发送 + 响应解析）：
// - 命令发送唯一入口：listDir / readFile / listWorkspaces / switchWorkspace 四条
//   （F4 附录 A 命令映射总表；写命令/搜索/资产/元数据属后续轮次，不在此展开）；
// - 响应解析复用 filesCommands.parseFileCommandResult（生成面解析器，M5 §1.3
//   组合纪律：不手写第二套字段校验）；
// - 错误归一化：invokeCommand 统一执行链（gatewayCommand.ts）——GatewayError 透传
//   code/retryable → FilesCommandError；解析失败/未知异常 → internal
//   （F4 附录 B 映射面在 UI 层）；
// - 注入模式：gateway 实例构造注入（测试 mock；生产 = ReconnectingWsClient.gateway，
//   observationWiring 装配，对齐 FeedBridge 先例 feedBridge.ts:40-47）。

import { WsGateway } from '@/network/WsGateway';
import { invokeCommand } from './gatewayCommand';
import {
  buildListDirRequest,
  buildReadFileRequest,
  buildListWorkspacesRequest,
  buildSwitchWorkspaceRequest,
  parseFileCommandResult,
} from '@/domain/repositories/filesCommands';
import type {
  FileCommandName,
  FileCommandRequest,
  FileCommandResultMap,
} from '@/domain/repositories/filesCommands';
import type {
  ListDirParams,
  ListDirResult,
  ReadFileParams,
  ReadFileResult,
  ListWorkspacesResult,
  SwitchWorkspaceParams,
  SwitchWorkspaceResult,
} from '@crish/shared-types';

// ── 错误类型 ──────────────────────────────────────────────────────────────

/** 文件域命令错误（code = 协议错误码 / 本地映射码，F4 附录 B UI 层映射文案） */
export class FilesCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'FilesCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 未知错误兜底码（解析失败 / 非 GatewayError 异常） */
export const FILES_ERROR_INTERNAL = 'internal';

// ── 仓库接口（注入 mock 面；VM/接线层只依赖接口不依赖实现） ────────────────

export interface FilesRepository {
  /** C16 目录列表（path 空串 = 工作区根；workspaceRoot 缺省 = 当前活动根） */
  listDir(params: ListDirParams): Promise<ListDirResult>;
  /** C17 分块读文件（maxLines 默认 400 硬顶 5000，F4 §4.1） */
  readFile(params: ReadFileParams): Promise<ReadFileResult>;
  /** C19 工作区列表（已授权根 + 活动标记，F4-F01） */
  listWorkspaces(): Promise<ListWorkspacesResult>;
  /** C20 切换活动根（recent 列表内复授权校验，F4-F02） */
  switchWorkspace(
    params: SwitchWorkspaceParams
  ): Promise<SwitchWorkspaceResult>;
}

// ── 网关实现 ──────────────────────────────────────────────────────────────

/** 经 WsGateway.invoke 发送 F4 命令并解析响应（注入 gateway，测试可注入假网关） */
export class GatewayFilesRepository implements FilesRepository {
  constructor(private readonly gateway: WsGateway) {}

  listDir(params: ListDirParams): Promise<ListDirResult> {
    return this.invoke('listDir', buildListDirRequest(params));
  }

  readFile(params: ReadFileParams): Promise<ReadFileResult> {
    return this.invoke('readFile', buildReadFileRequest(params));
  }

  listWorkspaces(): Promise<ListWorkspacesResult> {
    return this.invoke('listWorkspaces', buildListWorkspacesRequest());
  }

  switchWorkspace(
    params: SwitchWorkspaceParams
  ): Promise<SwitchWorkspaceResult> {
    return this.invoke('switchWorkspace', buildSwitchWorkspaceRequest(params));
  }

  /** 统一执行链转发（invokeCommand，gatewayCommand.ts；错误归一化为域错误类） */
  private invoke<T extends FileCommandName>(
    command: T,
    req: FileCommandRequest
  ): Promise<FileCommandResultMap[T]> {
    return invokeCommand(
      this.gateway,
      req,
      command,
      (raw) => parseFileCommandResult(command, raw),
      (code, message, retryable) =>
        new FilesCommandError(code, message, retryable)
    );
  }
}
