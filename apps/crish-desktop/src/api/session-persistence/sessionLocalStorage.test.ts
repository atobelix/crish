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
 * localStorage.setItem 抛错触发截断分支；logInternalError 仅 spy 观测。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../../store/layoutStore';
import * as userFacingErrors from '../userFacingErrors';
import {
  loadSessionBody,
  saveSessionBody,
} from './sessionLocalStorage';
import { hasQuotaTruncation, markQuotaTruncated } from './sessionQuota';
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

/**
 * 用可释放的假 localStorage 模拟 quota：仅第一次 setItem 抛 QuotaExceededError，
 * 后续写入落盘（fallback 与标志写入可走）；release() 后完全不再抛（quota 释放）。
 *
 * 为何整体替换全局 localStorage（vi.stubGlobal）而非在 setItem 上安 spy：两种测试
 * 环境对 localStorage 的实现各不相同，任何单一 spy 目标都无法两边同时命中——
 *   - 根 unit 项目：vitest.setup.ts 用普通对象覆盖 globalThis.localStorage（方法为
 *     自身属性），spyOn(Storage.prototype) 永远不触发（原回归根因，截断分支走不到）；
 *   - app-dir jsdom：localStorage 是 Proxy 形态的 Storage 实例（setItem 在原型上），
 *     实例级 vi.spyOn 与 Object.defineProperty 均静默不生效（不产生 own property），
 *     只有 Storage.prototype 拦截才命中。
 * vi.stubGlobal 从全局替换整个存储对象：生产代码每次调用都是全局属性查找，两种环境
 * 都命中；afterEach 用 unstubAllGlobals 还原环境原生存储，不污染后续文件。
 */
type QuotaHarness = {
  /** quota 释放：此后 setItem 不再抛错（同存储对象继续使用，恢复语义真实）。 */
  release: () => void;
};

function installFirstWriteThrowsQuota(): QuotaHarness {
  const store = new Map<string, string>();
  let throws = true;
  let callCount = 0;
  const storage: Storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (throws && callCount++ === 0) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('localStorage', storage);
  return {
    release: () => {
      throws = false;
    },
  };
}

describe('P1-F3：LS quota 截断标志与恢复（T5.3）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    const harness = installFirstWriteThrowsQuota();
    saveSessionBody('s3', msgs(120));
    expect(hasQuotaTruncation('s3')).toBe(true);
    // 恢复：存储不再抛错，再次全量写成功（同一存储对象，非换底）
    harness.release();

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
