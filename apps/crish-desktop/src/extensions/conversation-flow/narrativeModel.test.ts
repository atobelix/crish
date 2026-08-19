import { describe, expect, it } from 'vitest';
import { projectPurposes } from '@crish/conversation-flow';
import type { MessageToolCall } from '../../store/types';
import type { ToolRenderItem } from '../../api/toolPresentation';
import {
  THINKING_PREVIEW_CHARS,
  clipThinkingPreview,
  collectToolIds,
  extractPendingItems,
  isDocumentArtifactPath,
  purposesForSlice,
} from './narrativeModel';

const T0 = 1_700_000_000_000;

function tc(
  partial: Partial<MessageToolCall> & Pick<MessageToolCall, 'id' | 'name'>
): MessageToolCall {
  return {
    status: 'success',
    ...partial,
  };
}

describe('narrativeModel', () => {
  it('思考预览落在 48–64 字', () => {
    expect(THINKING_PREVIEW_CHARS).toBeGreaterThanOrEqual(48);
    expect(THINKING_PREVIEW_CHARS).toBeLessThanOrEqual(64);
    const long = '甲'.repeat(80);
    const preview = clipThinkingPreview(long);
    expect(preview.length).toBeLessThanOrEqual(THINKING_PREVIEW_CHARS);
    expect(preview.endsWith('…')).toBe(true);
    expect(clipThinkingPreview('短')).toBe('短');
  });

  it('两条同窗 inspect 的 Purpose 落在首个 action 切片', () => {
    const tools = [
      tc({
        id: 'r1',
        name: 'read_file',
        startedAt: T0,
        explanation: '核对导出类型',
        arguments: JSON.stringify({ path: 'a.ts' }),
      }),
      tc({
        id: 'r2',
        name: 'open_file',
        startedAt: T0 + 8_000,
        explanation: '核对导出类型',
        arguments: JSON.stringify({ path: 'b.ts' }),
      }),
    ];
    const purposes = projectPurposes(tools);
    expect(purposes).toHaveLength(1);
    const both = collectToolIds([
      { kind: 'single', tc: tools[0]! },
      { kind: 'single', tc: tools[1]! },
    ]);
    expect(purposesForSlice(purposes, both)).toHaveLength(1);
    expect(purposesForSlice(purposes, new Set(['r1']))).toHaveLength(1);
    expect(purposesForSlice(purposes, new Set(['r2']))).toHaveLength(0);
  });

  it('pending_approval 抽出且不进 Purpose 切片', () => {
    const pending: MessageToolCall = tc({
      id: 'p1',
      name: 'run_terminal_cmd',
      status: 'pending_approval',
      arguments: JSON.stringify({ command: 'rm x' }),
    });
    const items: ToolRenderItem[] = [
      { kind: 'single', tc: pending },
      {
        kind: 'single',
        tc: tc({ id: 'r1', name: 'read_file' }),
      },
    ];
    const extracted = extractPendingItems(items);
    expect(extracted).toHaveLength(1);
    if (extracted[0]?.kind === 'single') {
      expect(extracted[0].tc.id).toBe('p1');
    }
  });

  it('文档路径走胶囊，代码路径不走', () => {
    expect(isDocumentArtifactPath('docs/note.md')).toBe(true);
    expect(isDocumentArtifactPath('src/index.ts')).toBe(false);
    expect(isDocumentArtifactPath(undefined)).toBe(false);
  });
});
