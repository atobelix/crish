// terminalStore 单测（R2-14 第三波）：环形裁剪 / ANSI 剥离 / \r 覆盖 / 多 run 隔离 /
// 重置与全清 / linesOf 选择器游标与截断计数 / 空态
import { terminalStore, linesOf } from './terminalStore';
import {
  appendTerminalChunk,
  createTerminalLineBuffer,
} from '@/presentation/components/terminal/terminalLineBuffer';

function resetStore(): void {
  terminalStore.setState({ runs: {} });
}

beforeEach(() => {
  resetStore();
});

describe('ingestLines（流式入缓冲）', () => {
  it('普通 \n 文本按行提交，linesOf 返回纯文本行', () => {
    terminalStore.getState().ingestLines('run-1', 'line one\nline two\n');
    const view = linesOf('run-1');
    expect(view).not.toBeNull();
    expect(view!.lines).toEqual(['line one', 'line two']);
    expect(view!.truncatedCount).toBe(0);
  });

  it('ANSI 转义在缓冲层剥离（入缓冲即净化，F3 §4.2）', () => {
    terminalStore.getState().ingestLines('run-1', '\x1b[32mbuild ok\x1b[0m\n');
    expect(linesOf('run-1')!.lines).toEqual(['build ok']);
  });

  it('\\r 覆盖语义跨 chunk 保持（shell 进度条分片到达，F3 §4.0）', () => {
    terminalStore.getState().ingestLines('run-1', '10%\r');
    terminalStore.getState().ingestLines('run-1', '20%\r');
    terminalStore.getState().ingestLines('run-1', 'done\n');
    expect(linesOf('run-1')!.lines).toEqual(['done']);
  });

  it('游标随文本块单调递增（渲染增量判定数据面）', () => {
    terminalStore.getState().ingestLines('run-1', 'a\n');
    terminalStore.getState().ingestLines('run-1', 'b\n');
    terminalStore.getState().ingestLines('run-1', 'c\n');
    expect(linesOf('run-1')!.cursor).toBe(3);
  });
});

describe('环形裁剪（5000 行有界，R2UX-05-07）', () => {
  it('缓冲实例小环形验证裁剪语义（构造参数穿透 maxLines）', () => {
    const buffer = createTerminalLineBuffer(3);
    appendTerminalChunk(buffer, '1\n2\n3\n4\n5\n');
    expect(buffer.lines).toEqual(['3', '4', '5']);
    expect(buffer.truncatedCount).toBe(2);
  });

  it('大文本经 store ingest 后 truncatedCount 与 startIndex 一致', () => {
    const big = Array.from({ length: 5002 }, (_, i) => `row-${i}`).join('\n');
    terminalStore.getState().ingestLines('run-1', `${big}\n`);
    const view = linesOf('run-1')!;
    expect(view.truncatedCount).toBe(2);
    expect(view.startIndex).toBe(2);
    expect(view.lines).toHaveLength(5000);
    expect(view.lines[0]).toBe('row-2');
    expect(view.lines[4999]).toBe('row-5001');
  });
});

describe('多 run 隔离（M5 §3.1.1 lines: Record<runId, ...>）', () => {
  it('各 run 缓冲独立，互不污染', () => {
    terminalStore.getState().ingestLines('run-a', 'alpha\n');
    terminalStore.getState().ingestLines('run-b', 'beta\nbeta2\n');
    terminalStore.getState().ingestLines('run-a', 'alpha2\n');
    expect(linesOf('run-a')!.lines).toEqual(['alpha', 'alpha2']);
    expect(linesOf('run-b')!.lines).toEqual(['beta', 'beta2']);
    expect(linesOf('run-a')!.cursor).toBe(2);
    expect(linesOf('run-b')!.cursor).toBe(1);
  });
});

describe('resetRun / clearAll（run 收口释放与全清）', () => {
  it('resetRun 释放单 run（linesOf 回 null；再 ingest 重建空缓冲）', () => {
    terminalStore.getState().ingestLines('run-a', 'x\n');
    terminalStore.getState().ingestLines('run-b', 'y\n');
    terminalStore.getState().resetRun('run-a');
    expect(linesOf('run-a')).toBeNull();
    expect(linesOf('run-b')!.lines).toEqual(['y']);
    terminalStore.getState().ingestLines('run-a', 'z\n');
    expect(linesOf('run-a')!.lines).toEqual(['z']);
    expect(linesOf('run-a')!.cursor).toBe(1);
  });

  it('clearAll 清空全部 run', () => {
    terminalStore.getState().ingestLines('run-a', 'x\n');
    terminalStore.getState().ingestLines('run-b', 'y\n');
    terminalStore.getState().clearAll();
    expect(terminalStore.getState().runs).toEqual({});
    expect(linesOf('run-a')).toBeNull();
  });
});

describe('linesOf 选择器', () => {
  it('未知 run 返回 null（渲染层空态）', () => {
    expect(linesOf('nope')).toBeNull();
  });

  it('startIndex 供稳定行键（key = startIndex + idx，防滚动抖动）', () => {
    const big = Array.from({ length: 5002 }, (_, i) => `r${i}`).join('\n');
    terminalStore.getState().ingestLines('run-1', `${big}\n`);
    const view = linesOf('run-1')!;
    expect(view.startIndex).toBe(2);
    expect(view.lines.map((_, idx) => view.startIndex + idx)).toHaveLength(
      5000
    );
  });
});
