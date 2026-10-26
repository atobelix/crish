/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx
 * Tiptap ProseMirror field for chat composer with IME protection (CRM-03), keymaps, drop & paste handlers.
 * 40 方案 T3 补全：Mention 注册、CodeBlock Enter 保护、DOMPurify 粘贴清洗、动态占位符。
 * T8 扩展：Mention 建议（@ 触发，候选人引用桥接）、combobox aria 全链
 * （role/haspopup/autocomplete 常驻，expanded/controls/activedescendant 由 suggestion 生命周期驱动）。
 * F1-β 拆分 + Stage 05 增量块缓存 & IME/分栏拖拽双态联锁守卫：
 * 编辑器装配迁至 ./TiptapEditorExtensions，两级块缓存由 ./twoTierBlockEditorCache 承载，
 * IME 与拖拽期间的选区快照保护与外部受控延迟消费由 ./composerImeDragGuard 承载。
 * CI Guardrail: UI Component (Max 500 lines of effective code, Max 12 useState)
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';

import { useEditor, EditorContent } from '@tiptap/react';

import { exitSuggestion } from '@tiptap/suggestion';
import { slashSuggestionKey, mentionSuggestionKey } from './SlashExtension';
import { dirTreeSuggestionKey } from './DirTreeExtension';
import type { SlashCommandItem, MentionCandidate } from './composerTypes';
import { parseFromMarkdown } from './serialization/markdownDeserializer';
import {
  focusAndSelectFirstPlaceholder,
  resyncSlashTriggerAfterComposition,
} from './tiptapInjectionUtils';
import type {
  TiptapEditorFieldProps,
  TiptapEditorFieldHandle,
} from './composerTypes';
import {
  buildTiptapEditorOptions,
  serializeEditorToMarkdown,
  type TiptapEditorBridge,
  type TiptapEditorCallbacks,
} from './TiptapEditorExtensions';
import { IncrementalMarkdownSerializer } from './twoTierBlockEditorCache';
import {
  ComposerImeDragGuard,
  bindComposerCompositionLifecycle,
  restoreSelectionSafely,
  type ComposerSelectionSnapshot,
} from './composerImeDragGuard';
import styles from './TiptapEditorField.module.css';

/**
 * 安全取编辑器挂载后的 DOM 节点。
 *
 * tiptap v3 的 editor.view getter 在 EditorView 未挂载时返回 Proxy 兜底
 * （永不返回 null，故 `!editor.view` 型守卫失效），访问 view.dom 等属性
 * 会抛 "The editor view is not available. Cannot access view['dom']"。
 * 挂载/卸载竞态（React 18 StrictMode 双挂载、宿主 effect 早于 EditorContent
 * attach 等）下统一经本函数取值，未就绪一律返回 null，调用方静默跳过。
 */
function safeViewDom(
  editor: { view?: unknown; isDestroyed?: boolean } | null | undefined
): HTMLElement | null {
  try {
    if (!editor || editor.isDestroyed) return null;
    const dom = (editor.view as { dom?: HTMLElement } | undefined)?.dom;
    return dom ?? null;
  } catch {
    return null;
  }
}

function captureEditorSelection(editor: any): ComposerSelectionSnapshot {
  const from = editor?.state?.selection?.from ?? 0;
  const to = editor?.state?.selection?.to ?? from;
  return {
    selectionStart: from,
    selectionEnd: to,
    blockId: null,
    capturedAtMs: Date.now(),
  };
}

/** 编辑器最大长度防爆上限（与草稿截断一致，SRS 安全红线兜底） */
const COMPOSER_MAX_LENGTH = 100000;

export const TiptapEditorField = React.forwardRef<
  TiptapEditorFieldHandle,
  TiptapEditorFieldProps
