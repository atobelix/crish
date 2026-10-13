import { describe, expect, it } from 'vitest';
import {
  createMarkdownDfaTransformStream,
  MemoryBlockGeometryBook,
  StreamingMarkdownDfaLexer,
  type DfaLexEvent,
} from './streamingDfaLexer';

describe('StreamingMarkdownDfaLexer', () => {
  it('流式段落识别：单 chunk 与跨 chunk 段落正确发射 BLOCK_START/TOKEN_CHUNK/BLOCK_END', () => {
    const lexer = new StreamingMarkdownDfaLexer();

    // 喂入空 chunk
    expect(lexer.feed('')).toEqual([]);

    // 喂入文本片段
    const ev1 = lexer.feed('Hello ');
    expect(ev1).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'paragraph' },
      { type: 'TOKEN_CHUNK', blockId: 1, kind: 'paragraph', text: 'Hello ' },
    ]);
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');
    expect(lexer.getCurrentBlockId()).toBe(1);

    const ev2 = lexer.feed('world!\n\n');
    expect(ev2).toEqual([
      { type: 'TOKEN_CHUNK', blockId: 1, kind: 'paragraph', text: 'world!\n' },
      { type: 'BLOCK_END', blockId: 1, kind: 'paragraph' },
    ]);

    // 下一段落
    const ev3 = lexer.feed('Second paragraph.');
    expect(ev3).toEqual([
      { type: 'BLOCK_START', blockId: 2, kind: 'paragraph' },
      {
        type: 'TOKEN_CHUNK',
        blockId: 2,
        kind: 'paragraph',
        text: 'Second paragraph.',
      },
    ]);

    const finishEv = lexer.finish();
    expect(finishEv).toEqual([
      { type: 'BLOCK_END', blockId: 2, kind: 'paragraph' },
    ]);
  });

  it('代码块识别：跨 chunk 切开的 ```ts 与 ``` 准确发射 BLOCK_START(code, ts) -> TOKEN_CHUNK -> BLOCK_END(code)', () => {
    const lexer = new StreamingMarkdownDfaLexer();

    // 模拟逐字符/微切片流式输入
    const chunks = [
      '`',
      '`',
      '`',
      'ts',
      '\n',
      'const a = 1;\n',
      'console.log(a);\n',
      '`',
      '`',
      '`',
      '\n',
    ];
    const collected: DfaLexEvent[] = [];
    for (const chunk of chunks) {
      collected.push(...lexer.feed(chunk));
    }
    collected.push(...lexer.finish());

    expect(collected).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'code', language: 'ts' },
      { type: 'TOKEN_CHUNK', blockId: 1, kind: 'code', text: 'const a = 1;\n' },
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'code',
        text: 'console.log(a);\n',
      },
      { type: 'BLOCK_END', blockId: 1, kind: 'code', language: 'ts' },
    ]);
  });

  it('波浪号围栏与语言前缀清洗：~~~language-python 正确清洗为 python 并在闭合时完成状态流转', () => {
    const lexer = new StreamingMarkdownDfaLexer();
    const collected: DfaLexEvent[] = [
      ...lexer.feed('~~~language-python\nprint("hello")\n~~~\n'),
      ...lexer.finish(),
    ];

    expect(collected).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'code', language: 'python' },
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'code',
        text: 'print("hello")\n',
      },
      { type: 'BLOCK_END', blockId: 1, kind: 'code', language: 'python' },
    ]);
  });

  it('数学公式块识别：跨 chunk 切开的 $$E=mc^2$$ 准确发射 BLOCK_START(math) -> TOKEN_CHUNK -> BLOCK_END(math)', () => {
    const lexer = new StreamingMarkdownDfaLexer();
    const chunks = ['$', '$', 'E=mc^2', '$', '$'];
    const collected: DfaLexEvent[] = [];
    for (const chunk of chunks) {
      collected.push(...lexer.feed(chunk));
    }
    collected.push(...lexer.finish());

    expect(collected).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'math' },
      { type: 'TOKEN_CHUNK', blockId: 1, kind: 'math', text: 'E=mc^2' },
      { type: 'BLOCK_END', blockId: 1, kind: 'math' },
    ]);
  });

  it('数学公式块多行解析：换行跨分片公式块正确跳过起始换行并安全闭合', () => {
    const lexer = new StreamingMarkdownDfaLexer();
    const collected: DfaLexEvent[] = [
      ...lexer.feed('$$\n'),
      ...lexer.feed('\\int_0^1 x dx = \\frac{1}{2}'),
      ...lexer.feed('\n$$\n'),
      ...lexer.finish(),
    ];

    expect(collected).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'math' },
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'math',
        text: '\\int_0^1 x dx = \\frac{1}{2}',
      },
      { type: 'TOKEN_CHUNK', blockId: 1, kind: 'math', text: '\n' },
      { type: 'BLOCK_END', blockId: 1, kind: 'math' },
    ]);
  });

  it('未闭合代码块流式收尾：中途不注入投机反引号，调用 finish() 时安全闭合未完成块', () => {
    const lexer = new StreamingMarkdownDfaLexer();

    // 喂入一段未闭合的代码
    const ev1 = lexer.feed('```rust\nfn main() {\n    println!("hello");\n');
    expect(ev1).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'code', language: 'rust' },
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'code',
        text: 'fn main() {\n    println!("hello");\n',
      },
    ]);
    expect(lexer.getState()).toBe('CODE_BLOCK');

    // 模拟 LLM 流式输出中断，流式过程中绝对没有投机注入的反引号
    const ev2 = lexer.feed('    let x = 42;');
    expect(ev2).toEqual([
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'code',
        text: '    let x = 42;',
      },
    ]);

    // 调用 finish() 收尾，安全发射 BLOCK_END(code, rust)
    const finishEv = lexer.finish();
    expect(finishEv).toEqual([
      { type: 'BLOCK_END', blockId: 1, kind: 'code', language: 'rust' },
    ]);
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');
  });

  it('未闭合数学块与未闭合围栏前缀流式收尾', () => {
    const lexer = new StreamingMarkdownDfaLexer();

    // 未闭合数学块在 finish 时闭合
    lexer.feed('$$x^2 + y^2 = z^2');
    expect(lexer.getState()).toBe('MATH_BLOCK');
    const mathFinish = lexer.finish();
    expect(mathFinish).toEqual([
      { type: 'BLOCK_END', blockId: 1, kind: 'math' },
    ]);
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');

    // reset 状态测试
    lexer.reset();
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');
    expect(lexer.getCurrentBlockId()).toBe(0);

    // 小于 3 个反引号结尾
    lexer.feed('`');
    const tickFinish = lexer.finish();
    expect(tickFinish).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'paragraph' },
      { type: 'TOKEN_CHUNK', blockId: 1, kind: 'paragraph', text: '`' },
      { type: 'BLOCK_END', blockId: 1, kind: 'paragraph' },
    ]);
  });
});

