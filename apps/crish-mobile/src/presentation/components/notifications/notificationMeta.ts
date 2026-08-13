// 通知元信息纯函数（R2-04 部分 5：通知中心数据面派生，jest 直测无 RN 依赖）
// - 类型三分（审批/事件/系统）：按 kind 前缀映射（D7 场景清单 S1-S12 的 kind 字面量：
//   approval-* / run-* / task-* / subagent-* / timer-* / cron-* / security-* / runtime-* 等）；
// - 深链翻译：route 字段（D7 §7.4 / M4 §4.3 深链映射表）→ expo-router 路径白名单
//   （仅允许既有路由目标，未知目标 → null 不导航，M4 §4.3 接线要点：白名单校验 + 参数二次校验）；
// - 角标收敛：>99 → '99+'（F1 §4.8 合并角标 ≤99+；对齐 SessionRow.unreadLabel 同款口径）。
export type NotificationKindCategory = 'approval' | 'event' | 'system';

/** 类型三分 → 行内徽章文案（审批/事件/系统） */
export const NOTIFICATION_CATEGORY_LABEL: Record<
  NotificationKindCategory,
  string
> = {
  approval: '审批',
  event: '事件',
  system: '系统',
};

/** 通知 kind → 三分类型（未登记前缀归入 event，不丢不猜，F1 §4.3 保真语义） */
export function notificationKindCategory(
  kind: string
): NotificationKindCategory {
  if (kind.startsWith('approval')) return 'approval';
  if (
    kind.startsWith('security-') ||
    kind.startsWith('runtime-') ||
    kind.startsWith('cache-') ||
    kind.startsWith('context-compression-') ||
    kind === 'system' ||
    kind === 'night-summary'
  ) {
    return 'system';
  }
  return 'event';
}

/** 未读角标上限（F1 §4.8：合并角标 ≤99+） */
export const NOTIFICATION_BADGE_CAP = 99;

/** 未读角标文案（上限收敛） */
export function notificationBadgeLabel(count: number): string {
  return count > NOTIFICATION_BADGE_CAP ? '99+' : String(count);
}

/** 深链翻译输入（notificationStore 条目字段面，见 InAppNotification） */
export interface NotificationDeepLinkSource {
  /** 深链（D7 §7.4：crish://approval/{toolCallId} 等；可为 null） */
  route: string | null;
  /** 通知类型（approval / run-ended / task-failed / …） */
  kind: string;
  toolCallId: string | null;
  runId: string | null;
}

/** 深链白名单（M4 §4.3 深链映射表子集：app 既有路由目标；id 构建函数） */
const DEEP_LINK_ROUTE_TABLE: Record<string, (id: string) => string | null> = {
  approval: (id) => (id ? `/approval/${id}` : null),
  session: (id) => (id ? `/session/${id}` : null),
  run: (id) => (id ? `/run/${id}` : null),
  terminal: (id) => (id ? `/terminal/${id}` : null),
  approvals: () => '/approvals',
  tasks: () => '/tasks',
  usage: () => '/usage',
  diagnostics: () => '/diagnostics',
  dashboard: () => '/',
  files: () => '/files',
  settings: () => '/settings',
};

/** 深链 scheme 白名单（M4 §4.3 统一 schema crish://；F2 §6.2 历史形态 conex://） */
const ALLOWED_DEEP_LINK_SCHEMES: ReadonlySet<string> = new Set([
  'crish',
  'conex',
]);

/** 查询串手工解析（避免依赖 URLSearchParams 的 Hermes 行为差异；键存在但无值视为缺省） */
function readQueryParams(
  queryPart: string | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!queryPart) return out;
  for (const pair of queryPart.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 通知项 → expo-router 路径（深链白名单翻译）：
 * - route 优先（D7 §7.4 / M4 §4.3 形态 crish://approval/{toolCallId}、
 *   F2 §6.2 形态 conex://approval?toolCallId=…、以及 expo-router 相对路径 /approval/…）；
 * - route 缺失/不可解析时按 kind/字段兜底（审批 → toolCallId；run/task/subagent 事件 → runId）；
 * - 白名单外目标 / 缺 id → null（不导航，仅已读）。
 */
export function notificationRouteToPath(
  src: NotificationDeepLinkSource
): string | null {
  const raw = src.route;
  if (raw) {
    // expo-router 相对路径形式（本地构造/调试）：白名单首段校验后透传
    if (raw.startsWith('/')) {
      const first = raw.slice(1).split('/')[0];
      return first && first in DEEP_LINK_ROUTE_TABLE ? raw : null;
    }
    const [pathPart = '', queryPart] = raw.split('?');
    // scheme 白名单校验（M4 §4.3：仅 crish:// / conex:// 形态；其余 scheme 拒绝）
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(pathPart);
    const scheme = schemeMatch ? (schemeMatch[1] ?? '') : null;
    if (scheme !== null && !ALLOWED_DEEP_LINK_SCHEMES.has(scheme)) {
      return null;
    }
    const withoutScheme = schemeMatch
      ? pathPart.slice(schemeMatch[0].length)
      : pathPart;
    const segments = withoutScheme.split('/').filter(Boolean);
    const screen = segments[0] ?? '';
    const builder = DEEP_LINK_ROUTE_TABLE[screen];
    if (!builder) return null;
    const params = readQueryParams(queryPart);
    // 路径段优先，其次查询参数（F2 §6.2 形态）
    const id =
      segments[1] ??
      params.toolCallId ??
      params.sessionId ??
      params.runId ??
      null;
    return builder(id ?? '');
  }
  // route 缺失兜底：按 kind/字段语义构造
  if (src.kind.startsWith('approval') && src.toolCallId) {
    return `/approval/${src.toolCallId}`;
  }
  if (
    src.runId &&
    (src.kind.startsWith('run') ||
      src.kind.startsWith('task') ||
      src.kind.startsWith('subagent'))
  ) {
    return `/run/${src.runId}`;
  }
  return null;
}
