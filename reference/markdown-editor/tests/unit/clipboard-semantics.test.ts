// tests/unit/clipboard-semantics.test.ts
// R4-E 剪贴板语义测试（jsdom 环境：HTML→MD 转换器需要 DOMParser；
// 组件级 paste/keydown 事件构造）
//
// 覆盖（04 编辑深度扩展 §5 复制粘贴富文本 / R4-E 任务书三项）：
// 1. 表格粘贴转换：\t+\n 结构 → markdown 表格（多行多列/列宽补齐/
//    管道符转义/\r\n 行尾/空行剔除/首行表头语义）；
// 2. URL 包裹：纯 URL 检测 + 选区文本包 [text](url)/无选区插原文；
// 3. HTML → Markdown 转换器：p/strong/em/code/a/ul/ol/li/table/
//    h1/blockquote/hr/pre/br；
// 4. buildPasteText 编排优先级（表格 > URL > HTML > 原文 > 空）；
// 5. applyChange 一步撤销：粘贴 = 单步事务，undo 一次完整回退
//    （store 集成 + 组件 paste 事件全链路）；
// 6. 无选区 Ctrl+C 复制整行（含换行语义，VS Code/CM6 copiedRange 对齐）。
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEditorStore } from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import { HiddenInput } from '../../src/components/HiddenInput';
import { lineRangeAt, linewiseCopyContent } from '../../src/components/HiddenInput';
import {
  htmlToMarkdown,
  isTabularText,
  tabularTextToMarkdown,
  isPlainUrl,
  wrapUrlWithSelection,
  buildPasteText,
} from '../../src/core/htmlToMarkdown';
import React from 'react';

// measure 模块依赖真实 DOM 的 token 结构与 Range 布局测量（jsdom 无布局），
// 统一 mock 为固定坐标：HiddenInput 只消费 getCoordinatesFromIndex /
// toContainerCoords 的返回值，固定 rect 即可渲染出 textarea
// （与 ime-composition 测试同款）。
vi.mock('../../src/core/measure', () => ({
  getCoordinatesFromIndex: () => ({ top: 0, left: 0, height: 20, bottom: 20 }),
  toContainerCoords: (rect: { top: number; left: number; height: number }) => ({
    top: rect.top,
    left: rect.left,
    height: rect.height,
    bottom: rect.height,
  }),
  getGlobalIndexFromDOMNode: () => null,
  getArrowNavigationIndex: () => null,
}));

// React 19 act 要求显式声明测试环境（testing-library 通常代设，此处手写）
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 重置 store 到初始单行空文档（与既有测试同款，含 isComposing 复位）
function resetStore() {
  useEditorStore.setState({
    lines: [''],
    lineOffsets: new LineOffsetTree([0]),
    codeBlockState: ['none'],
    textLength: 0,
    cursorPos: 0,
    selectionStart: 0,
    selectionEnd: 0,
    undoStack: [],
    redoStack: [],
    isComposing: false,
  });
}

// 挂载 HiddenInput（measure 已 mock，coords 恒非 null → textarea 渲染）
function mountHiddenInput() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const containerRef = { current: container } as React.RefObject<HTMLDivElement | null>;
  act(() => {
    root.render(React.createElement(HiddenInput, { containerRef }));
  });
  return {
    container,
    root,
    getTextarea: () => container.querySelector('textarea') as HTMLTextAreaElement,
  };
}

// —— 事件构造辅助 ——

// 构造带纯文本/HTML 载荷的 DataTransfer（jsdom 无 DataTransfer 时
// 回退为属性注入式伪对象）
function makeDataTransfer(plain: string, html: string) {
  const data: Record<string, string> = {};
  if (plain !== '') data['text/plain'] = plain;
  if (html !== '') data['text/html'] = html;
  try {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(data)) {
      dt.setData(type, value);
    }
    return dt;
  } catch {
    return {
      getData: (type: string) => data[type] ?? '',
    } as unknown as DataTransfer;
  }
}

// 派发 paste 事件（ClipboardEvent 构造差异兜底：不支持 clipboardData
// 选项时回退为普通 Event + 属性注入）
function firePaste(ta: HTMLTextAreaElement, plain: string, html = '') {
  const dt = makeDataTransfer(plain, html);
  let ev: Event;
  try {
    ev = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
  } catch {
    ev = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'clipboardData', { value: dt });
  }
  ta.dispatchEvent(ev);
}

