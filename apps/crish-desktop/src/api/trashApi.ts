/**
 * 误删恢复面板数据源（I3-S9 任务 3；引擎命令面 I2-S5 已交付）。
 *
 * Tauri 命令（apps/agent-workbench core_run_commands.rs）：
 * - `trash_list`：条目清单（路径 / 删除时间 / 类型 / 大小 / 校验和）+ 回收站根；
 * - `trash_restore <entry_id> [session_id]`：恢复到原路径（校验 checksum 防篡改，
 *   原路径已存在拒绝覆盖），恢复动作落 security-audit（decision=restored）；
 * - `trash_purge <entry_id> [session_id]`：彻底清除（不可恢复），动作落审计
 *   （decision=purged）。
 *
 * 容错：非 Tauri 环境 / 命令缺失（missing）→ 空列表 / 结构化失败（组件降级
 * 为空态或 toast），不抛未分类错误。
 */
import { invokeTyped } from './tauriInvoke';

/** 回收站条目（对齐 conex_fs::trash::TrashEntry serde camelCase） */
export interface TrashEntryDto {
  /** 条目唯一 id（trash 根内条目子目录名） */
  id: string;
  /** 原始绝对路径（恢复目标） */
  originalPath: string;
  /** 入回收站时间（纪元毫秒） */
  trashedAt: number;
  /** 条目类型 */
  kind: 'file' | 'dir';
  /** 总大小（文件为字节数，目录为递归求和） */
  size: number;
  /** 文件 SHA-256 校验和（backup=true 时写入；目录恒缺省） */
  checksum?: string | null;
  /** 条目模式：trash=移入回收站；snapshot=复制快照（写前备份） */
  mode?: 'trash' | 'snapshot';
}

/** trash_list 返回（条目清单 + 回收站根；无条目 entries 为空数组） */
export interface TrashListDto {
  entries: TrashEntryDto[];
  trashRoot: string;
}

/** trash_restore 返回（恢复成功的目标路径） */
export interface TrashRestoreDto {
  ok: boolean;
  originalPath: string;
}

/** trash_purge 返回（已彻底清除的条目 id） */
export interface TrashPurgeDto {
  ok: boolean;
  entryId: string;
}

/** 动作失败结果（结构化；组件据此 toast 与刷新策略） */
export interface TrashActionFailure {
  ok: false;
  /** 失败原因（人类可读；missing → 命令不可用） */
  message: string;
}

export type TrashActionResult<T> = { ok: true; data: T } | TrashActionFailure;

function failureOf(
  message: string,
  kind: string,
  fallback: string
): TrashActionFailure {
  return {
    ok: false,
    message:
      kind === 'NotFound'
        ? `未找到条目：${message}`
        : `${fallback}：${message}`,
  };
}

/** 列出回收站条目；命令缺失 / 非 Tauri 环境 → 空列表（面板空态） */
export async function listTrashEntries(): Promise<TrashListDto> {
  const res = await invokeTyped<TrashListDto>('trash_list');
  if (res.status === 'ok') return res.data;
  return { entries: [], trashRoot: '' };
}

/** 恢复到原路径（校验 checksum 防篡改；原路径已存在拒绝覆盖） */
export async function restoreTrashEntry(
  entryId: string,
  sessionId?: string
): Promise<TrashActionResult<TrashRestoreDto>> {
  const res = await invokeTyped<TrashRestoreDto>('trash_restore', {
    entryId,
    ...(sessionId ? { sessionId } : {}),
  });
  if (res.status === 'ok') return { ok: true, data: res.data };
  if (res.status === 'missing') {
    return { ok: false, message: '回收站命令不可用（trash_restore 未注册）' };
  }
  return {
    ok: false,
    message: failureOf(res.message, res.kind, '恢复失败').message,
  };
}

/** 彻底清除条目（不可恢复；动作本身是显式用户调用） */
export async function purgeTrashEntry(
  entryId: string,
  sessionId?: string
): Promise<TrashActionResult<TrashPurgeDto>> {
  const res = await invokeTyped<TrashPurgeDto>('trash_purge', {
    entryId,
    ...(sessionId ? { sessionId } : {}),
  });
  if (res.status === 'ok') return { ok: true, data: res.data };
  if (res.status === 'missing') {
    return { ok: false, message: '回收站命令不可用（trash_purge 未注册）' };
  }
  return {
    ok: false,
    message: failureOf(res.message, res.kind, '清除失败').message,
  };
}

/** 删除时间可读化（本地时区 MM-DD HH:mm） */
export function formatTrashedAt(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
