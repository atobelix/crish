import { describe, expect, it } from 'vitest';
import {
  createMarkdownDfaTransformStream,
  MarkdownDfaTransformStream,
  MemoryBlockGeometryBook,
  parseFenceLanguage,
  StreamingMarkdownDfaLexer,
  type DfaLexEvent,
} from './streamingDfaLexer';

describe('StreamingMarkdownDfaLexer (5-State DFA)', () => {
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

  it('[MD-A01] DFA Lexer 严格 O(N) 单遍流式解析且零投机反引号注入', () => {
    const lexer = new StreamingMarkdownDfaLexer();
    const chunks = [
      '```',
      'types',
      'cript\n',
      'const a = 1;\n',
      'console.',
      'log(a);\n',
      '```\n',
    ];
    const events: DfaLexEvent[] = [];

    for (const chunk of chunks) {
      events.push(...lexer.feed(chunk));
    }
    events.push(...lexer.finish());

    const startEvent = events.find(
      (e) => e.type === 'BLOCK_START' && e.kind === 'code'
    );
    const endEvent = events.find(
      (e) => e.type === 'BLOCK_END' && e.kind === 'code'
    );
    expect(startEvent).toBeDefined();
    expect(startEvent?.language).toBe('typescript');
    expect(endEvent).toBeDefined();

    const chunkEvents = events.filter(
      (e) => e.type === 'TOKEN_CHUNK' && e.kind === 'code'
    );
    const fullCode = chunkEvents.map((e) => e.text).join('');
    expect(fullCode).toBe('const a = 1;\nconsole.log(a);\n');
    expect(fullCode.includes('```')).toBe(false);
  });

  it('[MD-A02] 围栏符号跨多 Chunk 切割时精准识别不漏网（含 5 态流转验证）', () => {
    const lexer = new StreamingMarkdownDfaLexer();

    // 1. FENCE_OPENING 探测态
    expect(lexer.feed('`')).toEqual([]);
    expect(lexer.getState()).toBe('FENCE_OPENING');
    expect(lexer.feed('`')).toEqual([]);
    expect(lexer.getState()).toBe('FENCE_OPENING');
    expect(lexer.feed('`js')).toEqual([]);
    expect(lexer.getState()).toBe('FENCE_OPENING');

    // 2. 遇到换行转入 CODE_BLOCK
    const startEv = lexer.feed('\n');
    expect(lexer.getState()).toBe('CODE_BLOCK');
    expect(startEv).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'code', language: 'js' },
    ]);

    // 3. 代码块字面量输出
    const codeEv = lexer.feed('const a = 1;\nconsole.log(a);\n');
    expect(lexer.getState()).toBe('CODE_BLOCK');
    expect(codeEv).toEqual([
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'code',
        text: 'const a = 1;\nconsole.log(a);\n',
      },
    ]);

    // 4. CODE_CLOSING 闭合探测态
    expect(lexer.feed('`')).toEqual([]);
    expect(lexer.getState()).toBe('CODE_CLOSING');
    expect(lexer.feed('`')).toEqual([]);
    expect(lexer.getState()).toBe('CODE_CLOSING');
    expect(lexer.feed('`')).toEqual([]);
    expect(lexer.getState()).toBe('CODE_CLOSING');

    // 5. 遇到换行闭合回到 TEXT_PARAGRAPH
    const endEv = lexer.feed('\n');
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');
    expect(endEv).toEqual([
      { type: 'BLOCK_END', blockId: 1, kind: 'code', language: 'js' },
    ]);
  });

  it('CODE_CLOSING 闭合符数量不足或夹杂非空字符时确定性退化回 CODE_BLOCK', () => {
    const lexer = new StreamingMarkdownDfaLexer();
    const events: DfaLexEvent[] = [];

    events.push(...lexer.feed('```ts\n'));
    // 仅 2 个反引号加换行：闭合符不足，退化为代码行字面量
    events.push(...lexer.feed('``\n'));
    expect(lexer.getState()).toBe('CODE_BLOCK');

    // 3 个反引号后跟非空字符：不是合法纯闭合行，退化为代码行字面量
    events.push(...lexer.feed('```not-close\n'));
    expect(lexer.getState()).toBe('CODE_BLOCK');

    // 真正闭合
    events.push(...lexer.feed('```\n'));
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');

    const codeText = events
      .filter((e) => e.type === 'TOKEN_CHUNK' && e.kind === 'code')
      .map((e) => e.text)
      .join('');
    expect(codeText).toBe('``\n```not-close\n');
  });

  it('有界前缀缓冲（prefixBuf <= 128）：单行围栏信息超长无换行时退化为普通段落', () => {
    const lexer = new StreamingMarkdownDfaLexer();
    const overlongFenceLine = '```' + 'a'.repeat(130);
    const events = lexer.feed(overlongFenceLine);

    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');
    const text = events
      .filter((e) => e.type === 'TOKEN_CHUNK' && e.kind === 'paragraph')
      .map((e) => e.text)
      .join('');
    expect(text).toBe(overlongFenceLine);
  });

  it('波浪号围栏与语言前缀清洗：~~~language-python 正确清洗为 python 并在闭合时完成状态流转', () => {
    expect(parseFenceLanguage('language-typescript')).toBe('typescript');
    expect(parseFenceLanguage('.python')).toBe('python');
    expect(parseFenceLanguage('   ')).toBeUndefined();

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

    const ev2 = lexer.feed('    let x = 42;');
    expect(ev2).toEqual([
      {
        type: 'TOKEN_CHUNK',
        blockId: 1,
        kind: 'code',
        text: '    let x = 42;',
      },
    ]);

    const finishEv = lexer.finish();
    expect(finishEv).toEqual([
      { type: 'BLOCK_END', blockId: 1, kind: 'code', language: 'rust' },
    ]);
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');
  });

  it('未闭合数学块与未闭合围栏前缀流式收尾', () => {
    const lexer = new StreamingMarkdownDfaLexer();

    lexer.feed('$$x^2 + y^2 = z^2');
    expect(lexer.getState()).toBe('MATH_BLOCK');
    const mathFinish = lexer.finish();
    expect(mathFinish).toEqual([
      { type: 'BLOCK_END', blockId: 1, kind: 'math' },
    ]);
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');

    lexer.reset();
    expect(lexer.getState()).toBe('TEXT_PARAGRAPH');
    expect(lexer.getCurrentBlockId()).toBe(0);

    lexer.feed('`');
    const tickFinish = lexer.finish();
    expect(tickFinish).toEqual([
      { type: 'BLOCK_START', blockId: 1, kind: 'paragraph' },
      { type: 'TOKEN_CHUNK', blockId: 1, kind: 'paragraph', text: '`' },
      { type: 'BLOCK_END', blockId: 1, kind: 'paragraph' },
    ]);
  });
});

