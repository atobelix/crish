// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isSameOriginRequest } from '../../dev-server/sameOriginRequest';

function req(headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe('isSameOriginRequest 正式同源策略', () => {
  it('Origin.host 匹配 Host → 放行', () => {
    expect(
      isSameOriginRequest(
        req({ host: '127.0.0.1:5174', origin: 'http://127.0.0.1:5174' })
      )
    ).toBe(true);
  });

  it('Origin 跨站 → 拒绝', () => {
    expect(
      isSameOriginRequest(
        req({ host: '127.0.0.1:5174', origin: 'https://evil.example' })
      )
    ).toBe(false);
  });

  it('缺 Origin 且无其它同源信号 → 拒绝（禁隐式宽松）', () => {
    expect(isSameOriginRequest(req({ host: '127.0.0.1:5174' }))).toBe(false);
  });

  it('缺 Origin + Sec-Fetch-Site=same-origin → 放行', () => {
    expect(
      isSameOriginRequest(
        req({ host: '127.0.0.1:5174', 'sec-fetch-site': 'same-origin' })
      )
    ).toBe(true);
  });

  it('缺 Origin + Referer 同源 → 放行', () => {
    expect(
      isSameOriginRequest(
        req({
          host: '127.0.0.1:5174',
          referer: 'http://127.0.0.1:5174/app',
        })
      )
    ).toBe(true);
  });

  it('缺 Host → 拒绝', () => {
    expect(isSameOriginRequest(req({ origin: 'http://127.0.0.1:5174' }))).toBe(
      false
    );
  });
});
