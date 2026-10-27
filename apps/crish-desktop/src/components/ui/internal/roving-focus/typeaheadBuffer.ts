import { useRef, useEffect, useCallback } from 'react';
import type React from 'react';
import type { TypeaheadItem, TypeaheadOptions } from './types';

/**
 * 守卫：识别当前事件目标是否处于可编辑区域（Input、Textarea、Select、Tiptap、xterm 终端、Monaco 等）
 * 严格防止在打字时被 Typeahead 误捕获并吞掉击键
 */
export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  const contentEditableAttr = target.getAttribute('contenteditable');
  if (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    target.isContentEditable ||
    contentEditableAttr === 'true' ||
    contentEditableAttr === '' ||
    target.getAttribute('role') === 'textbox'
  ) {
    return true;
  }
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"], .xterm, [data-slate-editor], .tiptap, .monaco-editor'
    ) != null
  );
}

/**
 * 检查按键是否处于 CJK 输入法合成态或包含修饰键
 */
export function isImeOrModifierEvent(
  event: KeyboardEvent | React.KeyboardEvent<HTMLElement>
): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return true;
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  const isComposing =
    ('isComposing' in event && Boolean((event as KeyboardEvent).isComposing)) ||
    Boolean(native?.isComposing) ||
    event.keyCode === 229 ||
    event.key === 'Process';
  return isComposing;
}

/**
 * 纯逻辑 Typeahead 缓冲区管理器（零 React 状态依赖，便于极限边界单测）
 */
export class TypeaheadBuffer<T extends TypeaheadItem = TypeaheadItem> {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private options: TypeaheadOptions<T>;

  constructor(options: TypeaheadOptions<T>) {
    this.options = options;
  }

  updateOptions(options: TypeaheadOptions<T>): void {
    this.options = options;
  }

  getBuffer(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = '';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 核心按键分发与字符检索跳转
   * @returns boolean 是否消费并处理了该击键
   */
  handleKeyDown(
    event: KeyboardEvent | React.KeyboardEvent<HTMLElement>
  ): boolean {
    // 1. 守卫：拦截可编辑元素（Input, Textarea, Select, Tiptap, xterm 终端绝对不抢键）
    if (isEditableElement(event.target)) {
      return false;
    }

    // 2. 守卫：拦截修饰键（Ctrl/Alt/Meta）与 CJK IME 组合态（isComposing / 229）
    if (isImeOrModifierEvent(event)) {
      return false;
    }

    const key = event.key;

    // 3. Space 空格键双重语义消歧
    if (key === ' ' || key === 'Spacebar') {
      if (!this.buffer) {
        // 缓冲区为空：视为空格激活操作（Action Activation），绝对不拦截，放行给 onSelect
        return false;
      }
      // 缓冲区非空且在时间窗口内：追加空格进行多字符前缀匹配
      event.preventDefault();
      this.buffer += ' ';
    } else if (key.length === 1) {
      // 4. 常规单字符按键
      event.preventDefault();
      const lowerKey = key.toLowerCase();
      // 单字符轮转判定：如果当前缓冲区长度为 1 且与当前键入字符相同（例如连续按下 'c'）
      if (this.buffer.length === 1 && this.buffer.toLowerCase() === lowerKey) {
        // 保持单字符用于 cycling 轮转查找
      } else {
        // 否则追加形成多字符连续检索前缀（例如 'c' -> 'o' -> 'd'）
        this.buffer += lowerKey;
      }
    } else {
      // 非单字符按键（ArrowDown, Enter, Escape 等）放行
      return false;
    }

    // 重置 600ms 动态时间窗口
    if (this.timer) {
      clearTimeout(this.timer);
    }
    const timeoutMs = this.options.timeoutMs ?? 600;
    this.timer = setTimeout(() => {
      this.buffer = '';
      this.timer = null;
    }, timeoutMs);

    // 5. 执行检索匹配
    const items = this.options.getItems();
    if (!items || items.length === 0) {
      return true;
    }

    const searchStr = this.buffer.toLowerCase();
    const currentIndex = this.options.getCurrentIndex();

    if (searchStr.length === 1) {
      // 单字符轮转：从 (currentIndex + 1) 开始循环查找下一个首字符命中项
      for (let i = 1; i <= items.length; i++) {
        const idx = (currentIndex + i) % items.length;
        const item = items[idx];
        if (item && !item.disabled && !item.isSeparator) {
          const text = (item.textValue || '').trim().toLowerCase();
          if (text.startsWith(searchStr)) {
            this.options.onMatch(idx, item);
            return true;
          }
        }
      }
    } else {
      // 多字符前缀匹配：从 0 开始查找全文首个命中项
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && !item.disabled && !item.isSeparator) {
          const text = (item.textValue || '').trim().toLowerCase();
          if (text.startsWith(searchStr)) {
            this.options.onMatch(i, item);
            return true;
          }
        }
      }
    }

    return true;
  }

  destroy(): void {
    this.reset();
  }
}

/**
 * React Hook 封装：管理 Typeahead 缓冲区生命周期与按键分发
 */
export function useTypeaheadBuffer<T extends TypeaheadItem = TypeaheadItem>(
  options: TypeaheadOptions<T>
): {
  handleKeyDown: (
    event: KeyboardEvent | React.KeyboardEvent<HTMLElement>
  ) => boolean;
  resetBuffer: () => void;
  getBuffer: () => string;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const bufferInstanceRef = useRef<TypeaheadBuffer<T> | null>(null);
  if (!bufferInstanceRef.current) {
    bufferInstanceRef.current = new TypeaheadBuffer<T>({
      getItems: () => optionsRef.current.getItems(),
      getCurrentIndex: () => optionsRef.current.getCurrentIndex(),
      onMatch: (idx, item) => optionsRef.current.onMatch(idx, item),
      timeoutMs: options.timeoutMs ?? 600,
    });
  }

  useEffect(() => {
    bufferInstanceRef.current?.updateOptions({
      getItems: () => optionsRef.current.getItems(),
      getCurrentIndex: () => optionsRef.current.getCurrentIndex(),
      onMatch: (idx, item) => optionsRef.current.onMatch(idx, item),
      timeoutMs: options.timeoutMs ?? 600,
    });
  }, [options.timeoutMs]);

  useEffect(() => {
    return () => {
      bufferInstanceRef.current?.destroy();
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent | React.KeyboardEvent<HTMLElement>) => {
      return bufferInstanceRef.current
        ? bufferInstanceRef.current.handleKeyDown(e)
        : false;
    },
    []
  );

  const resetBuffer = useCallback(() => {
    bufferInstanceRef.current?.reset();
  }, []);

  const getBuffer = useCallback(() => {
    return bufferInstanceRef.current
      ? bufferInstanceRef.current.getBuffer()
      : '';
  }, []);

  return { handleKeyDown, resetBuffer, getBuffer };
}
