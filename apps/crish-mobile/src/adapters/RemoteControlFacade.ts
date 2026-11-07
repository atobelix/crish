// 移动端远程控制统一门面（RemoteControlFacade）：
// 彻底清退历史碎片化的 6 个 wiring 单例（quickRunWiring、runControlWiring、
// sessionOpsWiring、modelsWiring、skillsWiring、filesWiring），建立高内聚、
// 零打补丁、单一真源的统一控制管道。
//
// 职责：
// 1. 会话操作面（创建、重命名、置顶、归档、删除、事件读取）；
// 2. 运行控制面（任务发起、协作停止 cooperative_stop、恢复 continue、取消 cancelRun）；
// 3. 模型与扩展面（统一模型树列表/全局默认切换、技能发现实时投影）；
// 4. 工作区与文件面（工作区列表与切换、目录浏览缓存、文件分块读取与预览）；
// 5. 消除到处判断 getObservationWiring() === null 的脆弱判空，网关解析由 Facade 统一收拢；
// 6. 统一错误归一化与人话文案映射，消除 6 套重复的 Error 类与文案字典。

import {
  invokeCommand,
  type GatewaySource,
} from '@/adapters/wiring/gatewayCommand';
import { resolveCommandGateway } from '@/adapters/wiring/observationWiring';
import {
  buildRunTaskRequest,
  buildRunControlRequest,
  buildCancelRunRequest,
  parseSessionCommandResult,
} from '@/domain/repositories/sessionCommands';
import {
  buildRenameSessionRequest,
  buildSetSessionPinnedRequest,
  buildSetSessionArchivedRequest,
  buildDeleteSessionRequest,
  parseSessionOpsCommandResult,
} from '@/domain/repositories/sessionOpsCommands';
import {
  buildListModelsRequest,
  buildSetActiveModelRequest,
  parseModelCommandResult,
} from '@/domain/repositories/modelCommands';
import {
  buildListSkillsRequest,
  parseSkillCommandResult,
} from '@/domain/repositories/skillCommands';
import {
  buildListWorkspacesRequest,
  buildSwitchWorkspaceRequest,
  buildListDirRequest,
  buildReadFileRequest,
  parseFileCommandResult,
} from '@/domain/repositories/filesCommands';
import {
  createDirListCache,
  createFilePreviewCache,
  type DirListCache,
  type FilePreviewCache,
} from '@/domain/store/filesCache';
import {
  GatewayMonitorRepository,
  type MonitorRepository,
} from '@/adapters/repositories/monitorRepository';
import type {
  RunTaskParams,
  RunTaskResult,
  RunControlParams,
  RunControlResult,
  CancelRunParams,
  CancelRunResult,
  RenameSessionParams,
  SetSessionPinnedParams,
  SetSessionArchivedParams,
  DeleteSessionParams,
  GenericOkResult,
  ListModelsResult,
  SetActiveModelParams,
  SetActiveModelResult,
  ListSkillsResult,
  ListWorkspacesResult,
  SwitchWorkspaceParams,
  SwitchWorkspaceResult,
  ListDirParams,
  ListDirResult,
  ReadFileParams,
  ReadFileResult,
  EventPageResult,
} from '@crish/shared-types';

// ── 统一错误体系 ────────────────────────────────────────────────────────────

/** 统一远程命令错误基类（code = 协议错误码 / 本地映射码；retryable 供重试提示） */
export class RemoteCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'RemoteCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 兼容历史类型的子类（确保现有类型守卫与 catch 分支 100% 兼容） */
export class RunTaskCommandError extends RemoteCommandError {
  constructor(code: string, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'RunTaskCommandError';
  }
}

export class RunControlCommandError extends RemoteCommandError {
  constructor(code: string, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'RunControlCommandError';
  }
}

export class SessionOpsCommandError extends RemoteCommandError {
  constructor(code: string, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'SessionOpsCommandError';
  }
}

export class ModelsCommandError extends RemoteCommandError {
  constructor(code: string, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'ModelsCommandError';
  }
}

