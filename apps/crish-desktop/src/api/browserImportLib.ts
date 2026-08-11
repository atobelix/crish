/**
 * 浏览器导入纯逻辑面（U6）：storage_state 预览解析 / 时间格式化 / 文件读取辅助。
 * 与 React 无关，便于单测与复用（组件只做编排，不做解析）。
 */

/** storage_state 预览（导出授权确认流：Dialog2 域名清单预览）。 */
export interface StorageStatePreview {
  /** cookie 总条数（来源 JSON 原样计数）。 */
  cookieCount: number;
  /** 去重后的 cookie 域名清单（排序；不含 value，脱敏纪律 §5.4）。 */
  domains: string[];
  /** origins 数（localStorage 采集未接线，恒 0——见命令注释）。 */
  origins: number;
}

/**
 * 从导出返回的 storage_state JSON 提取脱敏预览：cookie 域名清单 + 条数。
 * 非法 JSON / 形状不符 → 空预览（count 0、domains []），不抛出。
 */
export function parseStorageStatePreview(json: string): StorageStatePreview {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { cookieCount: 0, domains: [], origins: 0 };
  }
  const root = value as { cookies?: unknown; origins?: unknown };
  const cookies = Array.isArray(root?.cookies) ? root.cookies : [];
  const domains = Array.from(
    new Set(
      cookies
        .map((c) => {
          const o = c as { domain?: unknown };
          return typeof o?.domain === 'string' ? o.domain : '';
        })
        .filter((d) => d.length > 0)
    )
  ).sort((a, b) => a.localeCompare(b));
  const origins = Array.isArray(root?.origins) ? root.origins.length : 0;
  return { cookieCount: cookies.length, domains, origins };
}

/**
 * 导入/导出统计展示面：unix 秒 → 本地可读时间。
 * 非法值（非有限/超范围）返回原文占位，不抛出。
 */
export function formatUnixSecTime(unixSec: number): string {
  const n = Math.floor(Number(unixSec));
  if (!Number.isFinite(n) || n <= 0) return String(unixSec ?? '');
  const d = new Date(n * 1000);
  if (Number.isNaN(d.getTime())) return String(unixSec);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 浏览器数据文件兜底大小校验（书签 JSON / storage_state JSON 均 ≤ 10MB，对齐命令面）。 */
export const BROWSER_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

/** 登录态导出文件名（另存为面；含日期时间戳防覆盖）。 */
export function storageStateExportFilename(now: Date = new Date()): string {
  const pad = (x: number) => String(x).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `browser-storage-state-${stamp}.json`;
}

/** 登录态 JSON 文本是否为非空可提交内容（trim 后判定）。 */
export function isUsableJsonText(text: string): boolean {
  return text.trim().length > 0;
}
