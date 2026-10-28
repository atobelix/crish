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

const here = dirname(fileURLToPath(import.meta.url));

function readSrc(relFromApi: string): string {
  return readFileSync(resolve(here, relFromApi), 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

describe('Chat list React key audit (static source)', () => {
  it('MessageVirtualizer keys rows by msg.id, not index', () => {
    const src = readSrc(
      '../components/chat-message-list/MessageVirtualizer.tsx'
    );
    const code = stripComments(src);

    // 正锁：AppErrorBoundary key={msg.id}
    expect(src).toMatch(/key=\{msg\.id\}/);
    // 高度稳定键 data-vindex={msg.id}
    expect(src).toMatch(/data-vindex=\{msg\.id\}/);
    // 禁：map 回调用 index 作 key
    expect(code).not.toMatch(
      /\.map\(\([^)]*index[^)]*\)\s*=>[\s\S]{0,200}key=\{index\}/
    );
    expect(code).not.toMatch(/key=\{i\}/);
    expect(code).not.toMatch(/key=\{virtualIndex\}/);
  });

  it('virtualizer RO height cache uses messageId (data-vindex), not numeric index', () => {
    const src = readSrc(
      '../components/chat-message-list/MessageVirtualizer.tsx'
    );
    const measure = readSrc(
      '../components/chat-message-list/messageVirtualizerMeasure.ts'
    );
    // 高度键仍在行节点上；实测回写在 per-row callback ref 里用 messageId
    expect(src).toMatch(/data-vindex/);
    expect(measure).toMatch(/dataset\.vindex/);
    expect(measure).toMatch(/setActual\(msgId/);
  });

  it('MessageContent timeline keys use stable ids (seg.id + item.key)', () => {
    const src = readSrc('../components/chat-message/MessageContent.tsx');
    const code = stripComments(src);
    // 正文交错过程折叠战役后，MessageContent 不再直接 `timeline.map(...)`：
    // 顶层按 `segments`（partitionTimelineSegments 产出）渲染，键为 seg.id——
    // 由 `${msgId}-proc|text|state-${序号}` 派生（timelineSegmenter.ts:117/125/247），
    // 追加式流式演进下稳定，非数组下标。
    expect(code).toMatch(/key=\{seg\.id\}/);
    expect(code).not.toMatch(
      /segments\.map\([^)]*index[^)]*\)\s*=>[\s\S]{0,120}key=\{index\}/
    );
    expect(code).not.toMatch(/key=\{index\}/);
    expect(code).not.toMatch(/key=\{i\}/);
    // 段内项键真源下移至 FoldableProcessSection（item.key，来自
    // AssistantTimelineItem.key，toolPresentationTypes.ts:40）
    const section = stripComments(
      readSrc('../components/chat-message/FoldableProcessSection.tsx')
    );
    expect(section).toMatch(/key=\{item\.key\}/);
    expect(section).not.toMatch(/key=\{index\}/);
  });

  it('S4.4/T4-A1 stream path: single streamText sub at shell assembly (row/content passive)', () => {
    const row = stripComments(
      readSrc('../components/chat-message-row/ChatAssistantMessageRow.tsx')
    );
    const content = stripComments(
      readSrc('../components/chat-message/MessageContent.tsx')
    );
    const shell = stripComments(
      readSrc('../components/chat-message-list/StreamingAssistantRow.tsx')
    );
    const vm = stripComments(
      readSrc('../components/chat-message/streamMessageViewModel.ts')
    );
    // Row / Content: 零 store 直连（纯 view model 消费方）
    expect(row.match(/useStreamingStore\s*\(/g) ?? []).toHaveLength(0);
    expect(content.match(/useStreamingStore\s*\(/g) ?? []).toHaveLength(0);
    // 壳层装配点：单点订阅（body slice text + tools），无第二订阅
    expect(shell.match(/useStreamingStore\s*\(/g) ?? []).toHaveLength(0);
    expect(vm.match(/useStreamingStore\s*\(/g) ?? []).toHaveLength(1);
    expect(vm).toMatch(/text:\s*e\.text/);
    expect(vm).toMatch(/tools:\s*e\.tools/);
    // streamText 沿壳层 → 行 → Content 透传（流式增量区数据面）
    expect(row).toMatch(/streamText/);
    expect(content).toMatch(/streamText/);
  });

  it('hideThinkingBlock 沿助手行透传到 MessageContent，不再 void', () => {
    const row = stripComments(
      readSrc('../components/chat-message-row/ChatAssistantMessageRow.tsx')
    );
    const content = stripComments(
      readSrc('../components/chat-message/MessageContent.tsx')
    );
    // 透传链真源（三跳，缺一即断）：
    //   行 :179  hideThinkingBlock={hideThinkingBlock}
    //   ↓
    //   Content :89  const thoughtDefaultOpen = !hideThinkingBlock
    //   ↓
    //   Content :412/:564  thoughtDefaultOpen={thoughtDefaultOpen}
    //   ↓
    //   ProcessItemRenderer :70  defaultOpen: thoughtDefaultOpen
    //                       :83  defaultExpanded={thoughtDefaultOpen}
    const renderer = stripComments(
      readSrc('../components/chat-message/ProcessItemRenderer.tsx')
    );
    expect(row).toMatch(/hideThinkingBlock=\{hideThinkingBlock\}/);
    expect(row).not.toMatch(/void _hideThinkingBlock/);
    expect(row).not.toMatch(/_hideThinkingBlock/);
    expect(content).toMatch(/hideThinkingBlock/);
    expect(content).toMatch(/thoughtDefaultOpen/);
    expect(content).toMatch(/const thoughtDefaultOpen = !hideThinkingBlock/);
    expect(content).toMatch(/thoughtDefaultOpen=\{thoughtDefaultOpen\}/);
    expect(renderer).toMatch(/defaultOpen:\s*thoughtDefaultOpen/);
    expect(renderer).toMatch(/defaultExpanded=\{thoughtDefaultOpen\}/);
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
    const commitFn = src.slice(
      src.indexOf('export function commitStreamToSession')
    );
    const body = commitFn.slice(
      0,
      commitFn.indexOf('export function snapshotStreamTextToSession')
    );
    expect(body).not.toMatch(/\baddMessage\b/);
  });

  it('useRunStreamingAssistant creates one assistant id and reuses it through complete', () => {
    const src = readSrc('../hooks/chat-stream/useRunStreamingAssistant.ts');
    const helperSrc = readSrc('../hooks/chat-stream/streamExecutionHelper.ts');
    const completionSrc = readSrc(
      '../hooks/chat-stream/streamRunCompletion.ts'
    );
    // 单次 mint
    expect(src).toMatch(
      /const assistantMsgId = generateMessageId\('assistant'\)/
    );
    // 热路径由 StreamRenderBuffer 回调写 streamingStore，按装配时绑定的同一 id
    expect(src).toMatch(
      /setupStreamRenderBuffer\(\{[\s\S]*?sid,[\s\S]*?assistantMsgId/
    );
    expect(helperSrc).toMatch(
      /setStreamText\(opts\.sid,\s*opts\.assistantMsgId/
    );
    // 终态 commit 同一 id
    expect(completionSrc).toMatch(
      /commitStreamToSession\(sid,\s*assistantMsgId/
    );
    // finish / helper 不得再次 addMessage 助手
    expect(helperSrc).not.toMatch(/addMessage\([^)]*sender:\s*'assistant'/);
    expect(helperSrc).not.toMatch(/generateMessageId\('assistant'\)/);
  });
});
