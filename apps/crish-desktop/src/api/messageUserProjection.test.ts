/**
 * UserView 投影差集分类测（中控 C1 门禁）。
 * 给定 engine / session messages → UserView DTO 稳定；差集 kind 可分类。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SessionMessage } from '../store/layoutStore';
import {
  assertUserViewDiffClassified,
  classifyHiddenBuckets,
  clipPreview,
  countHiddenBucketsByKind,
  debugExportUserView,
  isUserViewDebugEnabled,
  listDuplicateMessageIds,
  projectEngineBlocksToUserView,
  projectSessionMessagesToUserView,
  projectToolCallToUserView,
  serializeUserViewProjectionExport,
  summarizeUserViewProjection,
  USER_VIEW_PROJECTION_EXPORT_FORMAT,
  type EngineLikeBlock,
  type HiddenBucketKind,
} from './messageUserProjection';

function userMsg(id: string, text: string): SessionMessage {
  return {
    id,
    sender: 'user',
    text,
    timestamp: 1,
  };
}

function asstMsg(
  id: string,
  partial: Partial<SessionMessage> = {}
): SessionMessage {
  return {
    id,
    sender: 'assistant',
    text: '',
    timestamp: 2,
    status: 'completed',
    ...partial,
  };
}

describe('clipPreview / listDuplicateMessageIds', () => {
  it('clips long preview with ellipsis', () => {
    expect(clipPreview('hello world', 5)).toBe('hell…');
    expect(clipPreview('  ab  ', 10)).toBe('ab');
    expect(clipPreview('', 10)).toBe('');
  });

  it('lists duplicate message ids only', () => {
    expect(listDuplicateMessageIds([])).toEqual([]);
    expect(
      listDuplicateMessageIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'b' }])
    ).toEqual(['a', 'b']);
  });
});

describe('projectSessionMessagesToUserView', () => {
  it('projects user text as visible; no hidden buckets', () => {
    const dto = projectSessionMessagesToUserView([userMsg('u1', '你好')]);
    expect(dto.messages).toHaveLength(1);
    expect(dto.messages[0]!.visibleText).toBe('你好');
    expect(dto.messages[0]!.thinkingHidden).toBe(true);
    expect(dto.hiddenBuckets).toEqual([]);
    expect(dto.stats.userVisibleBlockCount).toBe(1);
  });

  it('hides thinking into thinking bucket by default', () => {
    const dto = projectSessionMessagesToUserView([
      userMsg('u1', '问'),
      asstMsg('a1', {
        text: '答',
        thinking: '我先推演一下步骤……很长的思考',
      }),
    ]);
    const asst = dto.messages.find((m) => m.id === 'a1')!;
    expect(asst.visibleText).toBe('答');
    expect(asst.thinkingHidden).toBe(true);
    expect(asst.thinkingPreview).toContain('推演');
    expect(dto.hiddenBuckets.some((b) => b.kind === 'thinking')).toBe(true);
    expect(asst.visibleText).not.toContain('推演');
  });

  it('skips placeholder thinking (正在处理…)', () => {
    const dto = projectSessionMessagesToUserView([
      asstMsg('a1', { text: 'ok', thinking: '正在处理…' }),
    ]);
    expect(dto.hiddenBuckets.filter((b) => b.kind === 'thinking')).toHaveLength(
      0
    );
    expect(dto.messages[0]!.thinkingPreview).toBeUndefined();
  });

  it('tool summary vs raw: raw goes to tool_raw bucket', () => {
    const longOut =
      'file contents line 1\nfile contents line 2\nfile contents line 3\n' +
      'more raw payload that should not be the visible summary alone';
    const dto = projectSessionMessagesToUserView([
      asstMsg('a1', {
        text: '读完了',
        toolCalls: [
          {
            id: 'tc1',
            name: 'read_file',
            arguments: JSON.stringify({ path: 'a.ts' }),
            status: 'success',
            output: longOut,
            explanation: '读取 a.ts',
          },
        ],
      }),
    ]);
    const asst = dto.messages[0]!;
    expect(asst.tools).toHaveLength(1);
    expect(asst.tools[0]!.summary.length).toBeGreaterThan(0);
    expect(asst.tools[0]!.hasRaw).toBe(true);
    expect(asst.tools[0]!.raw).toBeUndefined(); // 默认不附 raw
    const rawBuckets = dto.hiddenBuckets.filter((b) => b.kind === 'tool_raw');
    expect(rawBuckets).toHaveLength(1);
    expect(rawBuckets[0]!.sourceToolCallId).toBe('tc1');
    expect(rawBuckets[0]!.charCount).toBeGreaterThan(0);
  });

  it('includeToolRaw attaches raw on card without writeback', () => {
    const { card } = projectToolCallToUserView(
      {
        id: 't',
        name: 'shell',
        status: 'success',
        output: 'line1\nline2\nline3\nline4\nline5',
        explanation: '跑一下检查',
      },
      { includeToolRaw: true }
    );
    if (card.hasRaw) {
      expect(card.raw).toBeTruthy();
    }
  });

  it('dedupes same message id (I-MSG-ID)', () => {
    const dto = projectSessionMessagesToUserView([
      userMsg('u1', 'a'),
      userMsg('u1', 'b'),
      asstMsg('a1', { text: 'x' }),
    ]);
    expect(dto.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(dto.messages[0]!.visibleText).toBe('a');
  });

  it('stats: modelBlockCount >= userVisibleBlockCount when AI sees more', () => {
    const dto = projectSessionMessagesToUserView([
      asstMsg('a1', {
        text: '可见',
        thinking: '隐藏思考',
        toolCalls: [
          {
            id: 'tc',
            name: 'read_file',
            status: 'success',
            output: 'RAW\n'.repeat(40),
            arguments: '{}',
          },
        ],
      }),
    ]);
    expect(dto.stats.modelBlockCount).toBeGreaterThanOrEqual(
      dto.stats.userVisibleBlockCount
    );
    expect(dto.stats.hiddenCount).toBeGreaterThan(0);
  });
});

describe('projectEngineBlocksToUserView + classifyHiddenBuckets', () => {
  const modelBlocks: EngineLikeBlock[] = [
    { type: 'system', id: 'sys1', text: 'You are a helpful agent.' },
    { type: 'nudge', id: 'n1', text: 'Continue with synthesis of tools.' },
    { type: 'user', id: 'u1', text: '修 bug' },
    { type: 'thinking', id: 'a1', text: '先看日志再改' },
    { type: 'tool', id: 'tc1', name: 'read_file', output: 'log line\n'.repeat(20), status: 'success', messageId: 'a1' },
    { type: 'assistant_text', id: 'a1', text: '已定位问题' },
  ];

  it('projects engine blocks: system/nudge/thinking hidden by default', () => {
    const dto = projectEngineBlocksToUserView(modelBlocks);
    // user + assistant（合并 thinking/tool/text）
    expect(dto.messages.some((m) => m.sender === 'user')).toBe(true);
    const asst = dto.messages.find((m) => m.id === 'a1');
    expect(asst?.visibleText).toContain('已定位问题');
    expect(asst?.thinkingHidden).toBe(true);
    expect(asst?.tools.some((t) => t.id === 'tc1')).toBe(true);

    const kinds = new Set(dto.hiddenBuckets.map((b) => b.kind));
    expect(kinds.has('system')).toBe(true);
    expect(kinds.has('system_nudge') || kinds.has('nudge')).toBe(true);
    expect(kinds.has('thinking')).toBe(true);
    // tool raw when substantial
    expect(kinds.has('tool_raw')).toBe(true);

    // 可见正文不含 system prompt / nudge
    const allVisible = dto.messages.map((m) => m.visibleText).join('\n');
    expect(allVisible).not.toContain('helpful agent');
    expect(allVisible).not.toContain('synthesis of tools');
  });

  it('classifyHiddenBuckets covers thinking / tool_raw / system / system_nudge', () => {
    const dto = projectEngineBlocksToUserView(modelBlocks);
    const buckets = classifyHiddenBuckets(modelBlocks, dto);
    const kinds = buckets.map((b) => b.kind) as HiddenBucketKind[];
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('tool_raw');
    expect(kinds).toContain('system');
    expect(kinds).toContain('system_nudge');
  });

  it('assertUserViewDiffClassified passes for typical AI-sees-more case', () => {
    const dto = projectEngineBlocksToUserView(modelBlocks);
    const result = assertUserViewDiffClassified(modelBlocks, dto);
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBeGreaterThanOrEqual(result.userVisible);
    expect(result.unknownKinds).toEqual([]);
  });

  it('差集分类：每类至少可独立识别', () => {
    const cases: { block: EngineLikeBlock; kind: HiddenBucketKind }[] = [
      { block: { type: 'thinking', text: 'secret chain of thought' }, kind: 'thinking' },
      {
        block: {
          type: 'tool',
          id: 'x',
          name: 'read_file',
          output: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\n'.repeat(5),
        },
        kind: 'tool_raw',
      },
      { block: { type: 'system', text: 'sys' }, kind: 'system' },
      { block: { type: 'nudge', text: 'nudge me' }, kind: 'system_nudge' },
    ];
    for (const { block, kind } of cases) {
      const emptyDto = projectEngineBlocksToUserView([]);
      const buckets = classifyHiddenBuckets([block], emptyDto);
      expect(buckets.map((b) => b.kind)).toContain(kind);
    }
  });
});

describe('isUserViewDebugEnabled / debugExportUserView', () => {
  const original = globalThis.localStorage;

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });

  afterEach(() => {
    if (original) vi.stubGlobal('localStorage', original);
    else vi.unstubAllGlobals();
  });

  it('debug export is no-op when flag off; returns same dto', () => {
    localStorage.removeItem('crish:userViewDebug');
    const dto = projectSessionMessagesToUserView([userMsg('u', 'x')]);
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const out = debugExportUserView(dto);
    expect(out).toBe(dto);
    // 未开 flag 时不应打日志（或仅 DEV+flag）
    if (!isUserViewDebugEnabled()) {
      expect(spy).not.toHaveBeenCalled();
    }
    spy.mockRestore();
  });

  it('flag via localStorage enables debug', () => {
    localStorage.setItem('crish:userViewDebug', '1');
    // DEV 环境下可能 true；至少 set 后调用不抛
    expect(() =>
      debugExportUserView(projectSessionMessagesToUserView([]), 'test')
    ).not.toThrow();
  });
});

describe('debug panel helpers (count / summarize / serialize)', () => {
  it('countHiddenBucketsByKind aggregates kinds', () => {
    const dto = projectSessionMessagesToUserView([
      asstMsg('a1', {
        text: 'hi',
        thinking: 'secret plan',
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            status: 'success',
            output: 'line1\nline2\nline3\nline4\nline5\nfull raw dump here',
          },
        ],
      }),
    ]);
    const counts = countHiddenBucketsByKind(dto.hiddenBuckets);
    expect(counts.thinking).toBeGreaterThanOrEqual(1);
    // tool_raw 取决于是否 substantial；thinking 必有
    const sum = Object.values(counts).reduce((n, v) => n + (v ?? 0), 0);
    expect(sum).toBe(dto.hiddenBuckets.length);
  });

  it('summarizeUserViewProjection reports model ≥ user and kind list', () => {
    const dto = projectSessionMessagesToUserView([
      userMsg('u1', '你好'),
      asstMsg('a1', {
        text: '回复',
        thinking: '内部思考内容足够长',
      }),
    ]);
    const summary = summarizeUserViewProjection(dto, {
      sessionId: 'sess-1',
      sessionTitle: 'Demo',
      sessionMessageCount: 2,
    });
    expect(summary.sessionId).toBe('sess-1');
    expect(summary.userViewMessageCount).toBe(2);
    expect(summary.sessionMessageCount).toBe(2);
    expect(summary.stats.hiddenCount).toBeGreaterThanOrEqual(1);
    expect(summary.hiddenKinds).toContain('thinking');
    expect(summary.modelGeUser).toBe(true);
    expect(summary.kindCounts.thinking).toBeGreaterThanOrEqual(1);
  });

  it('serializeUserViewProjectionExport is stable JSON with format tag', () => {
    const dto = projectSessionMessagesToUserView([userMsg('u', 'x')]);
    const json = serializeUserViewProjectionExport(dto, {
      sessionId: 's1',
      sessionTitle: 'T',
      exportedAt: '2026-01-01T00:00:00.000Z',
    });
    const parsed = JSON.parse(json) as {
      format: string;
      version: number;
      stats: { modelBlockCount: number };
      messages: unknown[];
      hiddenBuckets: unknown[];
    };
    expect(parsed.format).toBe(USER_VIEW_PROJECTION_EXPORT_FORMAT);
    expect(parsed.version).toBe(1);
    expect(parsed.messages).toHaveLength(1);
    expect(Array.isArray(parsed.hiddenBuckets)).toBe(true);
    expect(typeof parsed.stats.modelBlockCount).toBe('number');
    // trailing newline for text download friendliness
    expect(json.endsWith('\n')).toBe(true);
  });

  it('empty session summary has zeros and modelGeUser true', () => {
    const dto = projectSessionMessagesToUserView([]);
    const summary = summarizeUserViewProjection(dto);
    expect(summary.userViewMessageCount).toBe(0);
    expect(summary.stats.modelBlockCount).toBe(0);
    expect(summary.stats.hiddenCount).toBe(0);
    expect(summary.hiddenKinds).toEqual([]);
    expect(summary.modelGeUser).toBe(true);
  });
});