>(
  (
    {
      placeholder = 'Type a message or press / for commands...',
      disabled = false,
      sendShortcut = 'enter',
      content,
      onSendMarkdown,
      onMarkdownChange,
      onCompositionChange,
      onDropFiles,
      onPasteImage,
      onPasteFiles,
      onOversizeWarning,
      ariaLabel,
      ariaExpanded,
      ariaControls,
      ariaHasPopup,
      ariaActivedescendant,
      ariaAutocomplete,
      slashExtraItems,
      mentionCandidates,
      autoFocus = false,
      containerRef,
    },
    ref
  ) => {
    const isComposingRef = useRef<boolean>(false);
    // 记录编辑器「已呈现」内容（发送/水合同步更新）；初始为 undefined 保证首帧水合执行
    const lastContentRef = useRef<string | undefined>(undefined);
    const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
    const editorRef = useRef<any>(null);
    const serializerRef = useRef<IncrementalMarkdownSerializer>(
      new IncrementalMarkdownSerializer()
    );
    const imeDragGuardRef = useRef<ComposerImeDragGuard>(
      new ComposerImeDragGuard()
    );

    // 弹层 listbox id 命名空间（斜杠/提及各一实例，aria-controls/activedescendant 全链）
    const listboxBaseId = useId();
    const slashListboxId = `${listboxBaseId}-slash`;
    const mentionListboxId = `${listboxBaseId}-mention`;
    const dirTreeListboxId = `${listboxBaseId}-dir-tree`;

    // ── 动态 prop 经 ref 桥接（编辑器装配一次性稳定，避免重建）─────────────────
    const placeholderRef = useRef<string>(placeholder ?? '');
    const sendShortcutRef = useRef<'enter' | 'ctrlEnter'>(sendShortcut);
    const slashExtraItemsRef = useRef<SlashCommandItem[]>([]);
    const mentionCandidatesRef = useRef<MentionCandidate[]>([]);
    const containerRefBridge = useRef<{ current: HTMLElement | null }>({
      get current() {
        if (!containerRef) return null;
        if (typeof containerRef === 'object' && 'current' in containerRef) {
          return (
            (containerRef as React.RefObject<HTMLElement | null>).current ??
            null
          );
        }
        return null;
      },
    });
    const callbacksRef = useRef<TiptapEditorCallbacks>({
      onSendMarkdown,
      onMarkdownChange,
      onCompositionChange,
      onDropFiles,
      onPasteImage,
      onPasteFiles,
      onOversizeWarning,
    });
    /** R-08：大文档警告已发标记（回落阈值以下后重置，避免每帧 spam） */
    const oversizeWarnedRef = useRef(false);

    useEffect(() => {
      placeholderRef.current = placeholder ?? '';
    }, [placeholder]);

    useEffect(() => {
      sendShortcutRef.current = sendShortcut;
    }, [sendShortcut]);

    useEffect(() => {
      slashExtraItemsRef.current = slashExtraItems ?? [];
    }, [slashExtraItems]);

    useEffect(() => {
      mentionCandidatesRef.current = Array.from(mentionCandidates ?? []);
    }, [mentionCandidates]);

    useEffect(() => {
      callbacksRef.current = {
        onSendMarkdown,
        onMarkdownChange,
        onCompositionChange,
        onDropFiles,
        onPasteImage,
        onPasteFiles,
        onOversizeWarning,
      };
    }, [
      onSendMarkdown,
      onMarkdownChange,
      onCompositionChange,
      onDropFiles,
      onPasteImage,
      onPasteFiles,
      onOversizeWarning,
    ]);

    // ── 编辑器装配（稳定实例）：extensions/onUpdate/editorProps 在
    //    TiptapEditorExtensions 组装，回调全部经 bridge 取最新值 ───────────────
    const editorBridge: TiptapEditorBridge = {
      placeholderRef,
      sendShortcutRef,
      slashExtraItemsRef,
      mentionCandidatesRef,
      containerRef: containerRefBridge.current,
      isComposingRef,
      lastContentRef,
      debounceTimerRef,
      editorRef,
      oversizeWarnedRef,
      callbacksRef,
      slashListboxId,
      mentionListboxId,
      dirTreeListboxId,
      serializerRef,
      imeDragGuardRef,
    };

    // 注意：装配一次性固定（useMemo 空依赖），bridge 内均为稳定 ref；
    // aria 属性为运行期动态值，走下方 DOM setAttribute 同步（不经装配重建）。
    const editorOptions = useMemo(
      () => buildTiptapEditorOptions(editorBridge),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    const editor = useEditor(editorOptions);

    useEffect(() => {
      editorRef.current = editor ?? null;
      return () => {
        editorRef.current = null;
      };
    }, [editor]);

    useEffect(() => {
      const serializer = serializerRef.current;
      const guard = imeDragGuardRef.current;
      return () => {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        serializer.getCache().clear();
        guard.reset();
      };
    }, []);

    // Keep editable state synced with disabled prop
    useEffect(() => {
      if (editor) {
        editor.setEditable(!disabled);
      }
    }, [editor, disabled]);

    // aria 属性动态同步（装配 attributes 静态，运行期经 DOM setAttribute 更新）。
    useEffect(() => {
      if (!editor) return;
      const dom = safeViewDom(editor);
      if (!dom) return;
      if (ariaLabel) dom.setAttribute('aria-label', ariaLabel);
      dom.setAttribute('role', 'combobox');
      dom.setAttribute('aria-haspopup', 'listbox');
      dom.setAttribute('aria-autocomplete', 'list');
      if (typeof ariaExpanded === 'boolean') {
        dom.setAttribute('aria-expanded', String(ariaExpanded));
      } else {
        dom.removeAttribute('aria-expanded');
      }
      if (ariaControls) {
        dom.setAttribute('aria-controls', ariaControls);
      } else {
        dom.removeAttribute('aria-controls');
      }
      if (ariaHasPopup !== undefined) {
        dom.setAttribute('aria-haspopup', String(ariaHasPopup));
      }
      if (ariaActivedescendant) {
        dom.setAttribute('aria-activedescendant', ariaActivedescendant);
      } else {
        dom.removeAttribute('aria-activedescendant');
      }
      if (ariaAutocomplete) {
        dom.setAttribute('aria-autocomplete', ariaAutocomplete);
      }
    }, [
      editor,
      ariaLabel,
      ariaExpanded,
      ariaControls,
      ariaHasPopup,
      ariaActivedescendant,
      ariaAutocomplete,
    ]);

    // 占位符切换（processing 双态）后强制重算装饰
    useEffect(() => {
      if (editor && !editor.isDestroyed && safeViewDom(editor)) {
        try {
          editor.view.dispatch(editor.state.tr);
        } catch {
          // 挂载竞态下 view 未就绪：跳过本次装饰重算（下一轮事务自然覆盖）
        }
      }
    }, [editor, placeholder]);

    const applyHydratedMarkdown = useCallback(
      (
        targetEditor: any,
        nextContent: string,
        selectionToRestore?: ComposerSelectionSnapshot | null
      ) => {
        if (!targetEditor || targetEditor.isDestroyed) return;
        try {
          const doc = parseFromMarkdown(nextContent);
          targetEditor.commands.setContent(doc);
          if (selectionToRestore) {
            restoreSelectionSafely(targetEditor, selectionToRestore);
          }
        } catch {
          // 挂载竞态下 view 未就绪：放弃本次水合（后续内容变更会再次触发）
        }
        lastContentRef.current = nextContent;
      },
      []
    );

    // Sync editor DOM content with content prop (CRM-02 Session Draft Hydration)
    // Stage 05 §4 & §5: 受 ComposerImeDragGuard 联锁保护，IME 合成或分栏拖拽期间延迟外部同步
    useEffect(() => {
      if (!editor || content === undefined) return;

      let safeContent = content;

      // 防爆内存截断策略（安全红线兜底：严格视口防 OOM）
      if (safeContent.length > COMPOSER_MAX_LENGTH) {
        safeContent =
          safeContent.slice(0, COMPOSER_MAX_LENGTH) +
          '\n\n>[!WARNING]\n>内容过长已被防爆截断，请清理后继续。';
      }

      // 编辑器默认就是空文档。不要把首次空值排进 rAF 再 setContent：
      // 用户可能已在首帧水合前输入，延迟写回空内容会覆盖这段新输入。
      if (lastContentRef.current === undefined && safeContent === '') {
        lastContentRef.current = '';
        return;
      }

      if (safeContent === lastContentRef.current) return;

      if (lastContentRef.current !== undefined) {
        const decision = imeDragGuardRef.current.tryApplyExternalSync(
          safeContent,
          lastContentRef.current
        );
        if (!decision.applyNow || decision.valueToApply === null) {
          return;
        }
        safeContent = decision.valueToApply;
      }

      // 采用 requestAnimationFrame 调度渲染，确保 120Hz/60Hz 不掉帧
      const rafId = requestAnimationFrame(() => {
        applyHydratedMarkdown(editor, safeContent);
      });
      return () => cancelAnimationFrame(rafId);
    }, [editor, content, applyHydratedMarkdown]);

    // 动态同步禁用态至 Tiptap 内部 ProseMirror 编辑器
    useEffect(() => {
      if (!editor || editor.isDestroyed) return;
      editor.setEditable(!disabled);
    }, [editor, disabled]);

    // Track composition & drag events directly on the editor DOM node for CJK + split-pane drag protection
    useEffect(() => {
      const dom = safeViewDom(editor);
      if (!dom) return;

      const handleDragStart = () => {
        imeDragGuardRef.current.beginDrag(captureEditorSelection(editor));
      };

      const handleDragEnd = () => {
        const { deferredValue, restoredSelection } =
          imeDragGuardRef.current.endDrag();
        if (
          deferredValue !== null &&
          deferredValue !== lastContentRef.current
        ) {
          requestAnimationFrame(() => {
            applyHydratedMarkdown(editor, deferredValue, restoredSelection);
          });
        } else if (restoredSelection) {
          restoreSelectionSafely(editor, restoredSelection);
        }
      };

      const unbindCompositionLifecycle = bindComposerCompositionLifecycle({
        dom,
        composingRef: isComposingRef,
        guard: imeDragGuardRef.current,
        captureSelection: () => captureEditorSelection(editor),
        getCurrentContent: () => lastContentRef.current,
        onCompositionChange: (composing) =>
          callbacksRef.current.onCompositionChange?.(composing),
        applyDeferred: (content, selection) =>
          applyHydratedMarkdown(editor, content, selection),
        resyncSlashTrigger: () => resyncSlashTriggerAfterComposition(editor),
      });
      dom.addEventListener('dragstart', handleDragStart);
      dom.addEventListener('dragend', handleDragEnd);

      return () => {
        unbindCompositionLifecycle();
        dom.removeEventListener('dragstart', handleDragStart);
        dom.removeEventListener('dragend', handleDragEnd);
      };
    }, [editor, applyHydratedMarkdown]);

    // Esc 退出建议状态（capture 阶段兜底）
    useEffect(() => {
      if (!editor) return;
      const dom = safeViewDom(editor);
      if (!dom) return;
      const onEscapeCapture = (e: KeyboardEvent) => {
        // 关键防线：IME 合成态下绝不拦截 Esc
        const isIme =
          e.isComposing ||
          (e as any).nativeEvent?.isComposing ||
          e.keyCode === 229 ||
          e.key === 'Process';
        if (isIme || e.key !== 'Escape') return;

        const view = editor.view;
        if (!view?.state) return;
        if (slashSuggestionKey.getState(view.state)?.active) {
          exitSuggestion(view, slashSuggestionKey);
        }
        if (mentionSuggestionKey.getState(view.state)?.active) {
          exitSuggestion(view, mentionSuggestionKey);
        }
        if (dirTreeSuggestionKey.getState(view.state)?.active) {
          exitSuggestion(view, dirTreeSuggestionKey);
        }
      };
      dom.addEventListener('keydown', onEscapeCapture, true);
      return () => dom.removeEventListener('keydown', onEscapeCapture, true);
    }, [editor]);

    // autoFocus：挂载后聚焦编辑器（rAF 等待布局稳定）
    const focusEditor = useCallback(() => {
      try {
        editorRef.current?.commands.focus();
      } catch {
        // 挂载竞态下 view 未就绪：忽略本次聚焦（用户点击会自行聚焦）
      }
    }, []);

    useEffect(() => {
      if (!autoFocus) return;
      const id = requestAnimationFrame(focusEditor);
      return () => cancelAnimationFrame(id);
    }, [autoFocus, focusEditor]);

    // 命令式句柄：发送前同步取最新 markdown（绕过防抖，走两级块缓存增量序列化）
    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => {
          const currentEditor = editorRef.current;
          if (!currentEditor) return '';
          return (
            serializeEditorToMarkdown(
              currentEditor,
              serializerRef.current
            ).trim() || currentEditor.getText().trim()
          );
        },
        focusPlaceholder: () => {
          const currentEditor = editorRef.current;
          if (!currentEditor) return false;
          return focusAndSelectFirstPlaceholder(currentEditor);
        },
      }),
      []
    );

    return (
      <div
        className={`${styles.fieldWrapper}${disabled ? ` ${styles.disabled}` : ''}`}
        onClick={() => {
          if (!disabled && editor) {
            editor.commands.focus();
          }
        }}
      >
        <EditorContent editor={editor} />
      </div>
    );
  }
);
TiptapEditorField.displayName = 'TiptapEditorField';
