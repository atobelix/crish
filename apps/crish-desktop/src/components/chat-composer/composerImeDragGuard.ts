/**
 * 富文本输入器 IME 合成与分栏拖拽双态联锁守卫（Stage 05 §4 & §5）
 *
 * 职责：
 * 1. 维护 composing（IME 组合输入）与 dragging（分栏拖拽/指针捕获）双布尔联锁状态机；
 * 2. 在 locked (composing || dragging) 期间拦截外部 store/prop 的受控覆盖，将其延迟到 pendingExternalValue；
 * 3. 在 beginDrag / beginComposition 时拍摄选区快照（selectionStart, selectionEnd, blockId），
 *    并在双锁同时解除的微任务边界原子恢复选区并消费延迟的外部同步值；
 * 4. 在拖拽态提供按键白名单判定与最小区间差分（Prefix/Suffix 扫描）辅助函数。
 */

export interface ComposerSelectionSnapshot {
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly blockId: string | null;
  readonly capturedAtMs: number;
}

export interface ImeDragGuardDiagnostics {
  readonly composing: boolean;
  readonly dragging: boolean;
  readonly isLocked: boolean;
  readonly hasPendingExternalValue: boolean;
  readonly deferredSyncCount: number;
  readonly flushedSyncCount: number;
  readonly selectionRestorations: number;
}

export interface MinimalTextDiff {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export interface SelectionRestorableEditorLike {
  readonly isDestroyed?: boolean;
  readonly state: {
    readonly doc: {
      readonly content: {
        readonly size: number;
      };
    };
  };
  readonly commands: {
    readonly setTextSelection: (
      range: { from: number; to: number } | number
    ) => boolean;
  };
}

export interface ComposerCompositionLifecycleOptions {
  readonly dom: HTMLElement;
  readonly composingRef: { current: boolean };
  readonly guard: ComposerImeDragGuard;
  readonly captureSelection: () => ComposerSelectionSnapshot;
  readonly getCurrentContent: () => string | undefined;
  readonly onCompositionChange?: (composing: boolean) => void;
  readonly applyDeferred: (
    content: string,
    selection: ComposerSelectionSnapshot | null
  ) => void;
  readonly resyncSlashTrigger: () => void;
}

const DRAG_ALLOWED_KEYS = new Set<string>([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Backspace',
  'Delete',
  'Enter',
  ' ',
  'Home',
  'End',
  'Tab',
  'Escape',
]);

const DRAG_ALLOWED_SHORTCUT_KEYS = new Set<string>([
  'z',
  'y',
  'a',
  'c',
  'v',
  'x',
]);

export class ComposerImeDragGuard {
  private composing = false;
  private dragging = false;
  private pendingExternalValue: string | null = null;
  private selectionSnapshot: ComposerSelectionSnapshot | null = null;

  private deferredSyncCount = 0;
  private flushedSyncCount = 0;
  private selectionRestorations = 0;

  beginComposition(snapshot?: ComposerSelectionSnapshot): void {
    this.composing = true;
    if (snapshot) {
      this.selectionSnapshot = snapshot;
    }
  }

  endComposition(): string | null {
    if (!this.composing) return null;
    this.composing = false;
    return this.consumeDeferredIfUnlocked();
  }

  /**
   * 编辑器失焦时结束组合；失焦也终止并发拖拽，消费延迟值且丢弃旧选区快照。
   */
  settleCompositionOnBlur(): string | null {
    if (!this.composing) return null;
    this.composing = false;
    this.dragging = false;
    const deferred = this.consumeDeferredIfUnlocked();
    this.selectionSnapshot = null;
    return deferred;
  }

  beginDrag(snapshot: ComposerSelectionSnapshot): void {
    this.dragging = true;
    this.selectionSnapshot = snapshot;
  }

  endDrag(): {
    deferredValue: string | null;
    restoredSelection: ComposerSelectionSnapshot | null;
  } {
    this.dragging = false;
    const deferredValue = this.consumeDeferredIfUnlocked();
    const restoredSelection = !this.composing ? this.selectionSnapshot : null;
    if (restoredSelection) {
      this.selectionRestorations += 1;
      this.selectionSnapshot = null;
    }
    return { deferredValue, restoredSelection };
  }

  isLocked(): boolean {
    return this.composing || this.dragging;
  }

  isComposing(): boolean {
    return this.composing;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  /**
   * 外部状态（如草稿水合、跨窗格同步）试图写入编辑器时的联锁守卫：
   * - 若与当前本地值相同，丢弃冗余更新；
   * - 若处于 composing || dragging 锁定态，缓存至 pendingExternalValue，返回 applyNow: false；
   * - 若未锁定，允许立即同步。
   */
  tryApplyExternalSync(
    incomingValue: string,
    currentLocalValue: string
  ): { applyNow: boolean; valueToApply: string | null } {
    if (incomingValue === currentLocalValue) {
      this.pendingExternalValue = null;
      return { applyNow: false, valueToApply: null };
    }

    if (this.isLocked()) {
      this.pendingExternalValue = incomingValue;
      this.deferredSyncCount += 1;
      return { applyNow: false, valueToApply: null };
    }

    return { applyNow: true, valueToApply: incomingValue };
  }

  /**
   * 显式消费延迟的外部值（仅在未锁定态有效）
   */
  consumeDeferredExternalSync(currentLocalValue?: string): string | null {
    const flushed = this.consumeDeferredIfUnlocked();
    if (flushed === null) return null;
    if (currentLocalValue !== undefined && flushed === currentLocalValue) {
      return null;
    }
    return flushed;
  }

  /**
   * 拖拽期间按键白名单判定
   */
  isKeyWhitelistedDuringDrag(event: {
    key: string;
    isComposing?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
  }): boolean {
    if (!this.dragging) return true;
    if (event.isComposing || event.key === 'Process') return true;
    if (DRAG_ALLOWED_KEYS.has(event.key)) return true;

    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      DRAG_ALLOWED_SHORTCUT_KEYS.has(event.key.toLowerCase())
    ) {
      return true;
    }

    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      return true;
    }

