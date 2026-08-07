// @vitest-environment jsdom
/**
 * P1-F3（F5-03）：LS quota 超限静默截断 → 截断标志 + 恢复清除 + 数据面提示（T5.3）。
 *
 * 复现缺陷：saveSessionBody 主 setItem 抛 QuotaExceededError → slice(-100) fallback
 * 静默落盘，无任何标志/日志/用户提示；quota 释放后再次全量写成功也不清除旧截断态。
 *
 * 用例（先红后绿）：
 * 1. 首次 setItem 抛 QuotaExceededError → saveSessionBody(>100 条) → 截断标志置位
 *    （hasQuotaTruncation(id)===true）——当前无标志 API → 红；
 * 2. 截断后 loadSessionBody 返回最后 100 条（现状 slice(-100) 行为固化为回归断言）；
 * 3. 恢复：spy 恢复正常 → 再次 saveSessionBody 全量成功 → 截断标志清除
 *    （hasQuotaTruncation(id)===false）——当前无清除逻辑 → 红；
 * 4. 标志存在时 hydrate 链（sessionRustDb.loadSessionBody）触发
 *    logInternalError('ls-quota-truncated') 且数据面暴露截断标志——当前无 → 红。
 *
 * 防作弊约束（T5.3 条款）：不 mock slice(-100)、不绕过 catch——经真实
 * Storage.prototype.setItem 抛错触发截断分支；logInternalError 仅 spy 观测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../../store/layoutStore';
import * as userFacingErrors from '../userFacingErrors';
import {
  hasQuotaTruncation,
  loadSessionBody,
  markQuotaTruncated,
  saveSessionBody,
} from './sessionLocalStorage';
import { loadSessionBody as loadSessionBodyRust } from './sessionRustDb';

const SESSION_BODY_PREFIX = 'crish_session_body_v1:';

/** 构造 n 条消息（从 start 起编号，便于断言截断保留的是尾部）。 */
function msgs(n: number, start = 0): SessionMessage[] {
  const out: SessionMessage[] = [];
  for (let i = start; i < start + n; i++) {
    out.push({
      id: `m${i}`,
      sender: i % 2 === 0 ? 'user' : 'assistant',
      timestamp: 1_700_000_000_000 + i,
      text: `text-${i}`,
    });
  }
  return out;
}

/** 仅第一次 setItem 抛 QuotaExceededError，后续调用走原始实现（fallback 与标志写入可落盘）。 */
function installFirstWriteThrowsQuota(): void {
  const original = Storage.prototype.setItem;
  let callCount = 0;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string
  ) {
    callCount++;
    if (callCount === 1) {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    }
    return original.call(this, key, value);
  });
}

describe('P1-F3：LS quota 截断标志与恢复（T5.3）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. quota 超限截断后置标志：hasQuotaTruncation(id)===true（先红：当前无标志）', () => {
    installFirstWriteThrowsQuota();

    saveSessionBody('s1', msgs(120));

    // 修复前：saveSessionBody 截断分支无任何标志写入 → 该 API 不存在，用例红
    expect(hasQuotaTruncation('s1')).toBe(true);
  });

  it('2. 截断后 loadSessionBody 返回最后 100 条（现状 slice(-100) 行为固化回归）', () => {
    installFirstWriteThrowsQuota();

    const body = msgs(120);
    saveSessionBody('s2', body);

    const loaded = loadSessionBody('s2');
    expect(loaded).toHaveLength(100);
    expect(loaded.map((m) => m.id)).toEqual(body.slice(-100).map((m) => m.id));
  });

  it('3. quota 释放后全量写成功 → 截断标志清除（先红：当前无恢复清除）', () => {
    // 前置：制造一次截断（标志置位）
    installFirstWriteThrowsQuota();
    saveSessionBody('s3', msgs(120));
    expect(hasQuotaTruncation('s3')).toBe(true);
    vi.restoreAllMocks();

    // 恢复：存储不再抛错，再次全量写成功
    saveSessionBody('s3', msgs(120));

    // 修复前：主 setItem 成功路径无 clearQuotaTruncation → 标志残留，用例红
    expect(hasQuotaTruncation('s3')).toBe(false);
    // 正文恢复为全量 120 条（非截断态）
    expect(loadSessionBody('s3')).toHaveLength(120);
  });

  it('4. 标志存在时 hydrate 链触发 ls-quota-truncated 日志 + 数据面暴露（先红：当前无日志）', async () => {
    // 模拟历史截断留下的标志（数据面状态）
    markQuotaTruncated('s4');
    // 截断态落盘：LS 正文仅剩最后 100 条
    localStorage.setItem(SESSION_BODY_PREFIX + 's4', JSON.stringify(msgs(100)));
    const logSpy = vi.spyOn(userFacingErrors, 'logInternalError');

    // hydrate 链（invoke 未注册 → missing → LS 回退正文）
    const body = await loadSessionBodyRust('s4');

    // 修复前：sessionRustDb.loadSessionBody 不读标志、无日志 → logSpy 未调用，用例红
    expect(logSpy).toHaveBeenCalledWith('ls-quota-truncated', {
      sessionId: 's4',
    });
    // 数据面暴露：截断标志可被 hydrate/UI 层读取
    expect(hasQuotaTruncation('s4')).toBe(true);
    expect(body).toHaveLength(100);
  });
});