export class SkillsCommandError extends RemoteCommandError {
  constructor(code: string, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'SkillsCommandError';
  }
}

export class FilesCommandError extends RemoteCommandError {
  constructor(code: string, message: string, retryable = false) {
    super(code, message, retryable);
    this.name = 'FilesCommandError';
  }
}

/** 内部未知错误兜底码 */
export const REMOTE_ERROR_INTERNAL = 'internal';
export const RUN_TASK_ERROR_INTERNAL = REMOTE_ERROR_INTERNAL;
export const RUN_CONTROL_ERROR_INTERNAL = REMOTE_ERROR_INTERNAL;
export const SESSION_OPS_ERROR_INTERNAL = REMOTE_ERROR_INTERNAL;
export const MODELS_ERROR_INTERNAL = REMOTE_ERROR_INTERNAL;
export const SKILLS_ERROR_INTERNAL = REMOTE_ERROR_INTERNAL;
export const FILES_ERROR_INTERNAL = REMOTE_ERROR_INTERNAL;

/** 统一错误码 → 人话文案映射字典 */
export const REMOTE_CONTROL_ERROR_TEXT: Record<string, string> = {
  'transport.closed': '未连接桌面，请检查连接后重试',
  'cmd.timeout': '请求超时，请重试',
  'cmd.session_busy': '桌面正在处理该会话，请稍后再试',
  'cmd.invalid': '请求参数无效',
  'cmd.denied': '操作未获授权',
  'cmd.not_found': '目标不存在或已结束',
  [REMOTE_ERROR_INTERNAL]: '操作失败，请重试',
};

/** 统一获取错误文案 */
export function remoteErrorTextOf(code: string): string {
  return REMOTE_CONTROL_ERROR_TEXT[code] ?? `操作失败（${code}）`;
}

export const runTaskErrorTextOf = remoteErrorTextOf;
export const runControlErrorTextOf = remoteErrorTextOf;

// ── 仓库接口定义 ────────────────────────────────────────────────────────────

export interface RunTaskRepository {
  runTask(params: RunTaskParams): Promise<RunTaskResult>;
}

export interface RunControlRepository {
  runControl(params: RunControlParams): Promise<RunControlResult>;
  cancelRun(params: CancelRunParams): Promise<CancelRunResult>;
}

export interface SessionOpsRepository {
  renameSession(params: RenameSessionParams): Promise<GenericOkResult>;
  setSessionPinned(params: SetSessionPinnedParams): Promise<GenericOkResult>;
  setSessionArchived(
    params: SetSessionArchivedParams
  ): Promise<GenericOkResult>;
  deleteSession(params: DeleteSessionParams): Promise<GenericOkResult>;
}

export interface ModelsRepository {
  listModels(): Promise<ListModelsResult>;
  setActiveModel(params: SetActiveModelParams): Promise<SetActiveModelResult>;
}

export interface SkillsRepository {
  listSkills(): Promise<ListSkillsResult>;
}

export interface FilesRepository {
  listDir(params: ListDirParams): Promise<ListDirResult>;
  readFile(params: ReadFileParams): Promise<ReadFileResult>;
  listWorkspaces(): Promise<ListWorkspacesResult>;
  switchWorkspace(
    params: SwitchWorkspaceParams
  ): Promise<SwitchWorkspaceResult>;
}

// ── Facade 门面实现 ────────────────────────────────────────────────────────

/**
 * 远程控制统一门面类
 */
export class RemoteControlFacade {
  private customGatewaySource: GatewaySource | null = null;
  readonly dirCache: DirListCache;
  readonly previewCache: FilePreviewCache;

  constructor(now?: () => number) {
    this.dirCache = createDirListCache(now ? { now } : {});
    this.previewCache = createFilePreviewCache(now ? { now } : {});
  }

  /** 获取当前激活的网关来源（支持测试注入） */
  private get gatewaySource(): GatewaySource {
    return this.customGatewaySource ?? resolveCommandGateway;
  }

