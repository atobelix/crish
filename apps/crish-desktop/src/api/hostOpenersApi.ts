/**
 * 主机「打开方式」：扫描本机已安装应用 / 快捷方式，不用前端硬编码名单。
 * 经 Tauri workbench_list_host_openers / workbench_open_host_target。
 */

import { invokeCmd, invokeResult } from './tauriInvoke';

export type HostOpenerKind = 'file-manager' | 'editor' | string;

export type HostOpener = {
  id: string;
  displayName: string;
  label?: string;
  kind: HostOpenerKind;
  available: boolean;
  reason?: string | null;
  /** 可选：可执行路径，供图标 convertFileSrc */
  path?: string | null;
  iconDataUrl?: string | null;
};

type RawHostOpener = {
  id?: string;
  displayName?: string;
  display_name?: string;
  label?: string;
  kind?: string;
  available?: boolean;
  reason?: string | null;
  path?: string | null;
  command?: string | null;
  diagnostic?: { path?: string | null; command?: string | null };
};

function normalizeOpener(raw: RawHostOpener): HostOpener | null {
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const displayName = String(
    raw.displayName || raw.display_name || raw.label || id,
  ).trim();
  const path =
    (typeof raw.path === 'string' && raw.path) ||
    (typeof raw.diagnostic?.path === 'string' && raw.diagnostic.path) ||
    (typeof raw.command === 'string' && raw.command.includes('\\')
      ? raw.command
      : null) ||
    null;
  return {
    id,
    displayName,
    label: raw.label,
    kind: (raw.kind || 'editor') as HostOpenerKind,
    available: raw.available !== false,
    reason: raw.reason,
    path,
  };
}

/** 扫描本机可用打开器（编辑器 / 资源管理器等，由壳层发现） */
export async function listHostOpeners(): Promise<HostOpener[]> {
  const raw = await invokeCmd<RawHostOpener[]>('workbench_list_host_openers');
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeOpener)
    .filter((o): o is HostOpener => Boolean(o && o.available));
}

/**
 * 按扩展名再扫一轮「推荐应用」：Start Menu 快捷方式（非硬编码名单）。
 * 壳层未实现时回落空数组。
 */
export async function listFileOpenHandlers(filePath: string): Promise<HostOpener[]> {
  const path = (filePath || '').trim();
  if (!path) return [];
  const raw = await invokeCmd<RawHostOpener[]>('workbench_list_file_openers', {
    path,
  });
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeOpener)
    .filter((o): o is HostOpener => Boolean(o && o.available));
}

/** 用指定 opener 打开路径 */
export async function openWithHostOpener(
  openerId: string,
  filePath: string,
): Promise<void> {
  const res = await invokeResult('workbench_open_host_target', {
    openerId,
    target: { type: 'path', path: filePath },
  });
  if (res.status === 'ok') return;
  if (res.status === 'error') throw new Error(res.message);
  throw new Error('无法用该应用打开（需桌面壳）');
}

/** 系统默认关联打开文件 */
export async function openPathDefault(filePath: string): Promise<void> {
  const path = (filePath || '').trim();
  if (!path) throw new Error('路径为空');
  // 优先专用命令；缺失则 file-manager 回落 reveal 体验较差，再试 start
  const res = await invokeResult('workbench_open_path_default', { path });
  if (res.status === 'ok') return;
  if (res.status === 'error') {
    // 回落：资源管理器 / 系统打开
    try {
      await openWithHostOpener('system-file-manager', path);
      return;
    } catch {
      throw new Error(res.message);
    }
  }
  // missing command：PowerShell Start-Process 最后手段
  const isWin =
    typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent || navigator.platform || '');
  const shell = await invokeResult('workbench_run_shell', {
    command: isWin
      ? `powershell -NoProfile -Command "Start-Process -LiteralPath '${path.replace(/'/g, "''")}'"`
      : `xdg-open ${JSON.stringify(path)}`,
  });
  if (shell.status === 'ok') return;
  throw new Error('无法用系统默认方式打开（需桌面壳）');
}

/**
 * 合并「推荐 + 通用打开器」，去重，并按文件类型略排序：
 * 图片/PDF 优先 file-manager 之后的编辑器/浏览器类；代码优先 editor。
 */
export async function listOpenOptionsForFile(filePath: string): Promise<{
  defaultLabel: string;
  openers: HostOpener[];
}> {
  const base = pathBase(filePath);
  const ext = (base.includes('.') ? base.split('.').pop() : '') || '';
  const lower = ext.toLowerCase();
  const [hosts, handlers] = await Promise.all([
    listHostOpeners(),
    listFileOpenHandlers(filePath),
  ]);
  const map = new Map<string, HostOpener>();
  for (const o of [...handlers, ...hosts]) {
    if (!map.has(o.id)) map.set(o.id, o);
  }
  let openers = [...map.values()];
  // 轻量偏好：图片/文档时把 file-manager 沉底，编辑器仍可见
  const imageLike = /^(png|jpe?g|gif|webp|bmp|svg|pdf|ico)$/i.test(lower);
  const codeLike = /^(ts|tsx|js|jsx|json|md|css|html|rs|py|go|java|c|cpp|h|cs)$/i.test(
    lower,
  );
  openers.sort((a, b) => {
    const score = (o: HostOpener) => {
      let s = 0;
      if (codeLike && o.kind === 'editor') s += 10;
      if (imageLike && o.kind === 'file-manager') s -= 2;
      if (o.id === 'system-file-manager') s -= 1;
      return s;
    };
    return score(b) - score(a);
  });
  const defaultLabel =
    imageLike ? '打开' : codeLike ? '编辑' : '打开';
  return { defaultLabel, openers };
}

function pathBase(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}
