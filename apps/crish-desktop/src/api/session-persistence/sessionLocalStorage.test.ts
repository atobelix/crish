// @vitest-environment jsdom
/**
 * P1-F3（F5-03）：LS quota 超限静默截断 → 截断标志 + 恢复清除 + 数据面提示。
 *
 * D-F06 后生产无 LS 正文写口；本文件用**内联历史写 helper**固化
 * 「截断标志」契约（sessionQuota），并验证 hydrate 链不再回退 LS 正文。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../../store/layoutStore';
import * as userFacingErrors from '../userFacingErrors';
import { loadSessionBody } from './sessionLocalStorage';
import {
  clearQuotaTruncation,
  hasQuotaTruncation,
  markQuotaTruncated,
} from './sessionQuota';
import { loadSessionBody as loadSessionBodyRust } from './sessionRustDb';

const SESSION_BODY_PREFIX = 'crish_session_body_v1:';

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

/** 历史 LS 正文写（配额截断契约专用；生产权威=SQLite，不在此路径）。 */
function writeLegacyBodyWithQuota(id: string, messages: SessionMessage[]): void {
  const key = SESSION_BODY_PREFIX + id;
  try {
    localStorage.setItem(key, JSON.stringify(messages));
    clearQuotaTruncation(id);
  } catch {
    const fallback = messages.slice(-100);
    try {
      localStorage.setItem(key, JSON.stringify(fallback));
      markQuotaTruncated(id);
    } catch {
      /* swallow */
    }
  }
}

type QuotaHarness = { release: () => void };

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

describe('P1-F3：LS quota 截断标志（历史契约）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('1. quota 超限截断后置标志', () => {
    installFirstWriteThrowsQuota();
    writeLegacyBodyWithQuota('s1', msgs(120));
    expect(hasQuotaTruncation('s1')).toBe(true);
  });

  it('2. 截断后 loadSessionBody 返回最后 100 条', () => {
    installFirstWriteThrowsQuota();
    const body = msgs(120);
    writeLegacyBodyWithQuota('s2', body);
    const loaded = loadSessionBody('s2');
    expect(loaded).toHaveLength(100);
    expect(loaded.map((m) => m.id)).toEqual(body.slice(-100).map((m) => m.id));
  });

  it('3. quota 释放后全量写成功 → 截断标志清除', () => {
    const harness = installFirstWriteThrowsQuota();
    writeLegacyBodyWithQuota('s3', msgs(120));
    expect(hasQuotaTruncation('s3')).toBe(true);
    harness.release();
    writeLegacyBodyWithQuota('s3', msgs(120));
    expect(hasQuotaTruncation('s3')).toBe(false);
    expect(loadSessionBody('s3')).toHaveLength(120);
  });

  it('4. 标志存在时 hydrate 链触发日志；D-F06 后不回退 LS 正文', async () => {
    markQuotaTruncated('s4');
    localStorage.setItem(SESSION_BODY_PREFIX + 's4', JSON.stringify(msgs(100)));
    const logSpy = vi.spyOn(userFacingErrors, 'logInternalError');
    const body = await loadSessionBodyRust('s4');
    expect(logSpy).toHaveBeenCalledWith('ls-quota-truncated', {
      sessionId: 's4',
    });
    expect(hasQuotaTruncation('s4')).toBe(true);
    expect(body).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith(
      'persist-degraded-ls',
      expect.objectContaining({
        command: 'load_session_body',
        sessionId: 's4',
      })
    );
  });
});