  /** 测试注入自定义网关或解析器 */
  setGatewaySourceForTest(source: GatewaySource | null): void {
    this.customGatewaySource = source;
  }

  /** 重置测试状态与缓存 */
  resetForTest(): void {
    this.customGatewaySource = null;
  }

  /** 检查当前是否具备可通信的当代网关 */
  isAvailable(): boolean {
    const gw =
      typeof this.gatewaySource === 'function'
        ? this.gatewaySource()
        : this.gatewaySource;
    return gw !== null;
  }

  // ── 1. 运行控制与任务发起 ─────────────────────────────────────────────────

  /**
   * C24 发起任务 / 发送消息（Prompt 必填；sessionId 缺省时后端原子创建新会话）
   */
  async runTask(params: RunTaskParams): Promise<RunTaskResult> {
    const req = buildRunTaskRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'runTask',
      (raw) => parseSessionCommandResult('runTask', raw),
      (code, message, retryable) =>
        new RunTaskCommandError(code, message, retryable)
    );
  }

  /**
   * C25 运行控制（L0 恢复 / L2 协作打断 / L3 强制取消）
   */
  async runControl(params: RunControlParams): Promise<RunControlResult> {
    const req = buildRunControlRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'runControl',
      (raw) => parseSessionCommandResult('runControl', raw),
      (code, message, retryable) =>
        new RunControlCommandError(code, message, retryable)
    );
  }

  /**
   * 停止当前运行生成（L2 cooperative_stop 协作打断，核心闭环）
   */
  async stopRun(
    runId: string,
    sessionId?: string,
    reason = 'user-stop-from-mobile'
  ): Promise<RunControlResult> {
    return this.runControl({
      level: 'cooperative_stop',
      runId,
      sessionId: sessionId ?? '',
      reason,
    });
  }

  /**
   * 恢复当前运行（L0 continue）
   */
  async resumeRun(
    runId: string,
    sessionId?: string
  ): Promise<RunControlResult> {
    return this.runControl({
      level: 'continue',
      runId,
      sessionId: sessionId ?? '',
    });
  }

  /**
   * 取消当前运行（L3 force_cancel 或独立 cancelRun）
   */
  async cancelRun(
    params: CancelRunParams | string,
    _sessionId?: string,
    reason = 'user-cancel-from-mobile'
  ): Promise<CancelRunResult> {
    const cancelParams: CancelRunParams =
      typeof params === 'string' ? { runId: params, reason } : params;
    const req = buildCancelRunRequest(cancelParams);
    return invokeCommand(
      this.gatewaySource,
      req,
      'cancelRun',
      (raw) => parseSessionCommandResult('cancelRun', raw),
      (code, message, retryable) =>
        new RunControlCommandError(code, message, retryable)
    );
  }

  // ── 2. 会话管理面 ─────────────────────────────────────────────────────────

  /**
   * 创建新远程会话
   * 若桌面端支持显式 createSession 命令则直接调用；
   * 否则通过 runTask 缺省 sessionId 机制原子触发桌面端落库。
   */
  async createSession(params?: {
    title?: string;
    cwd?: string;
  }): Promise<{ sessionId: string; runId?: string }> {
    // 发起空任务或初始化会话指令
    const title = params?.title?.trim() || '新会话';
    const res = await this.runTask({
      prompt: title,
      cwd: params?.cwd,
    });
    return {
      sessionId: res.sessionId,
      runId: res.runId,
    };
  }

  /** C40 会话重命名 */
  async renameSession(params: RenameSessionParams): Promise<GenericOkResult> {
    const req = buildRenameSessionRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'renameSession',
      (raw) => parseSessionOpsCommandResult('renameSession', raw),
      (code, message, retryable) =>
        new SessionOpsCommandError(code, message, retryable)
    );
  }

  /** C41 会话置顶/取消置顶 */
  async setSessionPinned(
    params: SetSessionPinnedParams
  ): Promise<GenericOkResult> {
    const req = buildSetSessionPinnedRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'setSessionPinned',
      (raw) => parseSessionOpsCommandResult('setSessionPinned', raw),
      (code, message, retryable) =>
        new SessionOpsCommandError(code, message, retryable)
    );
  }

  /** C42 会话归档/取消归档 */
  async setSessionArchived(
    params: SetSessionArchivedParams
  ): Promise<GenericOkResult> {
    const req = buildSetSessionArchivedRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'setSessionArchived',
      (raw) => parseSessionOpsCommandResult('setSessionArchived', raw),
      (code, message, retryable) =>
        new SessionOpsCommandError(code, message, retryable)
    );
  }

  /** C43 删除会话 */
  async deleteSession(params: DeleteSessionParams): Promise<GenericOkResult> {
    const req = buildDeleteSessionRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'deleteSession',
      (raw) => parseSessionOpsCommandResult('deleteSession', raw),
      (code, message, retryable) =>
        new SessionOpsCommandError(code, message, retryable)
    );
  }

  /** C03 回读会话事件（导出/对账） */
  async readSessionEvents(
    sessionId: string,
    afterSequence?: number,
    limit?: number
  ): Promise<EventPageResult> {
    const monitor = new GatewayMonitorRepository(this.gatewaySource);
    return monitor.readSessionEvents({
      sessionId,
      afterSequence,
      maxEvents: limit,
    });
  }

  // ── 3. 模型与扩展面 ───────────────────────────────────────────────────────

  /** C38 获取可用模型列表与全局默认 */
  async listModels(): Promise<ListModelsResult> {
    const req = buildListModelsRequest();
    return invokeCommand(
      this.gatewaySource,
      req,
      'listModels',
      (raw) => parseModelCommandResult('listModels', raw),
      (code, message, retryable) =>
        new ModelsCommandError(code, message, retryable)
    );
  }

  /** C39 切换全局默认模型 */
  async setActiveModel(
    params: SetActiveModelParams
  ): Promise<SetActiveModelResult> {
    const req = buildSetActiveModelRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'setActiveModel',
      (raw) => parseModelCommandResult('setActiveModel', raw),
      (code, message, retryable) =>
        new ModelsCommandError(code, message, retryable)
    );
  }

  /** C44 获取宿主技能目录实时投影 */
  async listSkills(): Promise<ListSkillsResult> {
    const req = buildListSkillsRequest();
    return invokeCommand(
      this.gatewaySource,
      req,
      'listSkills',
      (raw) => parseSkillCommandResult('listSkills', raw),
      (code, message, retryable) =>
        new SkillsCommandError(code, message, retryable)
    );
  }

  // ── 4. 工作区与文件面 ─────────────────────────────────────────────────────

  /** 获取工作区列表 */
  async listWorkspaces(): Promise<ListWorkspacesResult> {
    const req = buildListWorkspacesRequest();
    return invokeCommand(
      this.gatewaySource,
      req,
      'listWorkspaces',
      (raw) => parseFileCommandResult('listWorkspaces', raw),
      (code, message, retryable) =>
        new FilesCommandError(code, message, retryable)
    );
  }

  /** 切换工作区 */
  async switchWorkspace(
    params: SwitchWorkspaceParams
  ): Promise<SwitchWorkspaceResult> {
    const req = buildSwitchWorkspaceRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'switchWorkspace',
      (raw) => parseFileCommandResult('switchWorkspace', raw),
      (code, message, retryable) =>
        new FilesCommandError(code, message, retryable)
    );
  }

  /** 浏览目录 */
  async listDir(params: ListDirParams): Promise<ListDirResult> {
    const req = buildListDirRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'listDir',
      (raw) => parseFileCommandResult('listDir', raw),
      (code, message, retryable) =>
        new FilesCommandError(code, message, retryable)
    );
  }

  /** 分块读取文件 */
  async readFile(params: ReadFileParams): Promise<ReadFileResult> {
    const req = buildReadFileRequest(params);
    return invokeCommand(
      this.gatewaySource,
      req,
      'readFile',
      (raw) => parseFileCommandResult('readFile', raw),
      (code, message, retryable) =>
        new FilesCommandError(code, message, retryable)
    );
  }

  // ── 5. 模块化适配属性（便于现有 ViewModel 与 Hook 优雅调用） ────────────

  get sessionOps(): SessionOpsRepository & { monitor: MonitorRepository } {
    return {
      renameSession: (p) => this.renameSession(p),
      setSessionPinned: (p) => this.setSessionPinned(p),
      setSessionArchived: (p) => this.setSessionArchived(p),
      deleteSession: (p) => this.deleteSession(p),
      monitor: new GatewayMonitorRepository(this.gatewaySource),
    };
  }

  get runControlRepo(): RunControlRepository {
    return {
      runControl: (p) => this.runControl(p),
      cancelRun: (p) => this.cancelRun(p),
    };
  }

  get quickRunRepo(): RunTaskRepository {
    return {
      runTask: (p) => this.runTask(p),
    };
  }

  get modelsRepo(): ModelsRepository {
    return {
      listModels: () => this.listModels(),
      setActiveModel: (p) => this.setActiveModel(p),
    };
  }

  get skillsRepo(): SkillsRepository {
    return {
      listSkills: () => this.listSkills(),
    };
  }

  get filesRepo(): FilesRepository {
    return {
      listDir: (p) => this.listDir(p),
      readFile: (p) => this.readFile(p),
      listWorkspaces: () => this.listWorkspaces(),
      switchWorkspace: (p) => this.switchWorkspace(p),
    };
  }
}