    return false;
  }

  getSelectionSnapshot(): ComposerSelectionSnapshot | null {
    return this.selectionSnapshot;
  }

  getDiagnostics(): ImeDragGuardDiagnostics {
    return {
      composing: this.composing,
      dragging: this.dragging,
      isLocked: this.isLocked(),
      hasPendingExternalValue: this.pendingExternalValue !== null,
      deferredSyncCount: this.deferredSyncCount,
      flushedSyncCount: this.flushedSyncCount,
      selectionRestorations: this.selectionRestorations,
    };
  }

  reset(): void {
    this.composing = false;
    this.dragging = false;
    this.pendingExternalValue = null;
    this.selectionSnapshot = null;
    this.deferredSyncCount = 0;
    this.flushedSyncCount = 0;
    this.selectionRestorations = 0;
  }

  private consumeDeferredIfUnlocked(): string | null {
    if (this.isLocked()) {
      return null;
    }
    const pending = this.pendingExternalValue;
    if (pending !== null) {
      this.pendingExternalValue = null;
      this.flushedSyncCount += 1;
      return pending;
    }
    return null;
  }
}

/** 在编辑器 DOM 和窗口失焦时收束 IME 状态；迟到事件由 composingRef 幂等拦截。 */
export function bindComposerCompositionLifecycle({
  dom,
  composingRef,
  guard,
  captureSelection,
  getCurrentContent,
  onCompositionChange,
  applyDeferred,
  resyncSlashTrigger,
}: ComposerCompositionLifecycleOptions): () => void {
  const handleCompositionStart = () => {
    if (composingRef.current) return;
    composingRef.current = true;
    guard.beginComposition(captureSelection());
    onCompositionChange?.(true);
  };

  const settleComposition = (fromBlur: boolean) => {
    if (!composingRef.current) return;
    composingRef.current = false;
    const deferred = fromBlur
      ? guard.settleCompositionOnBlur()
      : guard.endComposition();
    onCompositionChange?.(false);
    if (deferred !== null && deferred !== getCurrentContent()) {
      requestAnimationFrame(() =>
        applyDeferred(deferred, guard.getSelectionSnapshot())
      );
    } else if (!fromBlur) {
      requestAnimationFrame(resyncSlashTrigger);
    }
  };

  const handleCompositionEnd = () => settleComposition(false);
  const handleBlur = () => settleComposition(true);

  dom.addEventListener('compositionstart', handleCompositionStart);
  dom.addEventListener('compositionend', handleCompositionEnd);
  dom.addEventListener('blur', handleBlur);
  dom.addEventListener('focusout', handleBlur);
  window.addEventListener('blur', handleBlur);

  return () => {
    dom.removeEventListener('compositionstart', handleCompositionStart);
    dom.removeEventListener('compositionend', handleCompositionEnd);
    dom.removeEventListener('blur', handleBlur);
    dom.removeEventListener('focusout', handleBlur);
    window.removeEventListener('blur', handleBlur);
  };
}

/**
 * 安全恢复选区快照（自动根据当前文档大小钳制 [from, to]，防止越界异常）
 */
export function restoreSelectionSafely(
  editor: SelectionRestorableEditorLike | null | undefined,
  snapshot: ComposerSelectionSnapshot | null | undefined
): boolean {
  if (!editor || editor.isDestroyed || !snapshot) return false;
  const maxPos = Math.max(0, editor.state.doc.content.size);
  const clampedFrom = Math.max(0, Math.min(snapshot.selectionStart, maxPos));
  const clampedTo = Math.max(
    clampedFrom,
    Math.min(snapshot.selectionEnd, maxPos)
  );
  return editor.commands.setTextSelection({ from: clampedFrom, to: clampedTo });
}

/**
 * O(N) 双指针计算新旧字符串的最小差分编辑区间
 */
export function computeMinimalTextDiff(
  prevText: string,
  nextText: string
): MinimalTextDiff | null {
  if (prevText === nextText) return null;

  const minLen = Math.min(prevText.length, nextText.length);
  let prefixLen = 0;
  while (
    prefixLen < minLen &&
    prevText.charCodeAt(prefixLen) === nextText.charCodeAt(prefixLen)
  ) {
    prefixLen += 1;
  }

  let prevSuffixIdx = prevText.length;
  let nextSuffixIdx = nextText.length;
  while (
    prevSuffixIdx > prefixLen &&
    nextSuffixIdx > prefixLen &&
    prevText.charCodeAt(prevSuffixIdx - 1) ===
      nextText.charCodeAt(nextSuffixIdx - 1)
  ) {
    prevSuffixIdx -= 1;
    nextSuffixIdx -= 1;
  }

  return {
    from: prefixLen,
    to: prevSuffixIdx,
    insert: nextText.slice(prefixLen, nextSuffixIdx),
  };
}
