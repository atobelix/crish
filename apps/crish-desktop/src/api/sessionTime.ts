/**
 * 会话侧栏相对时间：以用户输入 / 助手回复的最后时间戳为准。
 * 存盘一律 ISO；展示层动态换算，禁止把「刚刚」当静态字段永久显示。
 *
 * 治理防线 #6（数据水合与时间戳类型漂移）& #35（状态枚举语义重载）：
 *   - timestamp 字段始终为合法 ISO 串，禁止写入「刚刚」/「远程」等字面量
 *   - 来源由 `SessionState.timestampSource === 'remote'` discriminator 标记
 *   - 老持久化数据中 timestamp 可能存有 `'远程'` 字面量，识别函数向后兼容
 */

import type { SessionState } from '../store/layoutStore';

/** 历史错误字面量：曾被当 timestamp 写入，展示时必须重算 */
const BAD_LITERAL_TIMESTAMPS = new Set(['刚刚', '恢复', '刚才']);

/** 历史远程占位字面量（旧持久化数据；新代码改用 timestampSource='remote'） */
const REMOTE_TIMESTAMP_LITERAL = '远程';

/** 近 N ms 内有活动 → 用更快 tick，避免「刚刚」卡满一分钟 */
export const SESSION_LIST_RECENT_ACTIVITY_MS = 120_000;
/** 列表内存在近期活动时的刷新间隔 */
export const SESSION_LIST_TICK_FAST_MS = 15_000;
/** 全部较旧时的刷新间隔 */
export const SESSION_LIST_TICK_SLOW_MS = 60_000;
/** 页签隐藏时降频，避免后台空转 */
export const SESSION_LIST_TICK_HIDDEN_MS = 120_000;
/** tick 下限，防止边界计算产生过密 setTimeout */
export const SESSION_LIST_TICK_MIN_MS = 1_000;
/** 「刚刚」阈值（ms） */
export const SESSION_LIST_JUST_NOW_MS = 45_000;
/**
 * 允许的时钟漂移上限。超出则视为损坏/异常时间戳：
 * 展示走绝对日期，绝不永久停在「刚刚」。
 */
export const SESSION_LIST_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * 远程占位标记（非真实时间）。
 *
 * 优先检查 `SessionState.timestampSource === 'remote'`（新代码路径）；
 * 兼容老持久化数据中 timestamp 字段为 `'远程'` 字面量的情况。
 *
 * @param stored   timestamp 字段值
 * @param source   timestampSource 字段值（可选；老数据可能为 undefined）
 */
export function isRemoteSessionTimestamp(
  stored: string | undefined | null,
  source?: 'local' | 'remote' | null,
): boolean {
  if (source === 'remote') return true;
  return (stored || '').trim() === REMOTE_TIMESTAMP_LITERAL;
}

/** 是否为历史坏字面量（禁止当永久展示） */
export function isBadTimestampLiteral(stored: string | undefined | null): boolean {
  const t = (stored || '').trim();
  return t.length > 0 && BAD_LITERAL_TIMESTAMPS.has(t);
}