describe('表格粘贴转换（\t+\n → markdown 表格）', () => {
  it('多行多列：首行表头 + 分隔行 + 数据行', () => {
    expect(tabularTextToMarkdown('Name\tAge\nAlice\t30\nBob\t25')).toBe(
      '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |'
    );
  });

  it('列数不均：短行补齐空单元格', () => {
    expect(tabularTextToMarkdown('A\tB\tC\n1\t2')).toBe(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |  |'
    );
  });

  it('单元格含管道符：转义 \\| 防破坏表格语法', () => {
    expect(tabularTextToMarkdown('h1\th2\nx|y\tz')).toBe(
      '| h1 | h2 |\n| --- | --- |\n| x\\|y | z |'
    );
  });

  it('\\r\\n 行尾（Windows 剪贴板）与空行剔除', () => {
    expect(tabularTextToMarkdown('a\tb\r\n\r\n1\t2\r\n')).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |'
    );
  });

  it('单行多列（Excel 单行复制）同样转换', () => {
    expect(tabularTextToMarkdown('x\ty')).toBe('| x | y |\n| --- | --- |');
  });

  it('isTabularText：含制表符即表格结构', () => {
    expect(isTabularText('a\tb\n1\t2')).toBe(true);
    expect(isTabularText('plain text')).toBe(false);
  });
});

describe('URL 包裹（纯 URL → [text](url)）', () => {
  it('isPlainUrl：http/https 单行 URL 判定', () => {
    expect(isPlainUrl('https://example.com/a?b=1')).toBe(true);
    expect(isPlainUrl('http://example.com')).toBe(true);
    expect(isPlainUrl('example.com')).toBe(false); // 无协议不算纯 URL
    expect(isPlainUrl('https://example.com/a b')).toBe(false); // 含空格
    expect(isPlainUrl('line1\nhttps://example.com')).toBe(false); // 多行
    expect(isPlainUrl('a\thttps://example.com')).toBe(false); // 含制表符
  });

  it('有选区文本：包成 [text](url)', () => {
    expect(wrapUrlWithSelection('https://example.com', '示例站点')).toBe(
      '[示例站点](https://example.com)'
    );
  });

  it('无选区：插入 URL 原文', () => {
    expect(wrapUrlWithSelection('https://example.com', '')).toBe(
      'https://example.com'
    );
  });

  it('多行选区文本：折叠为单行防破坏链接语法', () => {
    expect(wrapUrlWithSelection('https://example.com', '第一行\n第二行')).toBe(
      '[第一行 第二行](https://example.com)'
    );
  });
});

describe('HTML → Markdown 转换器（粗粒度）', () => {
  it('p + strong/em/code 行内样式', () => {
    expect(
      htmlToMarkdown('<p>Hello <strong>world</strong> <em>!</em> <code>x</code></p>')
    ).toBe('Hello **world** *!* `x`');
  });

  it('a 链接：文字 + href 包 [text](url)；无文字退化为 href', () => {
    expect(htmlToMarkdown('<p>see <a href="https://a.b">docs</a></p>')).toBe(
      'see [docs](https://a.b)'
    );
    expect(htmlToMarkdown('<a href="https://a.b"></a>')).toBe(
      'https://a.b'
    );
  });

  it('ul/ol/li：无序 - 前缀、有序序号前缀', () => {
    expect(htmlToMarkdown('<ul><li>a</li><li>b</li></ul>')).toBe(
      '- a\n- b'
    );
    expect(htmlToMarkdown('<ol><li>a</li><li>b</li></ol>')).toBe(
      '1. a\n2. b'
    );
  });

  it('嵌套列表：li 内嵌套 ul 缩进', () => {
    expect(
      htmlToMarkdown('<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>')
    ).toBe('- a\n  - a1\n- b');
  });

  it('table：首行表头 + 分隔行 + 数据行，单元格行内样式直转', () => {
    const html =
      '<table><tr><th>Name</th><th>Age</th></tr>' +
      '<tr><td>Alice</td><td><strong>30</strong></td></tr></table>';
    expect(htmlToMarkdown(html)).toBe(
      '| Name | Age |\n| --- | --- |\n| Alice | **30** |'
    );
  });

  it('thead/tbody 包裹的表格同样识别（Word/网页复制形态）', () => {
    const html =
      '<table><thead><tr><th>H</th></tr></thead>' +
      '<tbody><tr><td>D</td></tr></tbody></table>';
    expect(htmlToMarkdown(html)).toBe('| H |\n| --- |\n| D |');
  });

  it('h1-h6 / blockquote / hr / br / pre', () => {
    expect(htmlToMarkdown('<h1>标题</h1>')).toBe('# 标题');
    expect(htmlToMarkdown('<h2>小节</h2>')).toBe('## 小节');
    expect(htmlToMarkdown('<blockquote><p>引用</p></blockquote>')).toBe(
      '> 引用'
    );
    expect(htmlToMarkdown('<hr>')).toBe('---');
    expect(htmlToMarkdown('<p>a<br>b</p>')).toBe('a\nb');
    expect(htmlToMarkdown('<pre>const a = 1;\nconst b = 2;</pre>')).toBe(
      '```\nconst a = 1;\nconst b = 2;\n```'
    );
  });

  it('纯文本/空 HTML：原样透传或返回空串', () => {
    expect(htmlToMarkdown('<p>只有文本</p>')).toBe('只有文本');
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('plain')).toBe('plain');
  });
});