describe('MarkdownDfaTransformStream & createMarkdownDfaTransformStream', () => {
  it('Web Streams TransformStream 管道：端到端可读可写流正常工作', async () => {
    const stream = new MarkdownDfaTransformStream();
    expect(stream).toBeInstanceOf(TransformStream);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    const writePromise = (async () => {
      await writer.write('');
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

    const factoryStream = createMarkdownDfaTransformStream();
    expect(factoryStream).toBeInstanceOf(MarkdownDfaTransformStream);
  });
});

describe('[MD-A05] MemoryBlockGeometryBook re-export 契约验证', () => {
  it('纯内存几何账本契约守门：Observer 实例数恒为 0 且会话级联清理', () => {
    const book = MemoryBlockGeometryBook.getInstance();
    book.clear();

    book.recordBlockHeight('session-1', 'msg-1', 1, 120, 'code');
    book.recordBlockHeight('session-1', 'msg-1', 2, 80, 'paragraph');

    expect(book.getObserverCount()).toBe(0);
    expect(book.getMessageTotalHeight('session-1', 'msg-1')).toBe(200);

    const evicted = book.evictSession('session-1');
    expect(evicted).toBe(true);
    expect(book.getMessageTotalHeight('session-1', 'msg-1')).toBe(0);
  });
});