/** 有限且为正的毫秒时间戳，否则 0 */
function finitePositiveMs(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** 从 sess-1712345678901 / sess-branch-… 类 id 解析创建毫秒 */
export function msFromSessionId(id: string | undefined): number {
  if (!id) return 0;
  const m = id.match(/(?:^|-)(\d{10,13})(?:$|-)/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 秒级 / 毫秒级
  return n < 1e12 ? n * 1000 : n;
}

/** 解析已存时间戳字符串 → 毫秒；坏字面量 / 无效值返回 0 */
export function parseStoredTimestampMs(stored: string | undefined | null): number {
  const t = (stored || '').trim();
  if (!t || isBadTimestampLiteral(t)) return 0;
  // 老数据 '远程' 字面量视为无效时间
  if (t === REMOTE_TIMESTAMP_LITERAL) return 0;
  const parsed = Date.parse(t);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  // 纯数字秒/毫秒
  if (/^\d{10,13}$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  }
  return 0;
}

/**
 * 恢复 / 存盘时纠正历史字面量「刚刚」「恢复」「刚才」。
 * 优先消息时间，其次 id 内嵌时间戳，再否则保留可解析原值或当前 ISO。
 *
 * 治理防线 #6：返回值始终为合法 ISO 串，禁止 `'远程'` 字面量；
 * 远程来源由调用方通过 `timestampSource='remote'` 标记。
 * 老持久化数据中 `'远程'` 字面量会被规范化为当前 ISO（保留远程标记的职责在调用方）。
 */
export function coerceSessionTimestamp(
  id: string,
  stored: string | undefined | null,
  messages?: Array<{ timestamp?: number }>,
): string {
  const t = (stored || '').trim();
  // 老数据兼容：识别字面量后回落到正常时间推导路径
  // 可解析的真实时间（含 ISO）直接规范化为 ISO，避免 locale 字符串再次入库
  // 历史字面量（'刚刚' / '恢复' / '刚才' / '远程'）视为无效，走下方推导
  if (t && !isBadTimestampLiteral(t) && t !== REMOTE_TIMESTAMP_LITERAL) {
    const parsed = parseStoredTimestampMs(t);
    if (parsed > 0) return new Date(parsed).toISOString();
    // 保留无法解析但非坏字面量的原值（极少数第三方标记）
    return t;
  }

  if (messages?.length) {
    let max = 0;
    for (const m of messages) {
      const ts = finitePositiveMs(m.timestamp);
      if (ts > max) max = ts;
    }
    if (max > 0) return new Date(max).toISOString();
  }

  const fromId = msFromSessionId(id);
  if (fromId > 0) return new Date(fromId).toISOString();

  return new Date().toISOString();
}

/** 当前 ISO 字符串（新建 / 活动触达时写入） */
export function nowIsoTimestamp(): string {
  return new Date().toISOString();
}

/** 绝对日历文案（同年 M/D，跨年 Y/M/D）；供相对桶末档与远未来损坏时间戳共用 */
export function formatAbsoluteCalendarDate(ms: number, now = Date.now()): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const day = date.getDate();
  const cy = new Date(now).getFullYear();
  if (y === cy) return `${m}/${day}`;
  return `${y}/${m}/${day}`;
}

/**
 * 会话最近活动毫秒。
 * 优先级：消息 / agent → 可解析 timestamp → id epoch。
 * 保证空会话也能按创建时间排序，且「刚刚」会随 now 老化。
 */
export function sessionLastActivityMs(s: SessionState): number {
  let max = 0;
  for (const m of s.messages || []) {
    const ts = finitePositiveMs(m.timestamp);
    if (ts > max) max = ts;
  }
  for (const a of s.agents || []) {
    const started = finitePositiveMs(a.startedAt);
    if (started > max) max = started;
    const ended = finitePositiveMs(a.endedAt);
    if (ended > max) max = ended;
    for (const m of a.messages || []) {
      const ts = finitePositiveMs(m.timestamp);
      if (ts > max) max = ts;
    }
  }
  if (max > 0) return max;

  const fromStored = parseStoredTimestampMs(s.timestamp);
  if (fromStored > 0) return fromStored;

  return msFromSessionId(s.id);
}

/**
 * 轻量活动指纹（侧栏 equality / 排序键 / tick）：
 * 末条主消息 + 每个 agent 的起止与末条消息，不扫全文，避免 O(n·m) 放大。
 * 流式改正文时 timestamp 通常不变 → 与 shell equal 忽略正文一致。
 * agent 末条用于与 formatSessionListTime（全量）在「刚刚」老化边界对齐。
 */
export function sessionActivityShellMs(
  s: Pick<SessionState, 'id' | 'timestamp' | 'messages' | 'agents'>,
): number {
  let max = 0;
  const msgs = s.messages;
  if (msgs?.length) {
    const last = msgs[msgs.length - 1];
    const ts = finitePositiveMs(last?.timestamp);
    if (ts > max) max = ts;
  }
  const agents = s.agents;
  if (agents?.length) {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const started = finitePositiveMs(a?.startedAt);
      if (started > max) max = started;
      const ended = finitePositiveMs(a?.endedAt);
      if (ended > max) max = ended;
      const am = a?.messages;
      if (am?.length) {
        const last = am[am.length - 1];
        const ts = finitePositiveMs(last?.timestamp);
        if (ts > max) max = ts;
      }
    }
  }
  if (max > 0) return max;
  const fromStored = parseStoredTimestampMs(s.timestamp);
  if (fromStored > 0) return fromStored;
  return msFromSessionId(s.id);
}