describe('buildPasteText 编排（优先级）', () => {
  it('表格优先：纯文本含 \\t 时即使有 HTML 也走表格转换', () => {
    const html = '<table><tr><td>a</td><td>b</td></tr></table>';
    expect(buildPasteText('a\tb\n1\t2', html, '')).toBe(
      '| a | b |\n| --- | --- |\n| 1 | 2 |'
    );
  });

  it('纯 URL：有选区包链接、无选区插原文', () => {
    expect(buildPasteText('https://example.com', '', '示例')).toBe(
      '[示例](https://example.com)'
    );
    expect(buildPasteText('https://example.com', '', '')).toBe(
      'https://example.com'
    );
  });

  it('HTML 带标签：转 markdown（网页富文本语义保留）', () => {
    expect(
      buildPasteText(
        '点我',
        '<a href="https://example.com"><strong>点我</strong></a>',
        ''
      )
    ).toBe('[**点我**](https://example.com)');
  });

  it('无标签 HTML 字段（纯文本复制）与纯文本：原文透传', () => {
    expect(buildPasteText('plain text', 'plain text', '')).toBe('plain text');
    expect(buildPasteText('多行\n文本', '', '')).toBe('多行\n文本');
  });

  it('空剪贴板：返回 null（调用方不拦截）', () => {
    expect(buildPasteText('', '', '')).toBeNull();
    expect(buildPasteText('', '<p></p>', '')).toBeNull();
  });
});

