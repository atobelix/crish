export type SortMode = 'name' | 'state';
export type DemoTransport = 'stdio' | 'sse';

const DEMO_TRANSPORTS: ReadonlySet<DemoTransport> = new Set<DemoTransport>([
  'stdio',
  'sse',
]);

export function isDemoTransport(value: unknown): value is DemoTransport {
  return (
    typeof value === 'string' && DEMO_TRANSPORTS.has(value as DemoTransport)
  );
}

export const START_STOP_HINT =
  '当前引擎不支持从界面启停；扩展服务通常随任务运行时连接';

export const EMPTY_LIVE_HINT_UNCONFIGURED =
  '引擎侧暂未配置扩展服务；任务运行时若连接 MCP 会显示在此';
export const EMPTY_LIVE_HINT_CONFIGURED =
  '已配置但当前无实例；扩展服务通常随任务运行时连接';
export const EMPTY_DEMO_HINT = '演示模式可本地添加 mock 服务，不会写入引擎';
export const EMPTY_FILTER_HINT = '调整关键词或清除筛选';

export const STATE_SORT_RANK: Record<string, number> = {
  ok: 0,
  warn: 1,
  err: 2,
  idle: 3,
};

export function transportLabel(raw?: string): string {
  if (!raw) return '';
  const t = raw.toLowerCase();
  if (t === 'stdio') return 'stdio';
  if (t === 'sse') return 'sse';
  if (t === 'http' || t === 'streamable-http') return raw;
  return raw;
}

export function transportTitle(
  raw?: string,
  translate?: (key: string, fallback: string) => string
): string | undefined {
  if (!raw) return undefined;
  const tr = raw.toLowerCase();
  if (tr === 'stdio')
    return translate
      ? translate('settings.mcp.transportStdioTitle', '标准输入输出（stdio）')
      : '标准输入输出（stdio）';
  if (tr === 'sse')
    return translate
      ? translate('settings.mcp.transportSseTitle', '服务端推送（SSE）')
      : '服务端推送（SSE）';
  if (tr === 'http')
    return translate
      ? translate('settings.mcp.transportHttpTitle', 'HTTP')
      : 'HTTP';
  if (tr === 'streamable-http')
    return translate
      ? translate('settings.mcp.transportStreamableTitle', '可流式 HTTP')
      : '可流式 HTTP';
  return raw;
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || String(e);
  return String(e ?? '');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