/**
 * 按最近活动降序；同活动按 id 升序，保证 sort 稳定（窗口化切片不抖）。
 */
export function compareSessionsByActivity(
  a: SessionState,
  b: SessionState,
): number {
  const d = sessionLastActivityMs(b) - sessionLastActivityMs(a);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 相对时间文案；ms 无效时返回空串（由调用方决定是否再 fallback） */
export function formatRelativeActivity(ms: number, now = Date.now()): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return '';
  // 远未来（损坏时间戳 / 异常时钟）：绝对日期，禁止永久「刚刚」
  if (ms > now + SESSION_LIST_CLOCK_SKEW_MS) {
    return formatAbsoluteCalendarDate(ms, now);
  }
  // 近未来（时钟漂移）按 d=0 →「刚刚」，随后随真实 now 老化，不写死字段
  const d = Math.max(0, now - ms);
  if (d < SESSION_LIST_JUST_NOW_MS) return '刚刚';
  if (d < 3_600_000) return `${Math.max(1, Math.floor(d / 60_000))}分钟前`;
  if (d < 86_400_000) return `${Math.max(1, Math.floor(d / 3_600_000))}小时前`;
  if (d < 7 * 86_400_000) return `${Math.max(1, Math.floor(d / 86_400_000))}天前`;
  if (d < 30 * 86_400_000) return `${Math.max(1, Math.floor(d / (7 * 86_400_000)))}周前`;
  return formatAbsoluteCalendarDate(ms, now);
}

/**
 * 距下一次相对文案变更的毫秒数（与 formatRelativeActivity 桶对齐）。
 * 「刚刚」→「1分钟前」在 JUST_NOW 边界；其后按分钟/小时/天桶推进。
 * 近未来（时钟漂移）先等到真实越过活动点再加 JUST_NOW。
 * 远未来 / 无法再变（绝对日期）返回 null。
 */
export function msUntilRelativeLabelChange(activityMs: number, now = Date.now()): number | null {
  if (!activityMs || activityMs <= 0 || !Number.isFinite(activityMs)) return null;
  if (activityMs > now + SESSION_LIST_CLOCK_SKEW_MS) return null;
  // 近未来：等到 activity 成为「过去」后再计 JUST_NOW 窗
  if (activityMs > now) {
    return activityMs - now + SESSION_LIST_JUST_NOW_MS;
  }
  const d = now - activityMs;
  if (d < SESSION_LIST_JUST_NOW_MS) {
    return SESSION_LIST_JUST_NOW_MS - d;
  }
  if (d < 3_600_000) {
    // [JUST_NOW, 120s) →「1分钟前」；之后每 +60s 桶变一次
    if (d < 120_000) return 120_000 - d;
    const nextBucket = (Math.floor(d / 60_000) + 1) * 60_000;
    return Math.max(0, nextBucket - d);
  }
  if (d < 86_400_000) {
    const next = (Math.floor(d / 3_600_000) + 1) * 3_600_000;
    return Math.max(0, next - d);
  }
  if (d < 7 * 86_400_000) {
    const next = (Math.floor(d / 86_400_000) + 1) * 86_400_000;
    return Math.max(0, next - d);
  }
  if (d < 30 * 86_400_000) {
    const week = 7 * 86_400_000;
    const next = (Math.floor(d / week) + 1) * week;
    return Math.max(0, next - d);
  }
  return null;
}