describe('粘贴 = applyChange 一步撤销', () => {
  beforeEach(() => {
    resetStore();
  });

  it('store 集成：表格转换结果单步事务，undo 一次完整回退', () => {
    useEditorStore.getState().setText('前言');
    useEditorStore.getState().setSelection(2, 2);

    // 模拟粘贴处理核心：转换结果经 applyChange（merge:'none'）单步落库
    // （选区读最新 state——快照引用在 setSelection 后不更新）
    const transformed = buildPasteText('a\tb\n1\t2', '', '');
    const cur = useEditorStore.getState();
    cur.applyChange(cur.selectionStart, cur.selectionEnd, transformed!, {
      merge: 'none',
    });

    let s = useEditorStore.getState();
    expect(s.getText()).toBe('前言| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(s.undoStack).toHaveLength(1); // 一次粘贴 = 一个 undo 步
    expect(s.verifyConsistency()).toBe(true);

    s.undo();
    s = useEditorStore.getState();
    expect(s.getText()).toBe('前言');
    expect(s.undoStack).toHaveLength(0);
    expect(s.verifyConsistency()).toBe(true);
  });

  it('粘贴覆盖选区：HTML 转换结果替换选区，undo 一步恢复原文', () => {
    useEditorStore.getState().setText('见 [旧文本] 链接');
    useEditorStore.getState().setSelection(3, 6); // 选 '旧文本'

    const transformed = buildPasteText(
      '',
      '<a href="https://x.io">新文本</a>',
      '旧文本'
    );
    const cur = useEditorStore.getState();
    cur.applyChange(cur.selectionStart, cur.selectionEnd, transformed!, {
      merge: 'none',
    });

    let s = useEditorStore.getState();
    // 选区 '旧文本' 位于 markdown 链接 [旧文本] 内部：替换后外层括号保留
    expect(s.getText()).toBe('见 [[新文本](https://x.io)] 链接');
    expect(s.undoStack).toHaveLength(1);

    s.undo();
    expect(useEditorStore.getState().getText()).toBe('见 [旧文本] 链接');
  });

  it('组件全链路：paste 事件落库为表格 + undo/redo 单步', () => {
    const mounted = mountHiddenInput();
    const ta = mounted.getTextarea();

    act(() => {
      useEditorStore.getState().setText('标题');
      useEditorStore.getState().setCursorPos(2);
    });

    act(() => {
      firePaste(ta, 'a\tb\n1\t2');
    });

    let s = useEditorStore.getState();
    expect(s.getText()).toBe('标题| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(s.undoStack).toHaveLength(1);
    expect(ta.value).toBe(''); // 粘贴后 textarea 清空，防 input 双写

    act(() => {
      useEditorStore.getState().undo();
    });
    expect(useEditorStore.getState().getText()).toBe('标题');

    act(() => {
      useEditorStore.getState().redo();
    });
    expect(useEditorStore.getState().getText()).toBe(
      '标题| a | b |\n| --- | --- |\n| 1 | 2 |'
    );

    act(() => {
      mounted.root.unmount();
    });
    document.body.innerHTML = '';
  });

  it('组件全链路：URL 粘贴选区包裹', () => {
    const mounted = mountHiddenInput();
    const ta = mounted.getTextarea();

    act(() => {
      useEditorStore.getState().setText('打开链接');
      useEditorStore.getState().setSelection(0, 4);
    });

    act(() => {
      firePaste(ta, 'https://example.com');
    });

    expect(useEditorStore.getState().getText()).toBe(
      '[打开链接](https://example.com)'
    );
    expect(useEditorStore.getState().undoStack).toHaveLength(1);

    act(() => {
      useEditorStore.getState().undo();
    });
    expect(useEditorStore.getState().getText()).toBe('打开链接');

    act(() => {
      mounted.root.unmount();
    });
    document.body.innerHTML = '';
  });

  it('组件全链路：HTML 粘贴转 markdown', () => {
    const mounted = mountHiddenInput();
    const ta = mounted.getTextarea();

    act(() => {
      firePaste(ta, '富文本', '<p>Hello <strong>world</strong></p>');
    });

    expect(useEditorStore.getState().getText()).toBe(
      'Hello **world**'
    );
    expect(useEditorStore.getState().undoStack).toHaveLength(1);

    act(() => {
      mounted.root.unmount();
    });
    document.body.innerHTML = '';
  });
});

describe('无选区 Ctrl+C 复制整行（linewise copy）', () => {
  let clipboardMock: { writeText: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    resetStore();
    clipboardMock = { writeText: vi.fn(() => Promise.resolve()) };
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: clipboardMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lineRangeAt：行首/行中/行尾/末行（无换行符）', () => {
    expect(lineRangeAt('ab\ncd\nef', 0)).toEqual({ start: 0, end: 2 });
    expect(lineRangeAt('ab\ncd\nef', 4)).toEqual({ start: 3, end: 5 });
    // pos 落在行尾换行符上：归属上一行（引擎行区间语义）
    expect(lineRangeAt('ab\ncd\nef', 5)).toEqual({ start: 3, end: 5 });
    expect(lineRangeAt('ab\ncd\nef', 6)).toEqual({ start: 6, end: 8 });
    expect(lineRangeAt('ab\ncd\nef', 8)).toEqual({ start: 6, end: 8 });
  });

  it('linewiseCopyContent：整行文本 + 换行符（VS Code 语义）', () => {
    expect(linewiseCopyContent('ab\ncd\nef', 4)).toBe('cd\n');
    expect(linewiseCopyContent('single', 2)).toBe('single\n');
  });

  it('组件：Ctrl+C 无选区复制当前行到系统剪贴板', () => {
    const mounted = mountHiddenInput();
    const ta = mounted.getTextarea();

    act(() => {
      useEditorStore.getState().setText('第一行\n第二行\n第三行');
      useEditorStore.getState().setCursorPos(4); // '第二行' 中间
    });

    act(() => {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(clipboardMock.writeText).toHaveBeenCalledTimes(1);
    expect(clipboardMock.writeText).toHaveBeenCalledWith('第二行\n');
    // 复制不产生任何编辑/撤销步
    expect(useEditorStore.getState().undoStack).toHaveLength(0);

    act(() => {
      mounted.root.unmount();
    });
    document.body.innerHTML = '';
  });

  it('组件：Ctrl+C 有选区时不拦截（走既有容器 onCopy 源码复制）', () => {
    const mounted = mountHiddenInput();
    const ta = mounted.getTextarea();

    act(() => {
      useEditorStore.getState().setText('hello world');
      useEditorStore.getState().setSelection(0, 5);
    });

    act(() => {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });

    expect(clipboardMock.writeText).not.toHaveBeenCalled();
    expect(useEditorStore.getState().selectionStart).toBe(0);
    expect(useEditorStore.getState().selectionEnd).toBe(5);

    act(() => {
      mounted.root.unmount();
    });
    document.body.innerHTML = '';
  });
});
