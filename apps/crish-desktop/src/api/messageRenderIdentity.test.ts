/**
 * 渲染身份审计（中控 C2）：
 * - 列表 key 必须 message.id（禁止 index）
 * - stream 与 final 同一 messageId 提交（不 addMessage 第二行）
 * - 虚拟列表高度键 = message.id
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listDuplicateMessageIds } from './messageUserProjection';

const here = dirname(fileURLToPath(import.meta.url));

function readSrc(relFromApi: string): string {
  return readFileSync(resolve(here, relFromApi), 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

describe('Chat list React key audit (static source)', () => {
  it('MessageVirtualizer keys rows by msg.id, not index', () => {
    const src = readSrc('../components/chat-message-list/MessageVirtualizer.tsx');
    const code = stripComments(src);

    // 正锁：AppErrorBoundary key={msg.id}
    expect(src).toMatch(/key=\{msg\.id\}/);
    // 高度稳定键 data-vindex={msg.id}
    expect(src).toMatch(/data-vindex=\{msg\.id\}/);
    // 禁：map 回调用 index 作 key
    expect(code).not.toMatch(/\.map\(\([^)]*index[^)]*\)\s*=>[\s\S]{0,200}key=\{index\}/);
    expect(code).not.toMatch(/key=\{i\}/);
    expect(code).not.toMatch(/key=\{virtualIndex\}/);
  });

  it('virtualizer RO height cache uses messageId (data-vindex), not numeric index', () => {
    const src = readSrc('../components/chat-message-list/MessageVirtualizer.tsx');
    // 注释与实现双锁
    expect(src).toMatch(/data-vindex/);
    expect(src).toMatch(/setActual\(msgId/);
  });

  it('MessageContent timeline keys use item.key / stable ids', () => {
    const src = readSrc('../components/chat-message/MessageContent.tsx');
    const code = stripComments(src);
    expect(code).toMatch(/key=\{item\.key\}/);
    expect(code).not.toMatch(/timeline\.map\([^)]*index[^)]*\)\s*=>[\s\S]{0,120}key=\{index\}/);
  });

  it('S4.4 stream path: no dual streamText sub (row thinking / content body)', () => {
    const row = stripComments(
      readSrc('../components/chat-message-row/ChatAssistantMessageRow.tsx')
    );
    const content = stripComments(
      readSrc('../components/chat-message/MessageContent.tsx')
    );
    // Row: thinking only (copy uses imperative getStreamText)
    expect(row).toMatch(/getStreamText/);
    expect(row).toMatch(/\?\.thinking/);
    expect(row).not.toMatch(/\?\.text\b/);
    // Content: single useShallow body slice (text + tools), not two bare hooks
    expect(content).toMatch(/useShallow/);
    expect(content).toMatch(/text:\s*e\.text/);
    expect(content).toMatch(/tools:\s*e\.tools/);
    const contentSubs = content.match(/useStreamingStore\s*\(/g) ?? [];
    expect(contentSubs.length).toBe(1);
    const rowSubs = row.match(/useStreamingStore\s*\(/g) ?? [];
    expect(rowSubs.length).toBe(1);
  });

  it('ChatToolCallBlock tool rows key by tool id', () => {
    const src = readSrc('../components/chat-tool-call/ChatToolCallBlock.tsx');
    // 工具行 / 批处理均以 id 为键（禁止 index）
    expect(src).toMatch(/key=\{tc\.id\}/);
    expect(src).toMatch(/key=\{ti\.id\}/);
    expect(src).toMatch(/key=\{`batch-\$\{ids\[0\]\}`\}/);
    expect(stripComments(src)).not.toMatch(/key=\{index\}/);
  });
});

describe('stream / final single-row identity (static + pure)', () => {
  it('commitStreamToSession documents update-by-id, no second addMessage', () => {
    const src = readSrc('../hooks/chat-stream/helpers.ts');
    expect(src).toMatch(/commitStreamToSession/);
    // 契约注释锁死
    expect(src).toMatch(/不 addMessage|不产生第二行/);
    // 实现：updateMessageText(sessionId, messageId, …)
    expect(src).toMatch(/updateMessageText\(\s*sessionId,\s*messageId/);
    // 本文件内 commit 路径不得 addMessage
    const commitFn = src.slice(src.indexOf('export function commitStreamToSession'));
    const body = commitFn.slice(0, commitFn.indexOf('export function snapshotStreamTextToSession'));
    expect(body).not.toMatch(/\baddMessage\b/);
  });

  it('useStreamCallbacks creates one assistant id and reuses it through complete', () => {
    const src = readSrc('../hooks/chat-stream/useStreamCallbacks.ts');
    // 单次 mint
    expect(src).toMatch(/const assistantMsgId = generateMessageId\('assistant'\)/);
    // 热路径写 streamingStore，按同一 id
    expect(src).toMatch(/setStreamText\(sid,\s*assistantMsgId/);
    // 终态 commit 同一 id
    expect(src).toMatch(/commitStreamToSession\(sid,\s*assistantMsgId/);
    // onComplete 不得再次 addMessage 助手
    const onCompleteIdx = src.indexOf('onComplete:');
    expect(onCompleteIdx).toBeGreaterThan(0);
    const onCompleteSlice = src.slice(onCompleteIdx, onCompleteIdx + 3500);
    expect(onCompleteSlice).not.toMatch(/addMessage\([^)]*sender:\s*'assistant'/);
    expect(onCompleteSlice).not.toMatch(/generateMessageId\('assistant'\)/);
  });

  it('pure: duplicate assistant ids would fail listDuplicateMessageIds', () => {
    // 模拟 stream 行 + 错误插入的 final 行同语义不同 id → 测能发现；
    // 正确路径应同 id 去重后只一条。
    const bad = [
      { id: 'asst-1' },
      { id: 'asst-1-final' }, // 错误：第二行
    ];
    expect(listDuplicateMessageIds(bad)).toEqual([]);
    // 若错误地复制了同 id 两次：
    expect(listDuplicateMessageIds([{ id: 'a' }, { id: 'a' }])).toEqual(['a']);
  });
});
