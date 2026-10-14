import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  activate,
  SESSION_START_USAGE_NOTE,
  type PluginActivateApi,
} from '../activate';
import { manifest } from '../manifest';
import { parseClaudeCodeTool } from '../tools';
import type { SessionImportPayload } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeFakeApi() {
  const log =
    vi.fn<
      (
        level: string,
        message: string,
        metadata?: Record<string, unknown>
      ) => void
    >();
  const observe = vi.fn<
    (
      event: 'session.start',
      handler: (payload: { sessionId?: string }) => void | Promise<void>
    ) => unknown
  >(() => () => undefined);
  const api: PluginActivateApi = { observe, log };
  return { api, log, observe };
}

describe('插件激活（激活 → 观察注册 → 工具调用 → 载荷返回）', () => {
  it('activate 注册 session.start observe 观察', () => {
    const { api, observe } = makeFakeApi();
    activate(api);
    expect(observe).toHaveBeenCalledOnce();
    expect(observe.mock.calls[0]?.[0]).toBe('session.start');
    expect(typeof observe.mock.calls[0]?.[1]).toBe('function');
  });

  it('会话开始时 observe 处理器输出使用说明日志', () => {
    const { api, observe, log } = makeFakeApi();
    activate(api);
    const handler = observe.mock.calls[0]?.[1] as (payload: {
      sessionId?: string;
    }) => void;
    handler({ sessionId: 'sess-1' });
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0]?.[0]).toBe('info');
    expect(String(log.mock.calls[0]?.[1])).toContain(manifest.id);
    expect(String(log.mock.calls[0]?.[1])).toContain(SESSION_START_USAGE_NOTE);
  });

  it('端到端：激活 → parse-claude-code-jsonl 工具调用 → 中立载荷返回', () => {
    const { api } = makeFakeApi();
    activate(api);

    const content = readFileSync(
      join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
      'utf8'
    );
    const payload: SessionImportPayload = parseClaudeCodeTool({
      content,
      sourceSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sessionId: 'e2e-1',
    });

    expect(payload.source).toBe('claude-code');
    expect(payload.sessionId).toBe('e2e-1');
    expect(payload.messages).toHaveLength(3);
    // 彻底排除外部工具调用
    expect(payload.messages[1]?.toolCalls).toBeUndefined();
    expect(payload.messages[1]?.thinking).toBeTruthy();
    // 中立载荷：消息为 ImportMessageDraft（role 而非 sender）
    expect(payload.messages[0]?.role).toBe('user');
    expect('sender' in payload.messages[0]!).toBe(false);
  });
});
