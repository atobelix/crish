import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryBlockGeometryBook } from './memoryBlockGeometryBook';

describe('MemoryBlockGeometryBook', () => {
  beforeEach(() => {
    MemoryBlockGeometryBook.getInstance().clear();
  });

  it('纯内存几何账本契约守门：getObserverCount() 恒为 0（零 DOM ResizeObserver）', () => {
    const book = MemoryBlockGeometryBook.getInstance();
    expect(book.getObserverCount()).toBe(0);

    book.recordBlockHeight('session-1', 'msg-1', 1, 120, 'code');
    book.recordBlockHeight('session-1', 'msg-1', 2, 80, 'paragraph');
    expect(book.getObserverCount()).toBe(0);
  });

  it('支持单例 getInstance() 与独立实例化，记录、增量更新与 O(1) 总高计算', () => {
    const book = new MemoryBlockGeometryBook();
    const sessionId = 'session-101';
    const messageId = 'msg-202';

    expect(book.getBlockHeight(sessionId, messageId, 1)).toBeUndefined();
    expect(book.getBlockHeight(sessionId, messageId, 1, 40)).toBe(40);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(0);

    // 记录 block 1 高度 50
    book.recordBlockHeight(sessionId, messageId, 1, 50, 'paragraph');
    expect(book.getBlockHeight(sessionId, messageId, 1)).toBe(50);
    expect(book.getBlockEntry(sessionId, messageId, 1)).toEqual({
      blockId: 1,
      kind: 'paragraph',
      lineCount: 1,
      estimatedHeight: 50,
      measuredHeight: 50,
    });
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(50);

    // 记录 block 2 高度 120
    book.recordBlockHeight(sessionId, messageId, 2, 120, 'code');
    expect(book.getBlockHeight(sessionId, messageId, 2)).toBe(120);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(170);

    // 增量更新 block 1 高度为 80 (delta +30)
    book.recordBlockHeight(sessionId, messageId, 1, 80, 'paragraph');
    expect(book.getBlockHeight(sessionId, messageId, 1)).toBe(80);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(200);

    // 活跃末尾预估高度叠加与非法值防御
    expect(book.getMessageTotalHeight(sessionId, messageId, 25)).toBe(225);
    expect(book.getMessageTotalHeight(sessionId, messageId, -10)).toBe(200);
    expect(book.getMessageTotalHeight(sessionId, messageId, Number.NaN)).toBe(
      200
    );

    // 非法 sessionId / messageId / 负高度防御
    book.recordBlockHeight('', messageId, 3, 100);
    book.recordBlockHeight(sessionId, '', 3, 100);
    book.recordBlockHeight(sessionId, messageId, 3, -50);
    expect(book.getBlockHeight(sessionId, messageId, 3)).toBe(0);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(200);
  });

  it('estimateBlockHeight / estimateHeight 纯数学行度量预估', () => {
    const book = MemoryBlockGeometryBook.getInstance();

    // 代码块：3 行 * 20px + 32px padding = 92px
    const codeHeight = book.estimateBlockHeight(
      'code',
      'const a = 1;\nconst b = 2;\nconsole.log(a + b);',
      800
    );
    expect(codeHeight).toBe(3 * 20 + 32);
    expect(
      book.estimateHeight(
        'code',
        'const a = 1;\nconst b = 2;\nconsole.log(a + b);',
        800
      )
    ).toBe(codeHeight);

    // 兼容 (text, kind) 参数顺序
    expect(
      book.estimateBlockHeight(
        'const a = 1;\nconst b = 2;\nconsole.log(a + b);',
        'code',
        800
      )
    ).toBe(codeHeight);

    // 数学块：默认 64px
    expect(book.estimateBlockHeight('math', 'E = mc^2')).toBe(64);

    // 表格块：(3 行 + 1) * 32px = 128px
    expect(
      book.estimateBlockHeight('table', '| a | b |\n| - | - |\n| 1 | 2 |')
    ).toBe(4 * 32);

    // 段落与窄容器自动折行预估
    const longParagraph = 'x'.repeat(200);
    const wideEst = book.estimateBlockHeight('paragraph', longParagraph, 800);
    const narrowEst = book.estimateBlockHeight('paragraph', longParagraph, 200);
    expect(narrowEst).toBeGreaterThan(wideEst);
  });

  it('evictSession 会话级联驱逐与 clear 全局清理', () => {
    const book = MemoryBlockGeometryBook.getInstance();
    book.recordBlockHeight('session-A', 'msg-1', 1, 100, 'code');
    book.recordBlockHeight('session-A', 'msg-2', 1, 50, 'paragraph');
    book.recordBlockHeight('session-B', 'msg-1', 1, 200, 'code');

    expect(book.getMessageTotalHeight('session-A', 'msg-1')).toBe(100);
    expect(book.getMessageTotalHeight('session-A', 'msg-2')).toBe(50);
    expect(book.getMessageTotalHeight('session-B', 'msg-1')).toBe(200);

    expect(book.evictSession('session-A')).toBe(true);
    expect(book.getMessageTotalHeight('session-A', 'msg-1')).toBe(0);
    expect(book.getMessageTotalHeight('session-A', 'msg-2')).toBe(0);
    expect(book.evictSession('session-A')).toBe(false);

    // session-B 不受影响
    expect(book.getMessageTotalHeight('session-B', 'msg-1')).toBe(200);

    book.clear();
    expect(book.getMessageTotalHeight('session-B', 'msg-1')).toBe(0);
  });
});
