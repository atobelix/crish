// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/internal/roving-focus/__tests__/typeaheadBuffer.test.ts
 * Typeahead 缓冲区与可编辑元素守卫极限边界测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isEditableElement,
  isImeOrModifierEvent,
  TypeaheadBuffer,
} from '../typeaheadBuffer';
import type { TypeaheadItem } from '../types';

describe('TypeaheadBuffer 与可编辑守卫', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('1. isEditableElement 守卫', () => {
    it('对 null 或非 HTMLElement 返回 false', () => {
      expect(isEditableElement(null)).toBe(false);
      expect(isEditableElement({} as any)).toBe(false);
    });

    it('对原生 input, textarea, select 返回 true', () => {
      const input = document.createElement('input');
      const textarea = document.createElement('textarea');
      const select = document.createElement('select');

      expect(isEditableElement(input)).toBe(true);
      expect(isEditableElement(textarea)).toBe(true);
      expect(isEditableElement(select)).toBe(true);
    });

    it('对 contentEditable 元素返回 true', () => {
      const div = document.createElement('div');
      div.setAttribute('contenteditable', 'true');
      expect(isEditableElement(div)).toBe(true);
    });

    it('对 role="textbox" 元素返回 true', () => {
      const div = document.createElement('div');
      div.setAttribute('role', 'textbox');
      expect(isEditableElement(div)).toBe(true);
    });

    it('对 xterm, tiptap, monaco-editor, slate 内部子节点返回 true', () => {
      const container = document.createElement('div');
      container.className = 'xterm';
      const child = document.createElement('span');
      container.appendChild(child);
      document.body.appendChild(container);

      expect(isEditableElement(child)).toBe(true);

      const tiptapContainer = document.createElement('div');
      tiptapContainer.className = 'tiptap';
      const tiptapSpan = document.createElement('span');
      tiptapContainer.appendChild(tiptapSpan);
      document.body.appendChild(tiptapContainer);

      expect(isEditableElement(tiptapSpan)).toBe(true);

      const monacoContainer = document.createElement('div');
      monacoContainer.className = 'monaco-editor';
      const monacoSpan = document.createElement('span');
      monacoContainer.appendChild(monacoSpan);
      document.body.appendChild(monacoContainer);

      expect(isEditableElement(monacoSpan)).toBe(true);

      // 清理 DOM
      container.remove();
      tiptapContainer.remove();
      monacoContainer.remove();
    });

    it('对常规 menuitem 容器返回 false', () => {
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.className = 'menu-item';
      expect(isEditableElement(item)).toBe(false);
    });
  });

  describe('2. isImeOrModifierEvent 守卫', () => {
    it('修饰键 (Ctrl/Alt/Meta) 返回 true', () => {
      expect(isImeOrModifierEvent({ altKey: true } as any)).toBe(true);
      expect(isImeOrModifierEvent({ ctrlKey: true } as any)).toBe(true);
      expect(isImeOrModifierEvent({ metaKey: true } as any)).toBe(true);
    });

    it('CJK IME 合成态 (isComposing / keyCode 229 / key Process) 返回 true', () => {
      expect(isImeOrModifierEvent({ isComposing: true } as any)).toBe(true);
      expect(
        isImeOrModifierEvent({ nativeEvent: { isComposing: true } } as any)
      ).toBe(true);
      expect(isImeOrModifierEvent({ keyCode: 229 } as any)).toBe(true);
      expect(isImeOrModifierEvent({ key: 'Process' } as any)).toBe(true);
    });

    it('常规字符按键返回 false', () => {
      expect(isImeOrModifierEvent({ key: 'c', keyCode: 67 } as any)).toBe(
        false
      );
    });
  });

  describe('3. TypeaheadBuffer 字符即时检索与 600ms 动态窗口', () => {
    const sampleItems: TypeaheadItem[] = [
      { id: '1', textValue: 'Claude' },
      { id: '2', textValue: 'Codex' },
      { id: '3', textValue: 'ChatGPT' },
      { id: '4', textValue: 'DeepSeek' },
      { id: '5', textValue: 'New Session' },
      { id: '6', textValue: 'New Chat' },
      { id: '7', textValue: 'Disabled Item', disabled: true },
    ];

    it('单字符检索：键入 "c"，命中首个以 "c" 开头的项', () => {
      const onMatch = vi.fn();
      const currentIndex = -1;
      const buffer = new TypeaheadBuffer({
        getItems: () => sampleItems,
        getCurrentIndex: () => currentIndex,
        onMatch,
        timeoutMs: 600,
      });

      const event = {
        key: 'c',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent;

      const handled = buffer.handleKeyDown(event);
      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(onMatch).toHaveBeenCalledWith(0, sampleItems[0]); // Claude
      expect(buffer.getBuffer()).toBe('c');
    });

    it('单字符轮转 (Cycling)：连续输入相同单字符，依次循环查找下一个匹配项', () => {
      const onMatch = vi.fn();
      let currentIndex = 0; // 当前在 Claude (0)
      const buffer = new TypeaheadBuffer({
        getItems: () => sampleItems,
        getCurrentIndex: () => currentIndex,
        onMatch,
        timeoutMs: 600,
      });

      // 第一次键入 'c'
      buffer.handleKeyDown({
        key: 'c',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);

      expect(onMatch).toHaveBeenLastCalledWith(1, sampleItems[1]); // Codex (1)
      currentIndex = 1;

      // 300ms 内再次键入 'c'（相同字符轮转）
      vi.advanceTimersByTime(300);
      buffer.handleKeyDown({
        key: 'c',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);

      expect(onMatch).toHaveBeenLastCalledWith(2, sampleItems[2]); // ChatGPT (2)
      currentIndex = 2;

      // 再次键入 'c'，应该跨越末尾无匹配项，回卷至首项 Claude (0)
      vi.advanceTimersByTime(200);
      buffer.handleKeyDown({
        key: 'c',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);

      expect(onMatch).toHaveBeenLastCalledWith(0, sampleItems[0]); // Claude (0)
    });

    it('多字符前缀连续检索：快速键入 "d" -> "e" -> "e"，在 600ms 窗口内成功命中 "DeepSeek"', () => {
      const onMatch = vi.fn();
      let currentIndex = 0;
      const buffer = new TypeaheadBuffer({
        getItems: () => sampleItems,
        getCurrentIndex: () => currentIndex,
        onMatch,
        timeoutMs: 600,
      });

      // 键入 'd'
      buffer.handleKeyDown({
        key: 'd',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      expect(onMatch).toHaveBeenLastCalledWith(3, sampleItems[3]); // DeepSeek (3)
      currentIndex = 3;

      // 200ms 内键入 'e' -> buffer 变为 "de"
      vi.advanceTimersByTime(200);
      buffer.handleKeyDown({
        key: 'e',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      expect(buffer.getBuffer()).toBe('de');
      expect(onMatch).toHaveBeenLastCalledWith(3, sampleItems[3]); // 依然匹配 DeepSeek

      // 200ms 内再键入 'e' -> buffer 变为 "dee"
      vi.advanceTimersByTime(200);
      buffer.handleKeyDown({
        key: 'e',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      expect(buffer.getBuffer()).toBe('dee');
      expect(onMatch).toHaveBeenLastCalledWith(3, sampleItems[3]);
    });

    it('600ms 超时后自动重置缓冲区为空', () => {
      const onMatch = vi.fn();
      const buffer = new TypeaheadBuffer({
        getItems: () => sampleItems,
        getCurrentIndex: () => 0,
        onMatch,
        timeoutMs: 600,
      });

      buffer.handleKeyDown({
        key: 'c',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      expect(buffer.getBuffer()).toBe('c');

      // 推进 600ms
      vi.advanceTimersByTime(600);
      expect(buffer.getBuffer()).toBe('');
    });

    it('Space 空格键消歧：缓冲区为空时不拦截；缓冲区非空时作为文本追加', () => {
      const onMatch = vi.fn();
      let currentIndex = -1;
      const buffer = new TypeaheadBuffer({
        getItems: () => sampleItems,
        getCurrentIndex: () => currentIndex,
        onMatch,
        timeoutMs: 600,
      });

      // 1. 缓冲区为空时按下 Space
      const spaceEventEmpty = {
        key: ' ',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent;

      const emptyHandled = buffer.handleKeyDown(spaceEventEmpty);
      // 必须放行，不拦截，不调用 preventDefault
      expect(emptyHandled).toBe(false);
      expect(spaceEventEmpty.preventDefault).not.toHaveBeenCalled();
      expect(buffer.getBuffer()).toBe('');

      // 2. 先键入 'n' -> 'e' -> 'w'
      buffer.handleKeyDown({
        key: 'n',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      buffer.handleKeyDown({
        key: 'e',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      buffer.handleKeyDown({
        key: 'w',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      expect(buffer.getBuffer()).toBe('new');
      expect(onMatch).toHaveBeenLastCalledWith(4, sampleItems[4]); // New Session (4)
      currentIndex = 4;

      // 3. 在 600ms 窗口内按下 Space -> 必须作为字符追加到缓冲区并触发搜索
      const spaceEventNonEmpty = {
        key: ' ',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent;

      const nonEmptyHandled = buffer.handleKeyDown(spaceEventNonEmpty);
      expect(nonEmptyHandled).toBe(true);
      expect(spaceEventNonEmpty.preventDefault).toHaveBeenCalled();
      expect(buffer.getBuffer()).toBe('new ');

      // 4. 继续键入 'c' -> buffer 变为 "new c"
      buffer.handleKeyDown({
        key: 'c',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);
      expect(buffer.getBuffer()).toBe('new c');
      expect(onMatch).toHaveBeenLastCalledWith(5, sampleItems[5]); // New Chat (5)
    });

    it('自动跨越 disabled 条目，不产生命中', () => {
      const onMatch = vi.fn();
      const buffer = new TypeaheadBuffer({
        getItems: () => [
          { id: '1', textValue: 'Disabled Item', disabled: true },
          { id: '2', textValue: 'Default Option' },
        ],
        getCurrentIndex: () => -1,
        onMatch,
      });

      buffer.handleKeyDown({
        key: 'd',
        preventDefault: vi.fn(),
        target: document.createElement('div'),
      } as unknown as KeyboardEvent);

      // 必须跳过 'Disabled Item'，直接匹配 'Default Option'
      expect(onMatch).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ textValue: 'Default Option' })
      );
    });

    it('当事件 target 为可编辑元素时，handleKeyDown 直接返回 false，绝对不抢键', () => {
      const onMatch = vi.fn();
      const buffer = new TypeaheadBuffer({
        getItems: () => sampleItems,
        getCurrentIndex: () => 0,
        onMatch,
      });

      const input = document.createElement('input');
      const preventDefault = vi.fn();

      const handled = buffer.handleKeyDown({
        key: 'c',
        preventDefault,
        target: input,
      } as unknown as KeyboardEvent);

      expect(handled).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(onMatch).not.toHaveBeenCalled();
      expect(buffer.getBuffer()).toBe('');
    });
  });
});
