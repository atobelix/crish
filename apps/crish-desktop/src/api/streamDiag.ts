/**
 * 流/运行中断诊断：控制台 + 环形缓冲，便于用户反馈「不知道为什么断」。
 * 不写入助手气泡，避免污染对话。
 */

import { normalizeErrorText } from './userFacingErrors';

export type StreamDiagEntry = {
  at: number;
  sessionId?: string | undefined;
  runId?: string | undefined;
  scope: string;
  kind?: string | undefined;
  /** 用户向短句 */
  message: string;
  /** 原始技术细节（截断） */
  raw?: string | undefined;
  /** 额外上下文（末工具名、检查点等） */
  context?: Record<string, string | number | boolean | null | undefined> | undefined;
};

const MAX = 40;
const ring: StreamDiagEntry[] = [];

export function recordStreamDiag(entry: Omit<StreamDiagEntry, 'at'> & { at?: number }): StreamDiagEntry {
  const full: StreamDiagEntry = {
    at: entry.at ?? Date.now(),
    sessionId: entry.sessionId,
    runId: entry.runId,
    scope: entry.scope,
    kind: entry.kind,
    message: entry.message,
    raw: entry.raw ? clip(entry.raw, 500) : undefined,
    context: entry.context,
  };
  ring.push(full);
  if (ring.length > MAX) ring.splice(0, ring.length - MAX);
  try {
    // 结构化日志，DevTools 可过滤 [crish-stream]
    console.warn('[crish-stream]', {
      scope: full.scope,
      kind: full.kind,
      message: full.message,
      runId: full.runId,
      sessionId: full.sessionId,
      raw: full.raw,
      context: full.context,
      at: new Date(full.at).toISOString(),
    });
  } catch {
    /* ignore */
  }
  // 浏览器调试：window.__crishStreamDiag()
  try {
    if (typeof window !== 'undefined') {
      (window as unknown as { __crishStreamDiag?: () => StreamDiagEntry[] }).__crishStreamDiag =
        getRecentStreamDiags;
    }
  } catch {
    /* ignore */
  }
  return full;
}

export function getRecentStreamDiags(): StreamDiagEntry[] {
  return ring.slice();
}

export function getLastStreamDiag(): StreamDiagEntry | null {
  return ring.length ? ring[ring.length - 1]! : null;
}

function clip(s: string, n: number): string {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/**
 * 把原始失败收成「用户可读主句 + 可选技术 detail」。
 * detail 给横幅第二行 / 控制台，主句保持冷静。
 */
export function formatRunFailureForUi(
  raw: unknown,
  scope: string,
): { message: string; detail: string; kindTag: string } {
  const tech = normalizeErrorText(raw).trim();
  const kindTag = scope || 'ended';
  // 常见英文/引擎句 → 中文主句
  let message = '这一轮任务中断了。';
  if (/timeout|timed?\s*out|ETIMEDOUT/i.test(tech)) {
    message = '执行超时中断了，可缩短单步命令或稍后重试。';
  } else if (/cancel|stopp?ed|abort|user/i.test(tech)) {
    message = '本轮已停止。';
  } else if (/network|disconnect|econn|offline/i.test(tech)) {
    message = '与引擎的连接中断了，正在恢复后可重试。';
  } else if (/context|token|too long|max.?turn|length/i.test(tech)) {
    message = '上下文或轮次过长导致中断，可新开会话或缩短任务。';
  } else if (/checkpoint/i.test(tech)) {
    message = '检查点步骤后运行中断了，详见下方诊断。';
  } else if (/rate.?limit|429|quota/i.test(tech)) {
    message = '模型限流或额度不足，请稍后再试。';
  } else if (tech) {
    message = '这一轮没有顺利完成，请查看诊断信息后重试。';
  }

  const detailParts = [
    scope ? `位置：${scope}` : '',
    tech ? `原因：${clip(tech, 180)}` : '原因：引擎未返回具体错误（可能正常收口或静默失败）',
  ].filter(Boolean);

  return {
    message,
    detail: detailParts.join(' · '),
    kindTag,
  };
}
