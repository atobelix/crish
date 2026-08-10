/**
 * B5 拖放测试（文件拖入 FileReader 读取 + 文本拖入 + 落盘事务）
 *
 * 覆盖（对应任务书验收）：
 * - planDropInsert：Files 优先（扩展名白名单）/ text/plain 兜底 /
 *   无内容判定（纯函数）；
 * - isSupportedDroppedFile：md/txt/json 等白名单匹配；
 * - readDroppedFile：FileReader mock 注入（成功/失败路径）；
 * - applyDroppedContent：真实 createEditorStore 落盘断言（文本替换 +
 *   光标 + 单步 undo），空文件跳过（防 applyChange(from,to,'') 误删）；
 * - store.applyChange 被调用的 spy 断言（空文件不调用）。
 *
 * jsdom 限制说明（诚实登记）：
 * - jsdom 无法构造真实 DragEvent（DataTransfer 类缺失），故事件层
 *   （dragenter/dragover/drop 监听）不做 jsdom 集成测试——组件事件
 *   处理器是薄壳，全部决策与落盘收敛到本文件测试的模块级纯函数
 *   （planDropInsert / applyDroppedContent），行为级等价；
 * - jsdom 的 FileReader 行为不可靠（部分实现、事件时序差异），
 *   本测试经 vi.stubGlobal 注入确定性 mock 替代；
 * - File 由 jsdom 原生构造（new File）或对象字面量兼容。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  planDropInsert,
  isSupportedDroppedFile,
  readDroppedFile,
  applyDroppedContent,
} from '../../src/components/HiddenInput';
import { createEditorStore } from '../../src/core/EditorStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

// =====================================================================
// planDropInsert / isSupportedDroppedFile（纯函数）
// =====================================================================

describe('planDropInsert（drop 载荷决策）', () => {
  it('Files 类型 + 白名单扩展名 → file 分支', () => {
    const file = { name: 'note.md' } as File;
    const plan = planDropInsert(['Files'], [file], '');
    expect(plan.kind).toBe('file');
    if (plan.kind === 'file') expect(plan.file).toBe(file);
  });

  it('txt/json/log 等扩展名同样放行；大小写不敏感', () => {
    for (const name of ['a.txt', 'b.JSON', 'c.Log', 'd.markdown', 'e.tsx']) {
      const plan = planDropInsert(['Files'], [{ name } as File], '');
      expect(plan.kind, `${name} 应放行`).toBe('file');
    }
  });

  it('白名单外扩展名 → none（不接管，浏览器默认行为）', () => {
    const plan = planDropInsert(['Files'], [{ name: 'pic.png' } as File], '');
    expect(plan.kind).toBe('none');
    const exe = planDropInsert(['Files'], [{ name: 'app.exe' } as File], '');
    expect(exe.kind).toBe('none');
  });

  it('无 Files 但有 text/plain → text 分支（文本拖入/源内移动落点）', () => {
    const plan = planDropInsert(['text/plain'], [], '拖入文本');
    expect(plan).toEqual({ kind: 'text', text: '拖入文本' });
  });

  it('空文本/无类型 → none', () => {
    expect(planDropInsert([], [], '')).toEqual({ kind: 'none' });
    expect(planDropInsert(['text/plain'], [], '')).toEqual({ kind: 'none' });
    expect(planDropInsert(['Files'], [], '')).toEqual({ kind: 'none' });
  });

  it('Files 与 text/plain 同时存在：Files 优先', () => {
    const file = { name: 'doc.md' } as File;
    const plan = planDropInsert(['Files', 'text/plain'], [file], 'plain');
    expect(plan.kind).toBe('file');
  });
});

describe('isSupportedDroppedFile（扩展名白名单）', () => {
  it('命中/未命中/无扩展名', () => {
    expect(isSupportedDroppedFile('a.md')).toBe(true);
    expect(isSupportedDroppedFile('a.MD')).toBe(true);
    expect(isSupportedDroppedFile('a.markdown')).toBe(true);
    expect(isSupportedDroppedFile('a.txt')).toBe(true);
    expect(isSupportedDroppedFile('a.json')).toBe(true);
    expect(isSupportedDroppedFile('a.png')).toBe(false);
    expect(isSupportedDroppedFile('noext')).toBe(false);
    expect(isSupportedDroppedFile('')).toBe(false);
  });
});

// =====================================================================
// readDroppedFile（FileReader mock 注入）
// =====================================================================

describe('readDroppedFile（FileReader 读取封装）', () => {
  class MockFileReader {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsText(file: File): void {
      // 同步完成（真实浏览器为异步——mock 简化事件时序，行为等价）
      this.result = `MOCK:${file.name}`;
      this.onload?.();
    }
  }

  it('成功路径：读取结果以字符串返回', async () => {
    vi.stubGlobal('FileReader', MockFileReader);
    const file = new File(['hello'], 'note.md');
    await expect(readDroppedFile(file)).resolves.toBe('MOCK:note.md');
  });

  it('失败路径：reject 读取错误', async () => {
    class FailingReader {
      result: string | null = null;
      error: Error | null = new Error('读取失败');
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsText(): void {
        this.onerror?.();
      }
    }
    vi.stubGlobal('FileReader', FailingReader);
    await expect(readDroppedFile(new File(['x'], 'a.md'))).rejects.toThrow('读取失败');
  });
});

// =====================================================================
// applyDroppedContent（真实 store 落盘断言）
// =====================================================================

describe('applyDroppedContent（拖放落盘事务）', () => {
  it('文件内容替换 drop 时刻选区 + 光标落点（单步 undo）', async () => {
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = null;
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsText(): void {
          this.result = '拖入的文件内容';
          this.onload?.();
        }
      }
    );
    const store = createEditorStore();
    store.getState().setText('hello ');
    const s = store.getState();
    s.setCursorPos(6);
    const ok = await applyDroppedContent(
      { kind: 'file', file: new File(['x'], 'a.md') },
      s,
      6,
      6
    );
    expect(ok).toBe(true);
    expect(store.getState().getText()).toBe('hello 拖入的文件内容');
    expect(store.getState().cursorPos).toBe(6 + '拖入的文件内容'.length);
    // 单步 undo：一次撤销回到拖放前
    store.getState().undo();
    expect(store.getState().getText()).toBe('hello ');
  });

  it('空文件跳过（防 applyChange(from,to,\'\') 误删选区）', async () => {
    const applySpy = vi.fn();
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = '';
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsText(): void {
          this.result = '';
          this.onload?.();
        }
      }
    );
    const ok = await applyDroppedContent(
      { kind: 'file', file: new File([''], 'empty.md') },
      { applyChange: applySpy },
      3,
      5
    );
    expect(ok).toBe(false);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('文本拖入：同步替换选区（text/plain 分支）', async () => {
    const store = createEditorStore();
    store.getState().setText('abc def');
    const s = store.getState();
    s.setSelection(0, 3); // 选中 "abc"
    const ok = await applyDroppedContent(
      { kind: 'text', text: 'XY' },
      s,
      0,
      3
    );
    expect(ok).toBe(true);
    expect(store.getState().getText()).toBe('XY def');
  });

  it('文件拖入替换选区（drop 时刻快照——与粘贴语义一致）', async () => {
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = null;
        error: Error | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsText(): void {
          this.result = 'FILE';
          this.onload?.();
        }
      }
    );
    const store = createEditorStore();
    store.getState().setText('abcdef');
    const s = store.getState();
    s.setSelection(1, 4);
    await applyDroppedContent(
      { kind: 'file', file: new File(['f'], 'x.md') },
      s,
      1,
      4
    );
    expect(store.getState().getText()).toBe('aFILEef');
  });
});
