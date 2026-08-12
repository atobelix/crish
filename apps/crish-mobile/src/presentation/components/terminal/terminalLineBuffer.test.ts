// 终端行缓冲单测（F3 §4.0 TerminalLineBuffer 语义 / R2UX-05-07 环形 5000 + ANSI 白名单）
// 覆盖：\n 提交、\r 覆盖（含流式分片/多段取最后）、ANSI 剥离入缓冲、环形裁剪、
// 单行截断、空行折叠、replaceAll 终值权威重建、pending 渲染快照。
import {
  appendTerminalChunk,
  createTerminalLineBuffer,
  replaceAllTerminalText,
  terminalLinesOf,
  TERMINAL_RING_MAX,
} from './terminalLineBuffer';

function bufferOf(...chunks: string[]) {
  const state = createTerminalLineBuffer();
  for (const chunk of chunks) {
    appendTerminalChunk(state, chunk);
  }
  return state;
}

describe('appendTerminalChunk 行提交（\n 语义）', () => {
  it('按 \n 拆分为多行提交', () => {
    const state = bufferOf('line1\nline2\nline3');
    expect(terminalLinesOf(state).lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('尾部无 \n 的段作为 pending 参与渲染快照', () => {
    const state = bufferOf('a\nb\nc');
    expect(terminalLinesOf(state).lines).toEqual(['a', 'b', 'c']);
  });

  it('跨 chunk 续写同一行（无 \n 的增量）', () => {
    const state = bufferOf('hel', 'lo\nworld');
    expect(terminalLinesOf(state).lines).toEqual(['hello', 'world']);
  });

  it('空 chunk 不产生任何行', () => {
    const state = bufferOf('', '');
    expect(terminalLinesOf(state).lines).toEqual([]);
  });
});

describe('appendTerminalChunk \r 覆盖语义（F3 §4.0 shell 进度条）', () => {
  it('\r 后段覆盖当前行（单 chunk 多段取最后一段）', () => {
    const state = bufferOf('10%\r20%\r30%\n');
    expect(terminalLinesOf(state).lines).toEqual(['30%']);
  });

  it('流式分片：\r 结尾 chunk + 下一 chunk 整体覆盖', () => {
    const state = bufferOf('progress 10%\r', 'progress 20%\r', 'progress 30%');
    expect(terminalLinesOf(state).lines).toEqual(['progress 30%']);
  });

  it('\r 后无 \n 的段覆盖当前行（\r\n 换行前内容保留）', () => {
    const state = bufferOf('旧内容\r新内容\n下一行');
    expect(terminalLinesOf(state).lines).toEqual(['新内容', '下一行']);
  });

  it('\n 与 \r 混合流（日志 + 进度条交替）', () => {
    const state = bufferOf('下载中 10%\r下载中 20%\r下载中 30%\n完成\n');
    expect(terminalLinesOf(state).lines).toEqual(['下载中 30%', '完成']);
  });

  it('连续 \r（无文本）保持当前行内容（尾部 \r 不清行）', () => {
    const state = bufferOf('进度 50%\r', '\r');
    expect(terminalLinesOf(state).lines).toEqual(['进度 50%']);
  });
});

describe('ANSI 白名单剥离入缓冲（R2UX-05-07）', () => {
  it('SGR 颜色序列在缓冲层剥离（行内只存纯文本）', () => {
    const state = bufferOf('\x1b[32mgreen\x1b[0m\n\x1b[31mred\x1b[0m');
    expect(terminalLinesOf(state).lines).toEqual(['green', 'red']);
  });

  it('光标/清屏/非法序列一并剥离（白名单收敛 + 忽略）', () => {
    const state = bufferOf('\x1b[2J\x1b[H\x1b[32mOK\x1b[0m\x1b[?25l\n');
    expect(terminalLinesOf(state).lines).toEqual(['OK']);
  });
});

describe('环形裁剪（R2UX-05-07：超出丢最旧 + 截断计数）', () => {
  it('超过 maxLines 丢最旧行并累计 truncatedCount', () => {
    const state = createTerminalLineBuffer(3);
    appendTerminalChunk(state, '1\n2\n3\n4\n5\n6');
    expect(terminalLinesOf(state).lines).toEqual(['4', '5', '6']);
    expect(state.truncatedCount).toBe(3);
  });

  it('单 chunk 批量超限同样只丢最旧（startIndex 正确）', () => {
    const state = createTerminalLineBuffer(2);
    appendTerminalChunk(state, 'a\nb\nc\nd');
    const snapshot = terminalLinesOf(state);
    expect(snapshot.lines).toEqual(['c', 'd']);
    expect(snapshot.startIndex).toBe(2);
  });

  it('默认上限为 R2UX-05-07 的 5000 行', () => {
    const state = createTerminalLineBuffer();
    expect(state.maxLines).toBe(TERMINAL_RING_MAX);
    expect(TERMINAL_RING_MAX).toBe(5000);
  });
});

describe('单行截断（F3 §4.3：单行 5000 字符 + 尾部省略号）', () => {
  it('超过 maxLineChars 截断并附省略号', () => {
    const state = createTerminalLineBuffer(100, 8);
    appendTerminalChunk(state, '1234567890\n');
    expect(terminalLinesOf(state).lines).toEqual(['1234567…']);
  });

  it('未超限单行完整保留', () => {
    const state = createTerminalLineBuffer(100, 8);
    appendTerminalChunk(state, '12345678');
    expect(terminalLinesOf(state).lines).toEqual(['12345678']);
  });
});

describe('空行折叠（F3 §4.0：连续空行压缩为 1 行）', () => {
  it('连续空行合并为一行', () => {
    const state = bufferOf('a\n\n\n\nb');
    expect(terminalLinesOf(state).lines).toEqual(['a', '', 'b']);
  });

  it('开头空行保留（仅折叠连续空行）', () => {
    const state = bufferOf('\n\n\na');
    expect(terminalLinesOf(state).lines).toEqual(['', 'a']);
  });
});

describe('replaceAllTerminalText（F3 §4.2 终值权威重建）', () => {
  it('以终值全文重建缓冲（流式增量被替换）', () => {
    const state = bufferOf('旧流式行1\n旧流式行2');
    replaceAllTerminalText(state, '终值行1\n终值行2\n');
    expect(terminalLinesOf(state).lines).toEqual(['终值行1', '终值行2']);
    expect(state.truncatedCount).toBe(0);
  });

  it('重建时同样执行环形裁剪与 ANSI 剥离', () => {
    const state = createTerminalLineBuffer(2);
    // 输入 4 逻辑行（ANSI 剥离后仍为 4 行：a / b / c / d）
    replaceAllTerminalText(state, 'a\nb\x1b[31m\nc\x1b[0m\nd');
    expect(terminalLinesOf(state).lines).toEqual(['c', 'd']);
    expect(state.truncatedCount).toBe(2);
  });

  it('重建后 pending 清空（无未终结行残留）', () => {
    const state = bufferOf('x');
    replaceAllTerminalText(state, 'y');
    expect(terminalLinesOf(state).lines).toEqual(['y']);
  });
});

describe('terminalLinesOf 渲染快照', () => {
  it('startIndex = truncatedCount（行键稳定数据面）', () => {
    const state = createTerminalLineBuffer(2);
    appendTerminalChunk(state, '1\n2\n3\n4');
    const snapshot = terminalLinesOf(state);
    expect(snapshot.startIndex).toBe(2);
    // 行键 = startIndex + idx：淘汰后旧行键不变（防滚动抖动）
    expect(snapshot.startIndex + 0).toBe(2);
    expect(snapshot.startIndex + snapshot.lines.length).toBe(4);
  });
});