describe('createMarkdownDfaTransformStream', () => {
  it('Web Streams TransformStream 管道：端到端可读可写流正常工作', async () => {
    const stream = createMarkdownDfaTransformStream();
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    const writePromise = (async () => {
      await writer.write('Text header\n\n');
      await writer.write('```typescript\n');
      await writer.write('const isDone: boolean = true;\n');
      await writer.write('```\n');
      await writer.close();
    })();

    const events: DfaLexEvent[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) events.push(value);
    }
    await writePromise;

    expect(events).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'paragraph' },
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'paragraph',
        text: 'Text header\n',
      },
      { type: 'BLOCK_END', blockId: 1, kind: 'paragraph' },
      { type: 'BLOCK_START', blockId: 2, kind: 'code', language: 'typescript' },
      {
        type: 'TOKEN_CHUNK',
        blockId: 2,
        kind: 'code',
        text: 'const isDone: boolean = true;\n',
      },
      { type: 'BLOCK_END', blockId: 2, kind: 'code', language: 'typescript' },
    ]);
  });
});

describe('MemoryBlockGeometryBook', () => {
  it('纯内存几何账本：记录、读取、增量更新及总高计算', () => {
    const book = new MemoryBlockGeometryBook();
    const sessionId = 'session-101';
    const messageId = 'msg-202';

    // 契约二守门：ResizeObserver 计数必须恒为 0
    expect(book.getObserverCount()).toBe(0);

    // 未记录时返回 fallback 或 undefined
    expect(book.getBlockHeight(sessionId, messageId, 1)).toBeUndefined();
    expect(book.getBlockHeight(sessionId, messageId, 1, 40)).toBe(40);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(0);

    // 记录 block 1 高度 50
    book.recordBlockHeight(sessionId, messageId, 1, 50);
    expect(book.getBlockHeight(sessionId, messageId, 1)).toBe(50);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(50);

    // 记录 block 2 高度 120
    book.recordBlockHeight(sessionId, messageId, 2, 120);
    expect(book.getBlockHeight(sessionId, messageId, 2)).toBe(120);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(170);

    // 增量更新 block 1 高度为 80 (delta +30)
    book.recordBlockHeight(sessionId, messageId, 1, 80);
    expect(book.getBlockHeight(sessionId, messageId, 1)).toBe(80);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(200);

    // 带活跃末尾预估高度计算
    expect(book.getMessageTotalHeight(sessionId, messageId, 25)).toBe(225);
    expect(book.getMessageTotalHeight(sessionId, messageId, -10)).toBe(200);
    expect(book.getMessageTotalHeight(sessionId, messageId, NaN)).toBe(200);

    // 异常与边界输入防御
    book.recordBlockHeight('', messageId, 3, 100);
    book.recordBlockHeight(sessionId, '', 3, 100);
    book.recordBlockHeight(sessionId, messageId, 3, -50); // 负值归零
    expect(book.getBlockHeight(sessionId, messageId, 3)).toBe(0);
    expect(book.getMessageTotalHeight(sessionId, messageId)).toBe(200);
  });

  it('纯内存几何账本：evictSession 会话级联清理与 clear 全局重置', () => {
    const book = new MemoryBlockGeometryBook();
    const sessionA = 'session-A';
    const sessionB = 'session-B';
    const msgId = 'msg-1';

    book.recordBlockHeight(sessionA, msgId, 1, 100);
    book.recordBlockHeight(sessionB, msgId, 1, 200);

    expect(book.getMessageTotalHeight(sessionA, msgId)).toBe(100);
    expect(book.getMessageTotalHeight(sessionB, msgId)).toBe(200);

    // 清理 sessionA
    const evicted = book.evictSession(sessionA);
    expect(evicted).toBe(true);
    expect(book.getMessageTotalHeight(sessionA, msgId)).toBe(0);
    expect(book.getBlockHeight(sessionA, msgId, 1)).toBeUndefined();
    // 再次清理不存在的 session 返回 false
    expect(book.evictSession(sessionA)).toBe(false);

    // sessionB 不受影响
    expect(book.getMessageTotalHeight(sessionB, msgId)).toBe(200);

    // clear 清理全部
    book.clear();
    expect(book.getMessageTotalHeight(sessionB, msgId)).toBe(0);
  });
});
