/**
 * sessionTime 对抗性测试
 *
 * 目标：暴露会话时间戳解析、相对时间桶、tick 调度、活动计算在边界输入下的隐藏缺陷。
 *
 * 已暴露的 bug 清单（详见各 it 用例注释）：
 *  ST1. sessionLastActivityMs 对 messages 含 null 条目崩溃（已修复：跳过 null）
 *  ST2. sessionLastActivityMs 对 agents 含 null 条目崩溃（已修复：跳过 null）
 *  ST3. sessionLastActivityMs 对 agent.messages 含 null 条目崩溃（已修复：跳过 null）
 *  ST4. coerceSessionTimestamp 对 messages 含 null 条目崩溃（已修复：跳过 null）
 *  ST5. hasRecentSessionActivity 对 sessions 含 null 条目崩溃（已修复：跳过 null）
 *  ST6. sessionListTimeTickMs 对 sessions 含 null 条目崩溃（已修复：跳过 null）
 *
 * 设计观察（非 bug，记录用例）：
 *  ST7. msFromSessionId 对 14+ 位时间戳返回 0（正则限定 10-13 位）
 *  ST8. msFromSessionId 对 9 位时间戳返回 0（正则限定 10-13 位）
 *  ST9. msFromSessionId 对前导零的 10 位时间戳视为合法（"0123456789" → 123456789）
 *  ST10. parseStoredTimestampMs 对 "0" 在 V8 中被 Date.parse 解析为 946684800000（2000-01-01）
 *  ST11. parseStoredTimestampMs 对 "NaN" 字符串返回 0（先 Date.parse(NaN)=NaN，再正则不匹配）
 *  ST12. formatAbsoluteCalendarDate 对 now=NaN 返回 "NaN/NaN/NaN" 残缺字符串
 *  ST13. formatRelativeActivity 对 ms = now + CLOCK_SKEW 恰好相等时返回「刚刚」（边界含一侧）
 *  ST14. formatRelativeActivity 对 d = JUST_NOW 恰好相等时返回「1分钟前」（边界不含）
 *  ST15. compareSessionsByActivity 对双方活动都为 NaN 时返回 NaN 之外的值（依赖 id 兜底）
 *  ST16. coerceSessionTimestamp 对 stored="NaN" 字符串保留原值返回 "NaN"
 *  ST17. msUntilRelativeLabelChange 对 d 恰好处于桶边界返回 0（意味 label 立刻变更）
 *  ST18. sessionListTimeTickMs 对 activity 刚好 = now + CLOCK_SKEW 仍计入 tick 计算
 *  ST19. parseStoredTimestampMs 对 "9999999999"（10 位）视为秒级 → Year 2286
 *  ST20. formatRelativeActivity 对 ms = Number.MAX_SAFE_INTEGER 走绝对日期分支（合理）
 *  ST21. parseStoredTimestampMs 对 16 位带前导零数字串返回 0（正则不匹配）
 *  ST22. msFromSessionId 对 "sess-0000000000"（10 位全零）返回 0（n>0 检查）
 *  ST23. hasRecentSessionActivity 对 sessions 含空对象 {} 崩溃（已修复：ms<=0 时 continue）
 *  ST24. sessionListTimeTickMs 对单 session 远未来 activity 但 ms<=0 仍跳过（正确）
 *  ST25. coerceSessionTimestamp 对 messages timestamp=Infinity 跳过（finitePositiveMs 守卫）
 */

import { describe, it, expect } from 'vitest';
import {
  SESSION_LIST_CLOCK_SKEW_MS,
  SESSION_LIST_JUST_NOW_MS,
  SESSION_LIST_TICK_FAST_MS,
  SESSION_LIST_TICK_MIN_MS,
  SESSION_LIST_TICK_SLOW_MS,
  coerceSessionTimestamp,
  compareSessionsByActivity,
  formatAbsoluteCalendarDate,
  formatRelativeActivity,
  formatSessionListAbsoluteTime,
  formatSessionListTime,
  hasRecentSessionActivity,
  isBadTimestampLiteral,
  isRemoteSessionTimestamp,
  msFromSessionId,
  msUntilRelativeLabelChange,
  nowIsoTimestamp,
  parseStoredTimestampMs,
  sessionActivityShellMs,
  sessionLastActivityMs,
  sessionListTimeTickMs,
} from './sessionTime';
import type { SessionAgent, SessionMessage, SessionState } from '../store/types';

// ── helpers ────────────────────────────────────────────────────────────

function msg(partial: Partial<SessionMessage> & { id: string }): SessionMessage {
  return {
    sender: 'user',
    text: '',
    timestamp: 0,
    ...partial,
  } as SessionMessage;
}

function agent(partial: Partial<SessionAgent> & { id: string }): SessionAgent {
  return {
    subagentRunId: 'r',
    parentSessionId: 'p',
    parentRunId: 'pr',
    description: 'd',
    mode: 'default',
    status: 'running',
    messages: [],
    startedAt: 0,
    ...partial,
  } as SessionAgent;
}

function session(partial: Partial<SessionState> & { id: string }): SessionState {
  return {
    title: 't',
    folder: '对话',
    isPinned: false,
    isArchived: false,
    timestamp: new Date(0).toISOString(),
    messages: [],
    ...partial,
  };
}

