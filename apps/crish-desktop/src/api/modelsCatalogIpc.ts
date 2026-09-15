/** 配置 IPC 只传递完整规范树；解析、修订校验和序列化统一由内核负责。 */
import { invokeTyped, type InvokeTypedResult } from './tauriInvoke';
import type {
  ModelsCatalogSnapshot,
  ModelsYamlTree,
} from './modelsCatalogTypes';

export type IpcResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: 'MISSING' | 'IPC_ERROR' | 'PARSE_ERROR' | 'REVISION_CONFLICT';
      error: string;
      code?: string;
      currentRevision?: string;
    };

export interface ModelsValidationResult {
  valid: boolean;
  message?: string | null;
  line?: number;
  column?: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 核验传输包络，不补字段，也不把有损旧投影装成成功的规范树。 */
function isSnapshot(value: unknown): value is ModelsCatalogSnapshot {
  if (!object(value)) return false;
  if (typeof value.path !== 'string' || !value.path) return false;
  if (typeof value.revision !== 'string' || !value.revision) return false;
  if (typeof value.content !== 'string' || typeof value.template !== 'string')
    return false;
  if (!object(value.credentialStates)) return false;
  if (
    Object.values(value.credentialStates).some(
      (state) => !object(state) || typeof state.hasKey !== 'boolean'
    )
  )
    return false;
  if (
    value.parseError != null &&
    (!object(value.parseError) || typeof value.parseError.message !== 'string')
  )
    return false;
  if (value.tree === null) return value.parseError != null;
  return (
    object(value.tree) &&
    value.tree.version === 2 &&
    object(value.tree.providers) &&
    Object.hasOwn(value.tree, 'activeModel')
  );
}

function failure<T>(
  command: string,
  result: Exclude<InvokeTypedResult<T>, { status: 'ok' }>
): IpcResult<never> {
  if (result.status === 'missing') {
    return { ok: false, kind: 'MISSING', error: command + ' 命令未注册' };
  }
  return {
    ok: false,
    kind:
      result.kind === 'REVISION_CONFLICT' ? 'REVISION_CONFLICT' : 'IPC_ERROR',
    error: result.message,
    code: result.kind,
    ...(result.currentRevision
      ? { currentRevision: result.currentRevision }
      : {}),
  };
}

async function callSnapshot(
  command: string,
  payload: Record<string, unknown>,
  committing = false
): Promise<IpcResult<ModelsCatalogSnapshot>> {
  const result = await invokeTyped<unknown>(command, payload);
  if (result.status !== 'ok') return failure(command, result);
  if (!isSnapshot(result.data)) {
    return {
      ok: false,
      kind: 'IPC_ERROR',
      code: 'CONTRACT_MISMATCH',
      error: '配置回执缺少完整树、修订号或凭据状态',
    };
  }
  if (committing && (result.data.tree === null || result.data.parseError)) {
    return {
      ok: false,
      kind: 'PARSE_ERROR',
      error: result.data.parseError?.message ?? '保存回执不是有效配置',
    };
  }
  return { ok: true, data: result.data };
}

/** 解析错误仍保留原文和诊断供编辑器修复；目录 Store 必须拒绝安装空树。 */
export function readModelsYamlIpc(): Promise<IpcResult<ModelsCatalogSnapshot>> {
  return callSnapshot('workbench_read_models_yaml', {});
}

function revisionFailure(revision: string): IpcResult<never> | null {
  return revision.trim()
    ? null
    : {
        ok: false,
        kind: 'IPC_ERROR',
        code: 'REVISION_REQUIRED',
        error: '配置尚无已读取的修订号，拒绝覆盖文件',
      };
}

/** 表单与活动选择共用结构化提交，不在前端再造 YAML 字段白名单。 */
export async function writeModelsYamlIpc(
  tree: ModelsYamlTree,
  expectedRevision: string
): Promise<IpcResult<ModelsCatalogSnapshot>> {
  const invalid = revisionFailure(expectedRevision);
  if (invalid) return invalid;
  return callSnapshot(
    'workbench_apply_models_config',
    { tree, expectedRevision },
    true
  );
}

/** 高级编辑器提交原文，但仍经过同一个内核事务及修订校验。 */
export async function saveModelsYamlTextIpc(
  content: string,
  expectedRevision: string
): Promise<IpcResult<ModelsCatalogSnapshot>> {
  const invalid = revisionFailure(expectedRevision);
  if (invalid) return invalid;
  // fail-closed 前置校验（2026-09-15 接线）：非法 yaml 就地拦下，不交给内核写盘。
  // 接线前 `validateModelsYamlIpc` **有封装无调用方**，被 command-contract-drift
  // 断言二报为「注册未消费」的幽灵命令；校验面本就该在写盘前生效。
  const validated = await validateModelsYamlIpc(content);
  if (!validated.ok) return validated;
  if (!validated.data.valid) {
    return {
      ok: false,
      kind: 'PARSE_ERROR',
      error: validated.data.message ?? '配置校验未通过',
    };
  }
  return callSnapshot(
    'workbench_save_models_yaml',
    { content, expectedRevision },
    true
  );
}

export async function validateModelsYamlIpc(
  content: string
): Promise<IpcResult<ModelsValidationResult>> {
  // 命令名内联字面量（不落变量）：command-contract-drift 的「零幽灵」断言按
  // `invoke('X'` 形态扫描，命令名经小写变量传递会被判为「注册未消费」。
  const result = await invokeTyped<ModelsValidationResult>(
    'workbench_validate_models_yaml',
    { content }
  );
  if (result.status !== 'ok') {
    return failure('workbench_validate_models_yaml', result);
  }
  if (!object(result.data) || typeof result.data.valid !== 'boolean') {
    return {
      ok: false,
      kind: 'IPC_ERROR',
      code: 'CONTRACT_MISMATCH',
      error: '配置校验回执格式无效',
    };
  }
  return { ok: true, data: result.data };
}