/**
 * 侧栏展示用：统一走 sessionLastActivityMs，绝不把存盘「刚刚」当静态文案。
 * 「刚刚」仅当 now - activity < 45s（或近未来时钟漂移）时瞬时出现，随后由 tick 刷新为「N分钟前」。
 */
export function formatSessionListTime(s: SessionState, now = Date.now()): string {
  if (isRemoteSessionTimestamp(s.timestamp, s.timestampSource) && sessionLastActivityMs(s) <= 0) {
    return '远程';
  }
  const ms = sessionLastActivityMs(s);
  if (ms > 0) return formatRelativeActivity(ms, now);
  return '';
}

/**
 * 悬停 / title / aria 用绝对时间（本地可读），避免只显示相对文案时无法核对真实时刻。
 * 无效活动时间返回空串。
 */
export function formatSessionListAbsoluteTime(s: SessionState, _now = Date.now()): string {
  if (isRemoteSessionTimestamp(s.timestamp, s.timestampSource) && sessionLastActivityMs(s) <= 0) {
    return '远程';
  }
  const ms = sessionLastActivityMs(s);
  if (!ms || ms <= 0) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * 是否存在「近期活动」会话（决定 tick 快慢）；用 shell，避免长列表扫全文。
 * 远未来损坏时间戳不计为近期，避免永久快 tick。
 */
export function hasRecentSessionActivity(
  sessions: Array<Pick<SessionState, 'id' | 'timestamp' | 'messages' | 'agents'>>,
  now = Date.now(),
  windowMs = SESSION_LIST_RECENT_ACTIVITY_MS,
): boolean {
  for (const s of sessions) {
    const ms = sessionActivityShellMs(s);
    if (ms <= 0) continue;
    const age = now - ms;
    // age 为负且在 skew 内 → 近未来漂移，仍算近期；远未来排除
    if (age < windowMs && age > -SESSION_LIST_CLOCK_SKEW_MS) return true;
  }
  return false;
}

/**
 * 推荐侧栏时间刷新间隔（毫秒）。
 * - 列表中若有 2 分钟内活动，用 15s 间隔；
 * - 再与「下一相对文案边界」取 min，保证「刚刚」不会卡到下一慢 tick 才老化；
 * - 远未来损坏时间戳不贴边、不拉快 tick；
 * - document.hidden 时由调用方改用 SESSION_LIST_TICK_HIDDEN_MS。
 */
export function sessionListTimeTickMs(
  sessions: Array<Pick<SessionState, 'id' | 'timestamp' | 'messages' | 'agents'>>,
  now = Date.now(),
): number {
  let tick = hasRecentSessionActivity(sessions, now)
    ? SESSION_LIST_TICK_FAST_MS
    : SESSION_LIST_TICK_SLOW_MS;

  for (const s of sessions) {
    const act = sessionActivityShellMs(s);
    if (act <= 0) continue;
    // 远未来：绝对日期，无需贴边
    if (act > now + SESSION_LIST_CLOCK_SKEW_MS) continue;
    // 只对近未来漂移 + 一小时内过去活动做边界贴合，避免旧会话把 tick 拉得过碎
    if (act <= now && now - act > 3_600_000) continue;
    const until = msUntilRelativeLabelChange(act, now);
    if (until != null && until > 0) {
      // +50ms 越过边界，确保 format 看到新桶
      tick = Math.min(tick, Math.max(SESSION_LIST_TICK_MIN_MS, until + 50));
    }
  }
  return tick;
}