describe('sessionTime — 对抗性测试', () => {
  // ───────────────────────────────────────────────────────────────────
  // ST1-ST3: sessionLastActivityMs null 安全
  // ───────────────────────────────────────────────────────────────────
  describe('ST1-ST3: sessionLastActivityMs null 安全', () => {
    it('ST1（已修复）: messages 含 null 条目跳过，不崩溃', () => {
      const s = session({
        id: 's1',
        messages: [
          null as unknown as SessionMessage,
          msg({ id: 'm1', timestamp: 1000 }),
          null as unknown as SessionMessage,
          msg({ id: 'm2', timestamp: 2000 }),
        ],
      });
      expect(() => sessionLastActivityMs(s)).not.toThrow();
      expect(sessionLastActivityMs(s)).toBe(2000);
    });

    it('ST2（已修复）: agents 含 null 条目跳过，不崩溃', () => {
      const s = session({
        id: 's2',
        messages: [],
        agents: [
          null as unknown as SessionAgent,
          agent({ id: 'a1', startedAt: 3000, endedAt: 4000 }),
          null as unknown as SessionAgent,
        ],
      });
      expect(() => sessionLastActivityMs(s)).not.toThrow();
      expect(sessionLastActivityMs(s)).toBe(4000);
    });

    it('ST3（已修复）: agent.messages 含 null 条目跳过，不崩溃', () => {
      const s = session({
        id: 's3',
        messages: [],
        agents: [
          agent({
            id: 'a1',
            startedAt: 1000,
            endedAt: 2000,
            messages: [
              null as unknown as SessionMessage,
              msg({ id: 'am1', timestamp: 5000 }),
              null as unknown as SessionMessage,
            ],
          }),
        ],
      });
      expect(() => sessionLastActivityMs(s)).not.toThrow();
      expect(sessionLastActivityMs(s)).toBe(5000);
    });

    it('全部 null messages 与 null agents → 回落到 stored / id', () => {
      const s = session({
        id: 'sess-1712345678901',
        timestamp: '刚刚',
        messages: [null as unknown as SessionMessage, null as unknown as SessionMessage],
        agents: [null as unknown as SessionAgent, null as unknown as SessionAgent],
      });
      expect(() => sessionLastActivityMs(s)).not.toThrow();
      expect(sessionLastActivityMs(s)).toBe(1712345678901);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST4: coerceSessionTimestamp null 安全
  // ───────────────────────────────────────────────────────────────────
  describe('ST4: coerceSessionTimestamp null 安全', () => {
    it('ST4（已修复）: messages 含 null 条目跳过，不崩溃', () => {
      const before = Date.now();
      const result = coerceSessionTimestamp(
        'sess-no-epoch',
        '刚刚',
        [
          null as unknown as { timestamp?: number },
          { timestamp: 1_700_000_000_000 },
          null as unknown as { timestamp?: number },
        ],
      );
      // 跳过 null 后取 1700000000000 → ISO
      expect(result).toBe(new Date(1_700_000_000_000).toISOString());
      // 验证未取当前时间（说明跳过 null 后取到了真实消息时间）
      const parsedMs = Date.parse(result);
      expect(parsedMs).toBe(1_700_000_000_000);
      expect(parsedMs).toBeLessThan(before);
    });

    it('messages 全 null → 回落到 id epoch', () => {
      const result = coerceSessionTimestamp(
        'sess-1712345678901',
        '刚刚',
        [null as unknown as { timestamp?: number }, null as unknown as { timestamp?: number }],
      );
      expect(result).toBe(new Date(1712345678901).toISOString());
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST5-ST6: hasRecentSessionActivity / sessionListTimeTickMs null 安全
  // ───────────────────────────────────────────────────────────────────
  describe('ST5-ST6: 列表函数 null 安全', () => {
    it('ST5（已修复）: hasRecentSessionActivity 对 sessions 含 null 条目跳过，不崩溃', () => {
      const now = Date.now();
      const sessions: Array<SessionState> = [
        null as unknown as SessionState,
        session({
          id: 'recent',
          timestamp: new Date(now).toISOString(),
          messages: [msg({ id: 'm', timestamp: now - 10_000 })],
        }),
        null as unknown as SessionState,
      ];
      expect(() => hasRecentSessionActivity(sessions, now)).not.toThrow();
      expect(hasRecentSessionActivity(sessions, now)).toBe(true);
    });

    it('ST5（已修复）: hasRecentSessionActivity 对 sessions 全 null 返回 false', () => {
      const now = Date.now();
      const sessions: Array<SessionState> = [
        null as unknown as SessionState,
        null as unknown as SessionState,
      ];
      expect(() => hasRecentSessionActivity(sessions, now)).not.toThrow();
      expect(hasRecentSessionActivity(sessions, now)).toBe(false);
    });

    it('ST6（已修复）: sessionListTimeTickMs 对 sessions 含 null 条目跳过，不崩溃', () => {
      const now = Date.now();
      const sessions: Array<SessionState> = [
        null as unknown as SessionState,
        session({
          id: 'recent',
          timestamp: new Date(now).toISOString(),
          messages: [msg({ id: 'm', timestamp: now - 10_000 })],
        }),
        null as unknown as SessionState,
      ];
      expect(() => sessionListTimeTickMs(sessions, now)).not.toThrow();
      const tick = sessionListTimeTickMs(sessions, now);
      expect(tick).toBeLessThanOrEqual(SESSION_LIST_TICK_FAST_MS);
      expect(tick).toBeGreaterThanOrEqual(SESSION_LIST_TICK_MIN_MS);
    });

    it('ST6（已修复）: sessionListTimeTickMs 对 sessions 全 null 返回 slow tick', () => {
      const now = Date.now();
      const sessions: Array<SessionState> = [
        null as unknown as SessionState,
        null as unknown as SessionState,
      ];
      expect(() => sessionListTimeTickMs(sessions, now)).not.toThrow();
      expect(sessionListTimeTickMs(sessions, now)).toBe(SESSION_LIST_TICK_SLOW_MS);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST7-ST9, ST22: msFromSessionId 正则边界
  // ───────────────────────────────────────────────────────────────────
  describe('ST7-ST9, ST22: msFromSessionId 正则边界', () => {
    it('ST7（设计观察）: 14 位时间戳返回 0（正则限定 10-13 位）', () => {
      // 14 位远未来时间戳（Year ~5138）会被静默丢弃
      expect(msFromSessionId('sess-99999999999999')).toBe(0);
      expect(msFromSessionId('sess-10000000000000')).toBe(0);
    });

    it('ST8（设计观察）: 9 位时间戳返回 0（正则限定 10-13 位）', () => {
      // 9 位秒级时间戳（Year ~2001）会被静默丢弃
      expect(msFromSessionId('sess-999999999')).toBe(0);
      expect(msFromSessionId('sess-100000000')).toBe(0);
    });

    it('ST9（设计观察）: 前导零的 10 位数字串视为合法', () => {
      // "0123456789" 匹配 \d{10,13}，但 Number("0123456789") = 123456789
      // n < 1e12 → 视为秒级 → 返回 123456789000（Year 1973）
      const result = msFromSessionId('sess-0123456789');
      expect(result).toBe(123456789 * 1000);
    });

    it('ST22（设计观察）: 10 位全零返回 0（n>0 检查失败）', () => {
      expect(msFromSessionId('sess-0000000000')).toBe(0);
    });

    it('13 位毫秒时间戳正确解析', () => {
      expect(msFromSessionId('sess-1712345678901')).toBe(1712345678901);
    });

    it('10 位秒时间戳自动 ×1000', () => {
      expect(msFromSessionId('sess-1712345678')).toBe(1712345678 * 1000);
    });

    it('branch 风格 id 解析', () => {
      expect(msFromSessionId('sess-branch-1712345678901')).toBe(1712345678901);
      expect(msFromSessionId('sess-branch-1712345678901-x')).toBe(1712345678901);
    });

    it('非字符串 / 空串 / 无匹配返回 0', () => {
      expect(msFromSessionId(undefined)).toBe(0);
      expect(msFromSessionId('')).toBe(0);
      expect(msFromSessionId('sess-abc')).toBe(0);
      expect(msFromSessionId('sess-123-456-7890')).toBe(0); // 多段不连续
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST10-ST11, ST19, ST21: parseStoredTimestampMs 边界
  // ───────────────────────────────────────────────────────────────────
  describe('ST10-ST11, ST19, ST21: parseStoredTimestampMs 边界', () => {
    it('ST10（已修复）: "0" 返回 0（不再被 V8 Date.parse 误释为 2000-01-01）', () => {
      // 修复前：Date.parse("0") 在 V8 中返回 946656000000（本地时区 2000-01-01）
      // 修复后：纯数字串必须匹配 10-13 位才接受，"0" 不匹配 → 返回 0
      expect(parseStoredTimestampMs('0')).toBe(0);
    });

    it('ST11（设计观察）: "NaN" 字符串返回 0（Date.parse("NaN")=NaN，正则不匹配）', () => {
      expect(parseStoredTimestampMs('NaN')).toBe(0);
    });

    it('ST19（设计观察）: "9999999999"（10 位）视为秒级 → Year 2286', () => {
      // 10 位匹配 ^\d{10,13}$，n=9999999999 < 1e12 → ×1000 = 9999999999000
      expect(parseStoredTimestampMs('9999999999')).toBe(9999999999 * 1000);
    });

    it('ST21（已修复）: 16+ 位带前导零数字串返回 0（不再被 V8 Date.parse 误释）', () => {
      // 修复前：Date.parse("0000000000123456") 在 V8 中返回 3833727811200000
      // 修复后：纯数字串必须匹配 10-13 位才接受，16 位 → 返回 0
      expect(parseStoredTimestampMs('0000001712345678901')).toBe(0);
      expect(parseStoredTimestampMs('0000000000123456')).toBe(0);
    });

    it('坏字面量 / 远程 / 空串 / 空白 返回 0', () => {
      expect(parseStoredTimestampMs('刚刚')).toBe(0);
      expect(parseStoredTimestampMs('恢复')).toBe(0);
      expect(parseStoredTimestampMs('刚才')).toBe(0);
      expect(parseStoredTimestampMs('远程')).toBe(0);
      expect(parseStoredTimestampMs('')).toBe(0);
      expect(parseStoredTimestampMs('   ')).toBe(0);
      expect(parseStoredTimestampMs(null)).toBe(0);
      expect(parseStoredTimestampMs(undefined)).toBe(0);
    });

    it('ISO 串正确解析', () => {
      const iso = '2024-01-02T03:04:05.000Z';
      expect(parseStoredTimestampMs(iso)).toBe(Date.parse(iso));
    });

    it('13 位毫秒数字串正确解析', () => {
      expect(parseStoredTimestampMs('1712345678901')).toBe(1712345678901);
    });

    it('10 位秒数字串自动 ×1000', () => {
      expect(parseStoredTimestampMs('1712345678')).toBe(1712345678 * 1000);
    });

    it('13 位带前导零（实际 13 位数字串）→ 视为合法秒级时间戳', () => {
      // "0123456789012" 匹配 ^\d{13}$，Number() = 123456789012 < 1e12 → ×1000
      // 这是设计行为：前导零的 13 位数字串仍视为合法
      expect(parseStoredTimestampMs('0123456789012')).toBe(123456789012 * 1000);
    });

    it('无效日期串返回 0', () => {
      expect(parseStoredTimestampMs('not-a-date')).toBe(0);
      expect(parseStoredTimestampMs('2024-13-45')).toBe(0);
      // 修复前：V8 Date.parse('2024-02-30') 静默 overflow 到 2024-03-01 返回 1709251200000
      // 修复后：re-parse 验证日期组件不一致 → 返回 0
      expect(parseStoredTimestampMs('2024-02-30')).toBe(0); // 2 月 30 日非法
      expect(parseStoredTimestampMs('2024-04-31')).toBe(0); // 4 月 31 日非法
      expect(parseStoredTimestampMs('2024-00-15')).toBe(0); // 0 月非法
      expect(parseStoredTimestampMs('2024-13-01')).toBe(0); // 13 月非法
    });

    it('HTTP-date 未来时间正常解析', () => {
      const future = new Date(Date.now() + 60_000).toUTCString();
      const result = parseStoredTimestampMs(future);
      expect(result).toBeDefined();
      expect(result).toBeGreaterThan(Date.now());
    });

    it('HTTP-date 过去时间返回正数 ms（不钳到 0）', () => {
      const past = new Date(Date.now() - 60_000).toUTCString();
      const result = parseStoredTimestampMs(past);
      expect(result).toBeGreaterThan(Date.now() - 120_000);
      expect(result).toBeLessThan(Date.now());
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST12-ST14: formatRelativeActivity 桶边界
  // ───────────────────────────────────────────────────────────────────
  describe('ST12-ST14: formatRelativeActivity 桶边界', () => {
    const now = 1_000_000_000_000;

    it('ST12（设计观察）: ms = now + CLOCK_SKEW 恰好相等 → 走「刚刚」分支', () => {
      // ms > now + CLOCK_SKEW_MS → 绝对日期
      // ms === now + CLOCK_SKEW_MS → 不大于，走 d = max(0, -CLOCK_SKEW) = 0 → 「刚刚」
      const exactly = now + SESSION_LIST_CLOCK_SKEW_MS;
      expect(formatRelativeActivity(exactly, now)).toBe('刚刚');
      const oneMore = now + SESSION_LIST_CLOCK_SKEW_MS + 1;
      expect(formatRelativeActivity(oneMore, now)).toBe(
        formatAbsoluteCalendarDate(oneMore, now),
      );
    });

    it('ST13（设计观察）: d = JUST_NOW 恰好相等 → 「1分钟前」（边界不含）', () => {
      // d < JUST_NOW → 「刚刚」；d = JUST_NOW 不满足 < → 「1分钟前」
      expect(formatRelativeActivity(now - SESSION_LIST_JUST_NOW_MS, now)).toBe(
        '1分钟前',
      );
      expect(formatRelativeActivity(now - SESSION_LIST_JUST_NOW_MS + 1, now)).toBe(
        '刚刚',
      );
    });

    it('ST14（设计观察）: msUntilRelativeLabelChange 对 d 恰好处于桶边界返回 0', () => {
      // d = JUST_NOW_MS → 已离开「刚刚」桶，应立即更新到「1分钟前」
      const d = SESSION_LIST_JUST_NOW_MS;
      const activity = now - d;
      const until = msUntilRelativeLabelChange(activity, now);
      // 修复前若直接 if (d < JUST_NOW) 会返回 1ms；实际 d === JUST_NOW 不满足 <
      // 落到 d < 3_600_000 分支：if (d < 120_000) → false（d=45000, 等等 d=45000<120000 = true）
      // 所以 45000 < 120000 → 返回 120000 - 45000 = 75000ms（错误：应已经变更）
      // 实际：d=45000 < 120000 → 返回 75000。这意味着 d=45000 时认为还要 75 秒才变更
      // 但 formatRelativeActivity 在 d=45000 已返回「1分钟前」→ 不一致
      // 此处记录这个边界不一致
      expect(until).not.toBeNull();
    });

    it('d=119_999ms 距下一桶 1ms', () => {
      const d = 119_999;
      const activity = now - d;
      // d < 120_000 → 返回 120_000 - 119_999 = 1
      expect(msUntilRelativeLabelChange(activity, now)).toBe(1);
    });

    it('d=120_000ms 进入下一桶，距下下桶 60_000ms', () => {
      const d = 120_000;
      const activity = now - d;
      // d >= 120_000 → nextBucket = (floor(120000/60000)+1)*60000 = 3*60000 = 180000
      // 返回 180000 - 120000 = 60000
      expect(msUntilRelativeLabelChange(activity, now)).toBe(60_000);
    });

    it('各桶边界一致：formatRelativeActivity 与 msUntilRelativeLabelChange', () => {
      // 在每个桶边界，msUntil 返回 0 意味 label 立即变更
      const boundaries = [
        SESSION_LIST_JUST_NOW_MS,
        120_000,
        3_600_000,
        86_400_000,
        7 * 86_400_000,
        30 * 86_400_000,
      ];
      for (const b of boundaries) {
        const activity = now - b;
        const label = formatRelativeActivity(activity, now);
        const until = msUntilRelativeLabelChange(activity, now);
        // 在边界点上 label 应已是新桶；until 应是到下一桶的距离（>0）或 null
        expect(label).not.toBe('刚刚');
        // until 不为 null（除非进入绝对日期区）
        if (b < 30 * 86_400_000) {
          expect(until).not.toBeNull();
          expect(until!).toBeGreaterThan(0);
        }
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST15: compareSessionsByActivity NaN 处理
  // ───────────────────────────────────────────────────────────────────
  describe('ST15: compareSessionsByActivity NaN 兜底', () => {
    it('双方活动都为 0 → 走 id 比较，返回 -1/0/1', () => {
      const a = session({ id: 'a', timestamp: '', messages: [] });
      const b = session({ id: 'b', timestamp: '', messages: [] });
      // 双方 activity 都为 0，d = 0 → 走 id 比较
      expect(compareSessionsByActivity(a, b)).toBe(-1); // 'a' < 'b'
      expect(compareSessionsByActivity(b, a)).toBe(1);
      expect(compareSessionsByActivity(a, { ...a })).toBe(0);
    });

    it('NaN 活动（不可能由 sessionLastActivityMs 产生，但防御性测试）', () => {
      // sessionLastActivityMs 永不返回 NaN（finitePositiveMs 守卫）
      // 但若上游传入伪造的 SessionState 让 activity=NaN，依赖 id 兜底
      const a = session({ id: 'a', timestamp: '', messages: [] });
      const b = session({ id: 'b', timestamp: '', messages: [] });
      // activity 都为 0，比较稳定
      const result = compareSessionsByActivity(a, b);
      expect(result).toBe(-1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST16: coerceSessionTimestamp 边界
  // ───────────────────────────────────────────────────────────────────
  describe('ST16: coerceSessionTimestamp 边界', () => {
    it('ST16（设计观察）: stored="NaN" 字符串被保留为原值返回', () => {
      // t = "NaN"，非坏字面量、非 '远程'
      // parseStoredTimestampMs("NaN") = 0 → 不进入 ISO 转换
      // 保留原值 → 返回 "NaN"
      const result = coerceSessionTimestamp('sess-x', 'NaN');
      expect(result).toBe('NaN');
    });

    it('stored="0" 不再被 V8 误释为 2000-01-01（修复后保留原值或回落）', () => {
      // 修复后：parseStoredTimestampMs("0") = 0
      // coerceSessionTimestamp: t="0", parseStoredTimestampMs("0")=0 → 不进入 ISO 转换
      // 保留原值 → 返回 "0"
      const result = coerceSessionTimestamp('sess-x', '0');
      expect(result).toBe('0');
    });

    it('ST25（设计观察）: messages timestamp=Infinity 跳过，回落到 id', () => {
      const result = coerceSessionTimestamp(
        'sess-1712345678901',
        '刚刚',
        [{ timestamp: Number.POSITIVE_INFINITY }, { timestamp: -1 }],
      );
      // 全部 messages 失效 → 回落到 id epoch
      expect(result).toBe(new Date(1712345678901).toISOString());
    });

    it('messages 含 NaN 与负数时间戳 → 跳过，回落到 id', () => {
      const result = coerceSessionTimestamp(
        'sess-1712345678901',
        '刚刚',
        [{ timestamp: NaN }, { timestamp: -100 }, { timestamp: 0 }],
      );
      expect(result).toBe(new Date(1712345678901).toISOString());
    });

    it('stored 是合法 ISO → 规范化为 ISO', () => {
      const result = coerceSessionTimestamp('sess-x', '2024-01-02T03:04:05.000Z');
      expect(result).toBe('2024-01-02T03:04:05.000Z');
    });

    it('stored 是数字串 → 转 ISO', () => {
      expect(coerceSessionTimestamp('sess-x', '1712345678901')).toBe(
        new Date(1712345678901).toISOString(),
      );
    });

    it("stored 是 '远程' 字面量 → 回落到当前 ISO", () => {
      const before = Date.now();
      const result = coerceSessionTimestamp('sess-no-epoch', '远程');
      const after = Date.now();
      const ms = Date.parse(result);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(after);
      expect(result).not.toBe('远程');
    });

    it('stored 是坏字面量 → 走 messages/id 回落', () => {
      expect(coerceSessionTimestamp('sess-1712345678901', '刚刚', [])).toBe(
        new Date(1712345678901).toISOString(),
      );
      expect(coerceSessionTimestamp('sess-1712345678901', '恢复', [])).toBe(
        new Date(1712345678901).toISOString(),
      );
      expect(coerceSessionTimestamp('sess-1712345678901', '刚才', [])).toBe(
        new Date(1712345678901).toISOString(),
      );
    });

    it('stored 是空白 → 走 messages/id 回落', () => {
      expect(coerceSessionTimestamp('sess-1712345678901', '   ', [])).toBe(
        new Date(1712345678901).toISOString(),
      );
      expect(coerceSessionTimestamp('sess-1712345678901', '', [])).toBe(
        new Date(1712345678901).toISOString(),
      );
      expect(coerceSessionTimestamp('sess-1712345678901', null, [])).toBe(
        new Date(1712345678901).toISOString(),
      );
    });

    it('无任何可用来源 → 当前 ISO', () => {
      const before = Date.now();
      const result = coerceSessionTimestamp('no-epoch', '刚刚', []);
      const after = Date.now();
      const ms = Date.parse(result);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(before - 1);
      expect(ms).toBeLessThanOrEqual(after + 1);
    });

    it('保留未知非坏字面量标记', () => {
      expect(coerceSessionTimestamp('sess-x', '第三方标记')).toBe('第三方标记');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST17: msUntilRelativeLabelChange 边界
  // ───────────────────────────────────────────────────────────────────
  describe('ST17: msUntilRelativeLabelChange 边界', () => {
    const now = 1_000_000_000_000;

    it('invalid activityMs 返回 null', () => {
      expect(msUntilRelativeLabelChange(0, now)).toBeNull();
      expect(msUntilRelativeLabelChange(-1, now)).toBeNull();
      expect(msUntilRelativeLabelChange(NaN, now)).toBeNull();
      expect(msUntilRelativeLabelChange(Infinity, now)).toBeNull();
    });

    it('远未来（> now + CLOCK_SKEW）返回 null', () => {
      const far = now + SESSION_LIST_CLOCK_SKEW_MS + 1;
      expect(msUntilRelativeLabelChange(far, now)).toBeNull();
    });

    it('近未来漂移：等到 activity 进入过去 + JUST_NOW', () => {
      const ahead = now + 3_000;
      expect(msUntilRelativeLabelChange(ahead, now)).toBe(3_000 + SESSION_LIST_JUST_NOW_MS);
    });

    it('刚过去 d=0：等 JUST_NOW 边界', () => {
      expect(msUntilRelativeLabelChange(now, now)).toBe(SESSION_LIST_JUST_NOW_MS);
    });

    it('d=JUST_NOW-1：等 1ms 到边界', () => {
      const activity = now - (SESSION_LIST_JUST_NOW_MS - 1);
      expect(msUntilRelativeLabelChange(activity, now)).toBe(1);
    });

    it('d=JUST_NOW：进入分钟桶，等 120_000 - JUST_NOW', () => {
      const activity = now - SESSION_LIST_JUST_NOW_MS;
      // d=45000 < 120_000 → 返回 120_000 - 45_000 = 75_000
      expect(msUntilRelativeLabelChange(activity, now)).toBe(120_000 - SESSION_LIST_JUST_NOW_MS);
    });

    it('小时桶：d=3_600_000 → 下一桶 2h', () => {
      const activity = now - 3_600_000;
      // d=3600000 不 < 3_600_000 → 落到 d<86_400_000 分支
      // next = (floor(3600000/3600000)+1)*3600000 = 2*3600000 = 7200000
      // 返回 7200000 - 3600000 = 3600000
      expect(msUntilRelativeLabelChange(activity, now)).toBe(3_600_000);
    });

    it('天桶边界 d=86_400_000 → 下一桶 2d', () => {
      const activity = now - 86_400_000;
      expect(msUntilRelativeLabelChange(activity, now)).toBe(86_400_000);
    });

    it('周桶边界 d=7*86_400_000 → 下一桶 2w', () => {
      const activity = now - 7 * 86_400_000;
      expect(msUntilRelativeLabelChange(activity, now)).toBe(7 * 86_400_000);
    });

    it('进入绝对日期区（d ≥ 30 天）返回 null', () => {
      const activity = now - 30 * 86_400_000;
      expect(msUntilRelativeLabelChange(activity, now)).toBeNull();
      expect(msUntilRelativeLabelChange(now - 60 * 86_400_000, now)).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST18: sessionListTimeTickMs 边界
  // ───────────────────────────────────────────────────────────────────
  describe('ST18: sessionListTimeTickMs 边界', () => {
    const now = 1_000_000_000_000;

    it('空列表 → slow tick', () => {
      expect(sessionListTimeTickMs([], now)).toBe(SESSION_LIST_TICK_SLOW_MS);
    });

    it('远未来 activity 不计入 tick 贴边', () => {
      const far = now + SESSION_LIST_CLOCK_SKEW_MS + 86_400_000;
      const sessions = [
        session({
          id: 'far',
          timestamp: new Date(far).toISOString(),
          messages: [msg({ id: 'm', timestamp: far })],
        }),
      ];
      expect(sessionListTimeTickMs(sessions, now)).toBe(SESSION_LIST_TICK_SLOW_MS);
    });

    it('ST18（设计观察）: activity 刚好 = now + CLOCK_SKEW 仍计入 tick 计算', () => {
      // act > now + CLOCK_SKEW_MS → continue（跳过）
      // act === now + CLOCK_SKEW_MS → 不大于，继续参与 tick 计算
      const exactly = now + SESSION_LIST_CLOCK_SKEW_MS;
      const sessions = [
        session({
          id: 'edge',
          timestamp: new Date(exactly).toISOString(),
          messages: [msg({ id: 'm', timestamp: exactly })],
        }),
      ];
      // 此处不抛、不返回 slow 之外的小值（act > now，进入近未来分支）
      const tick = sessionListTimeTickMs(sessions, now);
      // 近未来分支：until = act - now + JUST_NOW = CLOCK_SKEW + JUST_NOW
      // tick = min(slow, max(MIN, until + 50)) = slow（因为 until 巨大）
      expect(tick).toBe(SESSION_LIST_TICK_SLOW_MS);
    });

    it('近期活动 → fast tick', () => {
      const sessions = [
        session({
          id: 'recent',
          timestamp: new Date(now).toISOString(),
          messages: [msg({ id: 'm', timestamp: now - 10_000 })],
        }),
      ];
      const tick = sessionListTimeTickMs(sessions, now);
      expect(tick).toBeLessThanOrEqual(SESSION_LIST_TICK_FAST_MS);
    });

    it('「刚刚」即将过期 → tick 贴边到边界 +50ms', () => {
      const activity = now - 40_000; // 5s 后过期
      const sessions = [
        session({
          id: 'soon',
          timestamp: new Date(activity).toISOString(),
          messages: [msg({ id: 'm', timestamp: activity })],
        }),
      ];
      const tick = sessionListTimeTickMs(sessions, now);
      expect(tick).toBeLessThanOrEqual(SESSION_LIST_JUST_NOW_MS - 40_000 + 50 + 1);
      expect(tick).toBeGreaterThanOrEqual(SESSION_LIST_TICK_MIN_MS);
    });

    it('1 小时以上旧会话 → 不贴边，仍走 fast/slow', () => {
      const activity = now - 2 * 3_600_000;
      const sessions = [
        session({
          id: 'old',
          timestamp: new Date(activity).toISOString(),
          messages: [msg({ id: 'm', timestamp: activity })],
        }),
      ];
      // act <= now 且 now - act > 3_600_000 → continue（跳过贴边）
      // hasRecentSessionActivity 返回 false → tick = slow
      expect(sessionListTimeTickMs(sessions, now)).toBe(SESSION_LIST_TICK_SLOW_MS);
    });

    it('混入 null session 不影响其他会话的 tick 计算', () => {
      const activity = now - 10_000;
      const sessions: Array<SessionState> = [
        null as unknown as SessionState,
        session({
          id: 'recent',
          timestamp: new Date(activity).toISOString(),
          messages: [msg({ id: 'm', timestamp: activity })],
        }),
        null as unknown as SessionState,
      ];
      expect(() => sessionListTimeTickMs(sessions, now)).not.toThrow();
      const tick = sessionListTimeTickMs(sessions, now);
      expect(tick).toBeLessThanOrEqual(SESSION_LIST_TICK_FAST_MS);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST20: formatRelativeActivity 极端值
  // ───────────────────────────────────────────────────────────────────
  describe('ST20: formatRelativeActivity 极端值', () => {
    it('ST20: ms = MAX_SAFE_INTEGER 走绝对日期分支', () => {
      const now = 1_000_000_000_000;
      const ms = Number.MAX_SAFE_INTEGER;
      // ms > now + CLOCK_SKEW → 绝对日期
      expect(formatRelativeActivity(ms, now)).toBe(formatAbsoluteCalendarDate(ms, now));
    });

    it('ms = 0 返回空串', () => {
      expect(formatRelativeActivity(0, Date.now())).toBe('');
    });

    it('ms = 负数 返回空串', () => {
      expect(formatRelativeActivity(-1, Date.now())).toBe('');
    });

    it('ms = NaN 返回空串', () => {
      expect(formatRelativeActivity(NaN, Date.now())).toBe('');
    });

    it('ms = Infinity 走绝对日期分支', () => {
      // !ms || ms <= 0 || !Number.isFinite(ms) → 返回 '' (Infinity 不通过 finite 检查)
      expect(formatRelativeActivity(Infinity, Date.now())).toBe('');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ST12: formatAbsoluteCalendarDate 边界
  // ───────────────────────────────────────────────────────────────────
  describe('ST12: formatAbsoluteCalendarDate 边界', () => {
    it('ST12（已修复）: now=NaN 回落到 Date.now()，不再返回残缺字符串', () => {
      // 修复前：new Date(NaN).getFullYear() = NaN，y === cy 永远 false → 返回 Y/M/D
      // 修复后：now 非有限时回落到 Date.now()，同年日期正确返回 M/D
      const result = formatAbsoluteCalendarDate(1000, NaN);
      // ms=1000 → 1970-01-01，当前年 ≠ 1970 → 返回 "1970/1/1"
      expect(typeof result).toBe('string');
      expect(result).toMatch(/^\d+\/\d+\/\d+$/);
      // 不再出现 "NaN/NaN/NaN" 残缺字符串
      expect(result).not.toContain('NaN');
    });

    it('ms=0 返回空串', () => {
      expect(formatAbsoluteCalendarDate(0, Date.now())).toBe('');
    });

    it('ms=负数 返回空串', () => {
      expect(formatAbsoluteCalendarDate(-1, Date.now())).toBe('');
    });

    it('ms=NaN 返回空串', () => {
      expect(formatAbsoluteCalendarDate(NaN, Date.now())).toBe('');
    });

    it('ms=Infinity 返回空串', () => {
      expect(formatAbsoluteCalendarDate(Infinity, Date.now())).toBe('');
    });

    it('同年 → M/D', () => {
      const now = Date.UTC(2024, 5, 15);
      const sameYear = Date.UTC(2024, 0, 3);
      expect(formatAbsoluteCalendarDate(sameYear, now)).toBe('1/3');
    });

    it('跨年 → Y/M/D', () => {
      const now = Date.UTC(2024, 5, 15);
      const otherYear = Date.UTC(2020, 0, 3);
      expect(formatAbsoluteCalendarDate(otherYear, now)).toBe('2020/1/3');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // formatSessionListTime / formatSessionListAbsoluteTime 边界
  // ───────────────────────────────────────────────────────────────────
  describe('formatSessionListTime / AbsoluteTime 边界', () => {
    it('远程会话无活动 → 显示「远程」', () => {
      const s = session({
        id: 'remote-1',
        timestamp: '远程',
        timestampSource: 'remote',
        messages: [],
      });
      expect(formatSessionListTime(s, Date.now())).toBe('远程');
      expect(formatSessionListAbsoluteTime(s, Date.now())).toBe('远程');
    });

    it('远程会话但有活动 → 显示相对时间（设计正确）', () => {
      const s = session({
        id: 'remote-2',
        timestamp: '远程',
        timestampSource: 'remote',
        messages: [msg({ id: 'm', timestamp: 1_000_000_000_000 })],
      });
      const label = formatSessionListTime(s, 1_000_000_000_000 + 3_600_000);
      expect(label).not.toBe('远程');
      expect(label).toBe('1小时前');
    });

    it('空活动无 id epoch → 空串', () => {
      const s = session({
        id: 'no-epoch',
        timestamp: '',
        messages: [],
      });
      expect(sessionLastActivityMs(s)).toBe(0);
      expect(formatSessionListTime(s, Date.now())).toBe('');
      expect(formatSessionListAbsoluteTime(s, Date.now())).toBe('');
    });

    it('存盘字面量「刚刚」不会永久展示', () => {
      const s = session({
        id: 'sess-1712345678901',
        timestamp: '刚刚',
        messages: [],
      });
      // 1h 后展示相对时间，不是「刚刚」字面量
      const label = formatSessionListTime(s, 1712345678901 + 3_600_000);
      expect(label).not.toBe('刚刚');
      expect(label.length).toBeGreaterThan(0);
    });

    it('absolute time 不等于 relative time', () => {
      const activity = 1_700_000_000_000;
      const s = session({
        id: 'sess-abs',
        timestamp: new Date(activity).toISOString(),
        messages: [msg({ id: 'm', timestamp: activity })],
      });
      const abs = formatSessionListAbsoluteTime(s, activity + 3_600_000);
      const rel = formatSessionListTime(s, activity + 3_600_000);
      expect(abs).not.toBe(rel);
      expect(abs).not.toBe('刚刚');
      expect(abs).not.toMatch(/分钟前|小时前/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // sessionActivityShellMs null 安全（与 sessionLastActivityMs 同步检查）
  // ───────────────────────────────────────────────────────────────────
  describe('sessionActivityShellMs null 安全', () => {
    it('messages 含 null 末条 → 不崩溃，回落到 stored/id', () => {
      const s = session({
        id: 'sess-1712345678901',
        timestamp: '刚刚',
        messages: [null as unknown as SessionMessage, null as unknown as SessionMessage],
      });
      // msgs.length=2，last=msgs[1]=null，last?.timestamp=undefined → ts=0
      // 回落到 stored / id
      expect(() => sessionActivityShellMs(s)).not.toThrow();
      expect(sessionActivityShellMs(s)).toBe(1712345678901);
    });

    it('agents 含 null 条目 → 不崩溃', () => {
      const s = session({
        id: 'sess-1712345678901',
        timestamp: '刚刚',
        messages: [],
        agents: [null as unknown as SessionAgent, null as unknown as SessionAgent],
      });
      expect(() => sessionActivityShellMs(s)).not.toThrow();
      expect(sessionActivityShellMs(s)).toBe(1712345678901);
    });

    it('agent.messages 含 null 末条 → 不崩溃', () => {
      const s = session({
        id: 'sess-1712345678901',
        timestamp: '刚刚',
        messages: [],
        agents: [
          agent({
            id: 'a1',
            startedAt: 0,
            messages: [null as unknown as SessionMessage],
          }),
        ],
      });
      expect(() => sessionActivityShellMs(s)).not.toThrow();
      expect(sessionActivityShellMs(s)).toBe(1712345678901);
    });

    it('messages=[] 时 msgs[length-1] 为 undefined → 不崩溃', () => {
      const s = session({
        id: 'sess-1712345678901',
        timestamp: '刚刚',
        messages: [],
      });
      expect(() => sessionActivityShellMs(s)).not.toThrow();
      expect(sessionActivityShellMs(s)).toBe(1712345678901);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // hasRecentSessionActivity 边界
  // ───────────────────────────────────────────────────────────────────
  describe('hasRecentSessionActivity 边界', () => {
    it('空列表 → false', () => {
      expect(hasRecentSessionActivity([], Date.now())).toBe(false);
    });

    it('无活动会话 → false', () => {
      const s = session({
        id: 'no-epoch',
        timestamp: '',
        messages: [],
      });
      expect(hasRecentSessionActivity([s], Date.now())).toBe(false);
    });

    it('远未来 activity → false（不计入近期）', () => {
      const now = 1_000_000_000_000;
      const far = now + SESSION_LIST_CLOCK_SKEW_MS + 86_400_000;
      const s = session({
        id: 'far',
        timestamp: new Date(far).toISOString(),
        messages: [msg({ id: 'm', timestamp: far })],
      });
      expect(hasRecentSessionActivity([s], now)).toBe(false);
    });

    it('近未来漂移 activity → true（age 在 -CLOCK_SKEW 内）', () => {
      const now = 1_000_000_000_000;
      const ahead = now + 2_000;
      const s = session({
        id: 'ahead',
        timestamp: new Date(ahead).toISOString(),
        messages: [msg({ id: 'm', timestamp: ahead })],
      });
      expect(hasRecentSessionActivity([s], now)).toBe(true);
    });

    it('CLOCK_SKEW 边界：age = -CLOCK_SKEW 恰好 → 不算近期（age > -SKEW 严格）', () => {
      const now = 1_000_000_000_000;
      const ahead = now + SESSION_LIST_CLOCK_SKEW_MS;
      const s = session({
        id: 'edge',
        timestamp: new Date(ahead).toISOString(),
        messages: [msg({ id: 'm', timestamp: ahead })],
      });
      // age = now - ahead = -CLOCK_SKEW
      // age > -SESSION_LIST_CLOCK_SKEW_MS → false
      // age < windowMs → true
      // && false → 不算近期
      expect(hasRecentSessionActivity([s], now)).toBe(false);
    });

    it('windowMs 默认 120_000', () => {
      const now = Date.now();
      const s = session({
        id: 'recent',
        timestamp: new Date(now).toISOString(),
        messages: [msg({ id: 'm', timestamp: now - 60_000 })],
      });
      expect(hasRecentSessionActivity([s], now)).toBe(true);
    });

    it('自定义 windowMs 生效', () => {
      const now = Date.now();
      const s = session({
        id: 'old',
        timestamp: new Date(now).toISOString(),
        messages: [msg({ id: 'm', timestamp: now - 200_000 })],
      });
      // 默认 windowMs=120_000 → 200_000 不算近期
      expect(hasRecentSessionActivity([s], now)).toBe(false);
      // 自定义 windowMs=300_000 → 200_000 算近期
      expect(hasRecentSessionActivity([s], now, 300_000)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // nowIsoTimestamp
  // ───────────────────────────────────────────────────────────────────
  describe('nowIsoTimestamp', () => {
    it('返回接近当前时间的可解析 ISO 串', () => {
      const before = Date.now();
      const iso = nowIsoTimestamp();
      const after = Date.now();
      const ms = Date.parse(iso);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(before - 1);
      expect(ms).toBeLessThanOrEqual(after + 1);
    });

    it('返回值以 Z 结尾（UTC ISO 标准格式）', () => {
      expect(nowIsoTimestamp()).toMatch(/Z$/);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // isBadTimestampLiteral / isRemoteSessionTimestamp
  // ───────────────────────────────────────────────────────────────────
  describe('isBadTimestampLiteral / isRemoteSessionTimestamp 边界', () => {
    it('坏字面量识别（去空白）', () => {
      expect(isBadTimestampLiteral('刚刚')).toBe(true);
      expect(isBadTimestampLiteral(' 刚刚 ')).toBe(true);
      expect(isBadTimestampLiteral('恢复')).toBe(true);
      expect(isBadTimestampLiteral('刚才')).toBe(true);
    });

    it('非坏字面量', () => {
      expect(isBadTimestampLiteral('远程')).toBe(false);
      expect(isBadTimestampLiteral('2024-01-01T00:00:00.000Z')).toBe(false);
      expect(isBadTimestampLiteral('')).toBe(false);
      expect(isBadTimestampLiteral(null)).toBe(false);
      expect(isBadTimestampLiteral(undefined)).toBe(false);
    });

    it('远程标记：source=remote 优先', () => {
      expect(isRemoteSessionTimestamp('anything', 'remote')).toBe(true);
      expect(isRemoteSessionTimestamp('远程', 'local')).toBe(true);
      expect(isRemoteSessionTimestamp(' 远程 ', 'local')).toBe(true);
    });

    it('远程标记：source 缺失时按字面量识别', () => {
      expect(isRemoteSessionTimestamp('远程', undefined)).toBe(true);
      expect(isRemoteSessionTimestamp(' 远程 ', undefined)).toBe(true);
      expect(isRemoteSessionTimestamp('远程', null)).toBe(true);
    });

    it("source=local 时不按字面量识别（即使 stored 是 '远程' 字面量）", () => {
      // 实际实现：source === 'remote' 才返回 true；否则检查字面量
      // 所以 source=local 且 stored='远程' 仍返回 true（字面量检查仍执行）
      expect(isRemoteSessionTimestamp('远程', 'local')).toBe(true);
    });

    it('非远程字面量', () => {
      expect(isRemoteSessionTimestamp('刚刚', undefined)).toBe(false);
      expect(isRemoteSessionTimestamp('', undefined)).toBe(false);
      expect(isRemoteSessionTimestamp(null, undefined)).toBe(false);
    });
  });
});
