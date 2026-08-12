// F4 文件域命令构造与响应解析（R2-06 数据层纯逻辑，文件域文件浏览数据面）
//
// 对齐依据：
// - 字段真源：crates/conex-types/contracts/device-protocol.json（C16-C23 参数/响应
//   类型 + commands 段 name/kind/paramsType/resultType；M6 §4.3 逐条展开）；
// - 命令信封：remote.* 消息体 = CommandRequest {command, params, timeoutMs?}
//   （M6 §3.1 / 生成解析器 parseCommandRequest，parser.ts:422-435），kind 与
//   body.command 后缀必须一致（生成解析器校验，drift.test.ts:161-175）；
// - 响应解析：复用生成解析器（parseListDirResult 等，parser.ts:1397-1638）——
//   不手写第二套字段校验（M5 §1.3 组合纪律：响应类型从 @crish/shared-types
//   生成包引用，不手抄字段）；本文件只做「命令名 → 解析器」的分发与类型收口；
// - 只读纪律：本轮只构造命令体不发送（WsGateway.invoke 接线在后续轮次）；
//   路径校验（F4 §7.2 resolveWorkspacePath 同构）属 SDK 层，见未覆盖项。

import type {
  ListDirParams,
  ListDirResult,
  ReadFileParams,
  ReadFileResult,
  WriteFileParams,
  WriteFileResult,
  ListWorkspacesResult,
  SwitchWorkspaceParams,
  SwitchWorkspaceResult,
  SearchFilesParams,
  SearchFilesResult,
  AssetUrlParams,
  AssetUrlResult,
  FileStatParams,
  FileStatResult,
  CommandRequest,
} from '../../../../../packages/shared-types/src/generated/device/types';
import {
  parseListDirResult as parseWireListDirResult,
  parseReadFileResult as parseWireReadFileResult,
  parseWriteFileResult as parseWireWriteFileResult,
  parseListWorkspacesResult as parseWireListWorkspacesResult,
  parseSwitchWorkspaceResult as parseWireSwitchWorkspaceResult,
  parseSearchFilesResult as parseWireSearchFilesResult,
  parseAssetUrlResult as parseWireAssetUrlResult,
  parseFileStatResult as parseWireFileStatResult,
} from '../../../../../packages/shared-types/src/generated/device/parser';
import type { ParseResult } from '../../../../../packages/shared-types/src/generated/device/parser';

// ── 命令标识（注册表 commands 段 name；kind = remote.<name>）────────────────

/** F4 域 8 条命令名（C16-C23，M6 §4.3.0 总表） */
export type FileCommandName =
  | 'listDir'
  | 'readFile'
  | 'writeFile'
  | 'listWorkspaces'
  | 'switchWorkspace'
  | 'searchFiles'
  | 'assetUrl'
  | 'fileStat';

/** F4 域 8 条命令 kind（协议层消息类别，M6 §3.1） */
export type FileCommandKind =
  | 'remote.listDir'
  | 'remote.readFile'
  | 'remote.writeFile'
  | 'remote.listWorkspaces'
  | 'remote.switchWorkspace'
  | 'remote.searchFiles'
  | 'remote.assetUrl'
  | 'remote.fileStat';

/** 命令名 → kind（注册表锁定的双射；kind 前缀固定 remote.，M6 §4.0） */
export const FILE_COMMAND_KIND: Record<FileCommandName, FileCommandKind> = {
  listDir: 'remote.listDir',
  readFile: 'remote.readFile',
  writeFile: 'remote.writeFile',
  listWorkspaces: 'remote.listWorkspaces',
  switchWorkspace: 'remote.switchWorkspace',
  searchFiles: 'remote.searchFiles',
  assetUrl: 'remote.assetUrl',
  fileStat: 'remote.fileStat',
};

/** 命令请求产物：kind（WsGateway.invoke 第一参）+ CommandRequest 信封体 */
export interface FileCommandRequest {
  kind: FileCommandKind;
  body: CommandRequest;
}

// ── 命令构造（纯函数；参数类型 = 生成契约 paramsType）───────────────────────
// 注：params 以展开字面量 { ...params } 传给 CommandRequest.params（JsonValue）——
// 生成接口类型无隐式索引签名，展开后为对象字面量类型可赋给索引签名面（TS2322 规避）。

/** C16 目录列表：path 缺省/空串 = 工作区根；workspaceRoot 缺省 = 当前活动根 */
export function buildListDirRequest(params: ListDirParams): FileCommandRequest {
  return {
    kind: 'remote.listDir',
    body: { command: 'listDir', params: { ...params } },
  };
}

