// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNoteHydrate } from './useNoteHydrate';
// 纠偏：从真实的 hydrateProjection 模块导入经过严格验证的真实类型
import type { NoteHydrateTransport, NoteHydrateOutcome } from './hydrateProjection';

describe('useNoteHydrate · 极端高频切换并发竞态防污染测试（Generation Guard）', () => {
  it('当快速连续切换文档时，滞后的旧 Promise 返回被自动丢弃，绝不污染当前文档', async () => {
    // 模拟一个可控延迟的 Transport
    const pendingResolvers: Map<string, (outcome: NoteHydrateOutcome) => void> = new Map();

    const mockTransport: NoteHydrateTransport = {
      hydrate: vi.fn((docId: string) => {
        return new Promise<NoteHydrateOutcome>((resolve) => {
          pendingResolvers.set(docId, resolve);
        });
      }),
    };

    // 1. 首次挂载 doc-1（遵循 UseNoteHydrateOptions 单对象契约传参，防解构失败导致 TypeError）
    const { result, rerender } = renderHook(
      ({ id }) => useNoteHydrate({ docId: id, hydrateTransport: mockTransport }),
      { initialProps: { id: 'doc-1' } }
    );

    expect(result.current.status).toBe('loading');
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-1');

    // 2. 紧接着用户快速切换到 doc-2（doc-1 的 I/O 尚未返回）
    await act(async () => {
      rerender({ id: 'doc-2' });
    });
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-2');

    // 3. 用户再次极速切换到 doc-3（doc-2 尚未返回）
    await act(async () => {
      rerender({ id: 'doc-3' });
    });
    expect(mockTransport.hydrate).toHaveBeenCalledWith('doc-3');

    // 4. 模拟网络/磁盘乱序返回：最老的 doc-1 耗时最长，现在滞后返回了包含旧块的数据
    await act(async () => {
      const resolveDoc1 = pendingResolvers.get('doc-1');
      resolveDoc1?.({
        ok: true,
        projection: {
          docId: 'doc-1',
          rev: 42,
          source: 'tauri-ipc',
          blocks: [
            {
              id: 'b-old',
              flavour: 'paragraph',
              text: '我是 doc-1 的旧内容，绝对不应该出现在 doc-3 中！',
              index: 0,
            },
          ],
        },
      });
      await Promise.resolve();
    });

    // 核心断言：滞后返回的 doc-1 必须被 Generation Guard 精准拦截丢弃！
    // 当前状态依然是等待 doc-3，保持 loading 态；projection 必须为 null，blocks 保持为空
    expect(result.current.status).toBe('loading');
    expect(result.current.projection).toBeNull();
    expect(result.current.blocks).toEqual([]);

    // 5. 此时最新的 doc-3 终于完成并返回
    await act(async () => {
      const resolveDoc3 = pendingResolvers.get('doc-3');
      resolveDoc3?.({
        ok: true,
        projection: {
          docId: 'doc-3',
          rev: 1,
          source: 'tauri-ipc',
          blocks: [
            {
              id: 'b-new',
              flavour: 'paragraph',
              text: '我是 doc-3 的最新正文',
              index: 0,
            },
          ],
        },
      });
      await Promise.resolve();
    });

    // 核心断言：当前文档正确响应并展示 doc-3 内容
    expect(result.current.status).toBe('ready');
    expect(result.current.projection?.docId).toBe('doc-3');
    expect(result.current.blocks[0]?.text).toBe('我是 doc-3 的最新正文');

    // 6. 此时假设迟到的 doc-2 也返回了，验证其同样被丢弃
    await act(async () => {
      const resolveDoc2 = pendingResolvers.get('doc-2');
      resolveDoc2?.({
        ok: true,
        projection: {
          docId: 'doc-2',
          rev: 5,
          source: 'tauri-ipc',
          blocks: [],
        },
      });
      await Promise.resolve();
    });

    // 验证依然保持为 doc-3 的状态与内容
    expect(result.current.status).toBe('ready');
    expect(result.current.projection?.docId).toBe('doc-3');
  });
});