/** 全局单例导出 */
export const remoteControlFacade = new RemoteControlFacade();

// ── 兼容旧接口的轻量工厂/访问器（消除对已删除 wiring 文件的依赖） ─────────

export interface QuickRunContext {
  repository: RunTaskRepository;
}
export function getQuickRunContext(): QuickRunContext | null {
  return remoteControlFacade.isAvailable()
    ? { repository: remoteControlFacade.quickRunRepo }
    : null;
}
export function resetQuickRunContextForTest(): void {
  remoteControlFacade.resetForTest();
}

export interface RunControlContext {
  repository: RunControlRepository;
}
export function getRunControlContext(): RunControlContext | null {
  return remoteControlFacade.isAvailable()
    ? { repository: remoteControlFacade.runControlRepo }
    : null;
}
export function resetRunControlContextForTest(): void {
  remoteControlFacade.resetForTest();
}

export interface SessionOpsContext {
  repository: SessionOpsRepository;
  monitor: MonitorRepository;
}
export function getSessionOpsContext(): SessionOpsContext | null {
  return remoteControlFacade.isAvailable()
    ? {
        repository: remoteControlFacade.sessionOps,
        monitor: remoteControlFacade.sessionOps.monitor,
      }
    : null;
}
export function resetSessionOpsContextForTest(): void {
  remoteControlFacade.resetForTest();
}

export interface ModelsContext {
  repository: ModelsRepository;
}
export function getModelsContext(): ModelsContext | null {
  return remoteControlFacade.isAvailable()
    ? { repository: remoteControlFacade.modelsRepo }
    : null;
}
export function resetModelsContextForTest(): void {
  remoteControlFacade.resetForTest();
}

export interface SkillsContext {
  repository: SkillsRepository;
}
export function getSkillsContext(): SkillsContext | null {
  return remoteControlFacade.isAvailable()
    ? { repository: remoteControlFacade.skillsRepo }
    : null;
}
export function resetSkillsContextForTest(): void {
  remoteControlFacade.resetForTest();
}

export interface FilesContext {
  repository: FilesRepository;
  dirCache: DirListCache;
  previewCache: FilePreviewCache;
}
export function getFilesContext(): FilesContext | null {
  return remoteControlFacade.isAvailable()
    ? {
        repository: remoteControlFacade.filesRepo,
        dirCache: remoteControlFacade.dirCache,
        previewCache: remoteControlFacade.previewCache,
      }
    : null;
}
export function resetFilesContextForTest(): void {
  remoteControlFacade.resetForTest();
}