/** C17 分块读文件：maxLines 默认 400 硬顶 5000；startLine 默认 0 */
export function buildReadFileRequest(
  params: ReadFileParams
): FileCommandRequest {
  return {
    kind: 'remote.readFile',
    body: { command: 'readFile', params: { ...params } },
  };
}

/** C18 受控写文件：overwrite 默认 false（file_exists 语义，F4 §2.4） */
export function buildWriteFileRequest(
  params: WriteFileParams
): FileCommandRequest {
  return {
    kind: 'remote.writeFile',
    body: { command: 'writeFile', params: { ...params } },
  };
}

/** C19 工作区列表：参数恒空对象 */
export function buildListWorkspacesRequest(): FileCommandRequest {
  return {
    kind: 'remote.listWorkspaces',
    body: { command: 'listWorkspaces', params: {} },
  };
}

/** C20 切换活动根：path = 已授权根绝对路径（recent 列表内才放行，F4 §2.1） */
export function buildSwitchWorkspaceRequest(
  params: SwitchWorkspaceParams
): FileCommandRequest {
  return {
    kind: 'remote.switchWorkspace',
    body: { command: 'switchWorkspace', params: { ...params } },
  };
}

/** C21 递归文件名搜索：maxResults 默认 100 上限 100（桌面钳制，F4 §5.5） */
export function buildSearchFilesRequest(
  params: SearchFilesParams
): FileCommandRequest {
  return {
    kind: 'remote.searchFiles',
    body: { command: 'searchFiles', params: { ...params } },
  };
}

/** C22 资源 URL：kind ∈ image/pdf/thumbnail（令牌 10 分钟，F4 §5.4） */
export function buildAssetUrlRequest(
  params: AssetUrlParams
): FileCommandRequest {
  return {
    kind: 'remote.assetUrl',
    body: { command: 'assetUrl', params: { ...params } },
  };
}

/** C23 文件元数据：size/modified/readonly/kind（file_stat 工具代理） */
export function buildFileStatRequest(
  params: FileStatParams
): FileCommandRequest {
  return {
    kind: 'remote.fileStat',
    body: { command: 'fileStat', params: { ...params } },
  };
}

// ── 响应解析（分发到生成解析器；响应类型 = 生成契约 resultType）─────────────

/** F4 域 8 条命令响应载荷联合（生成 resultType 全集） */
export type FileCommandResultPayload =
  | ListDirResult
  | ReadFileResult
  | WriteFileResult
  | ListWorkspacesResult
  | SwitchWorkspaceResult
  | SearchFilesResult
  | AssetUrlResult
  | FileStatResult;

/** 命令名 → 响应载荷类型映射（生成 resultType，M6 §4.3 总表） */
export interface FileCommandResultMap {
  listDir: ListDirResult;
  readFile: ReadFileResult;
  writeFile: WriteFileResult;
  listWorkspaces: ListWorkspacesResult;
  switchWorkspace: SwitchWorkspaceResult;
  searchFiles: SearchFilesResult;
  assetUrl: AssetUrlResult;
  fileStat: FileStatResult;
}

/**
 * 按命令名分发响应解析（输入 = CommandResult 信封的 result 载荷，M6 §6.1；
 * WsGateway.invoke 已解信封并校验 CommandResult 骨架，此处校验 result 内容）。
 * 解析器全部来自生成面（parser.ts），必填字段缺省/类型错 → 拒绝。
 */
export function parseFileCommandResult<T extends FileCommandName>(
  command: T,
  raw: unknown
): ParseResult<FileCommandResultMap[T]> {
  const result = parseAnyFileCommandResult(command, raw);
  return result as ParseResult<FileCommandResultMap[T]>;
}

function parseAnyFileCommandResult(
  command: FileCommandName,
  raw: unknown
): ParseResult<FileCommandResultPayload> {
  switch (command) {
    case 'listDir':
      return parseWireListDirResult(raw);
    case 'readFile':
      return parseWireReadFileResult(raw);
    case 'writeFile':
      return parseWireWriteFileResult(raw);
    case 'listWorkspaces':
      return parseWireListWorkspacesResult(raw);
    case 'switchWorkspace':
      return parseWireSwitchWorkspaceResult(raw);
    case 'searchFiles':
      return parseWireSearchFilesResult(raw);
    case 'assetUrl':
      return parseWireAssetUrlResult(raw);
    case 'fileStat':
      return parseWireFileStatResult(raw);
  }
}
