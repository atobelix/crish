/**
 * P2-A1 分块加载参数化 + TTI 基准（任务 2 验收）
 *
 * 背景：status-P2 项 1——分块加载（≤1000 行同步整载 / 首块 1000 + 每块
 * 2000 + requestIdleCallback 续载 + 代际竞态保护）已就绪，但 1000/2000/
 * 10ms 硬编码不可调，且「首帧可交互时间（TTI）」无量化基准。修复：
 * 参数提取为命名常量（FIRST_CHUNK_LINES / CHUNK_SIZE /
 * CHUNK_FALLBACK_DELAY_MS，EditorStore.ts 导出），本文件建立 TTI 基准：
 * setText 大文件同步返回后立即可交互（首块已载 + 树一致 + 击键立即生效），
 * 首帧耗时 < 阈值（100ms 宽松护栏，抗 CI 抖动；1000 行同步解析实测
 * 亚毫秒级）；续载在空闲分片完成（回退节流下 500ms 内全量收敛）。
 */
import { describe, it, expect } from 'vitest';
import {
  createEditorStore,
  FIRST_CHUNK_LINES,
  CHUNK_SIZE,
  CHUNK_FALLBACK_DELAY_MS,
} from '../../src/core/EditorStore';

/** 等分块续载完成（回退节流：12000 行 = 首块 + 6 块 ≈ 6 × 10ms 间隔 + 处理） */
function waitChunks(ms = 500): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('P2 分块加载参数化', () => {
  it('0 分块参数命名常量导出（可调首帧/续载节奏）', () => {
    expect(FIRST_CHUNK_LINES).toBe(1000);
    expect(CHUNK_SIZE).toBe(2000);
    expect(CHUNK_FALLBACK_DELAY_MS).toBe(10);
  });

  it('1 首帧 TTI：setText 同步返回后立即 1000 行可交互，耗时 < 100ms', async () => {
    const store = createEditorStore();
    const text = Array(12000).fill('line').join('\n');
    const t0 = performance.now();
    store.getState().setText(text);
    const syncMs = performance.now() - t0;
    // TTI 断言 1：首帧同步载入 FIRST_CHUNK_LINES 行（立即可交互的内容量）
    expect(store.getState().getLineCount()).toBe(FIRST_CHUNK_LINES);
    // TTI 断言 2：首帧耗时 < 阈值（100ms 宽松护栏，CI 抖动余量；
    // 1000 行同步解析实测亚毫秒级——阈值主要防解析退化为 O(全文)）
    console.log(
      `[P2 TTI] setText(12000) 同步帧=${syncMs.toFixed(2)}ms（阈值 100ms）`
    );
    expect(syncMs, `首帧耗时 ${syncMs.toFixed(2)}ms 应 < 100ms`).toBeLessThan(100);
    // TTI 断言 3：首帧即可编辑——光标移动/击键无需等待续载完成
    // （注：getState() 每次取最新 state——store 方法经 dispatchSet 合并
    // 产生新 state 对象，旧快照的字段读取会拿到过时值，统一重新取）
    store.getState().setCursorPos(4); // 'line' 行行尾（行内偏移 = 行长 4）
    store.getState().insertText('X');
    const s = store.getState();
    expect(s.verifyConsistency(), '首帧编辑后 verifyConsistency').toBe(true);
    expect(s.getLine(0)).toBe('lineX');
    // 首帧 textLength = 首块文本长度 + 插入 1 字符（分块语义：textLength
    // 随续载增长，首帧只含 FIRST_CHUNK_LINES 行——这是逐块加载的设计，
    // 全量 textLength 在续载完成后收敛，见下方续载断言）
    const firstChunkText = Array(FIRST_CHUNK_LINES)
      .fill('line')
      .join('\n');
    expect(s.textLength).toBe(firstChunkText.length + 1);
    // 异步续载：空闲分片全部落地后行数/内容/树全量收敛
    await waitChunks();
    const done = store.getState();
    expect(done.getLineCount()).toBe(12000);
    expect(done.getLine(0)).toBe('lineX');
    expect(done.getLine(11999)).toBe('line');
    expect(done.getText()).toBe(text.replace(/^line/, 'lineX'));
    expect(done.textLength).toBe(text.length + 1); // 续载后 textLength 全量收敛
    expect(done.verifyConsistency(), '续载完成后 verifyConsistency').toBe(true);
  });

  it('2 续载期间用户击键不丢（编辑与空闲分片共存）', async () => {
    const store = createEditorStore();
    const text = Array(9000).fill('row').join('\n'); // 首块 + 4 块
    store.getState().setText(text);
    expect(store.getState().getLineCount()).toBe(FIRST_CHUNK_LINES);
    // 续载未完成时立即击键（insertText 走 applyChange 主数组路径，与
    // 续块 updateLinesIncremental 串行于 dispatchSet，无竞态）
    store.getState().setCursorPos(3); // 'row' 行行尾（行内偏移 = 行长 3）
    store.getState().insertText('!');
    const s = store.getState();
    expect(s.getLine(0)).toBe('row!');
    await waitChunks();
    const done = store.getState();
    expect(done.getLineCount()).toBe(9000);
    expect(done.getLine(0)).toBe('row!');
    expect(done.getText()).toBe('row!' + text.slice(3));
    expect(done.verifyConsistency(), '击键 + 续载后 verifyConsistency').toBe(true);
  });

  it('3 续载期间二次 setText（代际竞态保护）：旧加载作废、新加载生效', async () => {
    const store = createEditorStore();
    const big = Array(8000).fill('big').join('\n');
    const small = Array(50).fill('small').join('\n');
    store.getState().setText(big);
    // 首块 1000 落地后立即整档重置（新 setText 递增代际，旧续载作废）
    store.getState().setText(small);
    expect(store.getState().getLineCount()).toBe(50);
    await waitChunks();
    const done = store.getState();
    expect(done.getLineCount()).toBe(50); // 旧加载不得追加进新文档
    expect(done.getText()).toBe(small);
    expect(done.verifyConsistency(), '代际保护后 verifyConsistency').toBe(true);
  });
});
