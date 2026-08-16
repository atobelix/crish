/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx
 * Tiptap ProseMirror field for chat composer with IME protection (CRM-03), keymaps, drop & paste handlers.
 * 40 方案 T3 补全：Mention 注册、CodeBlock Enter 保护、DOMPurify 粘贴清洗、动态占位符。
 * T8 扩展：Mention 建议（@ 触发，候选人引用桥接）、combobox aria 全链
 * （role/haspopup/autocomplete 常驻，expanded/controls/activedescendant 由 suggestion 生命周期驱动）。
 * F1-β 拆分：编辑器装配（extensions/onUpdate/editorProps）迁至 ./TiptapEditorExtensions，
 * Enter/IME keymap 决策迁至 ./TiptapKeymap（纯函数）；本文件保留核心编辑器装配壳
 * （ref 桥接 + 生命周期 effects + forwardRef handle + IME DOM 保护 + 渲染）。
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
import type { SlashCommandItem, MentionCandidate } from './composerTypes';
import { serializeToMarkdown } from './serialization/markdownSerializer';
import { parseFromMarkdown } from './serialization/markdownDeserializer';
import type {
  TiptapEditorFieldProps,
  TiptapEditorFieldHandle,
} from './composerTypes';
import {
  buildTiptapEditorOptions,
  type TiptapEditorBridge,
  type TiptapEditorCallbacks,
} from './TiptapEditorExtensions';
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
    // 弹层 listbox id 命名空间（斜杠/提及各一实例，aria-controls/activedescendant 全链）
    const listboxBaseId = useId();
    const slashListboxId = `${listboxBaseId}-slash`;
    const mentionListboxId = `${listboxBaseId}-mention`;

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
        onOversizeWarning,
      };
    }, [
      onSendMarkdown,
      onMarkdownChange,
      onCompositionChange,
      onDropFiles,
      onPasteImage,
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
      return () => {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
      };
    }, []);

    // Keep editable state synced with disabled prop
    useEffect(() => {
      if (editor) {
        editor.setEditable(!disabled);
      }
    }, [editor, disabled]);

    // aria 属性动态同步（装配 attributes 静态，运行期经 DOM setAttribute 更新）。
    // combobox 基链（role/haspopup/autocomplete）常驻：斜杠与提及双菜单均为 listbox；
    // expanded/controls/activedescendant 优先由宿主 props 驱动，运行期弹层打开时
    // 由 suggestion 生命周期（SlashExtension render 工厂）直接置位，两者不会互踩
    // （宿主 props 恒定 undefined 时仅在挂载期执行一次移除）。
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

    // Sync editor DOM content with content prop (CRM-02 Session Draft Hydration)
    // 性能优化：流式输出与海量节点场景下，移除 O(N) 的 currentMarkdown 序列化
    // 添加内存截断防爆策略
    useEffect(() => {
      if (!editor || content === undefined) return;

      let safeContent = content;

      // 防爆内存截断策略（安全红线兜底：严格视口防 OOM）
      if (safeContent.length > COMPOSER_MAX_LENGTH) {
        safeContent =
          safeContent.slice(0, COMPOSER_MAX_LENGTH) +
          '\n\n>[!WARNING]\n>内容过长已被防爆截断，请清理后继续。';
      }

      if (safeContent === lastContentRef.current) return;

      // 采用 requestAnimationFrame 调度渲染，确保 120Hz/60Hz 不掉帧
      // 卸载清理：组件销毁后回调不再触碰编辑器（防 destroyed 编辑器空指针）
      const rafId = requestAnimationFrame(() => {
        if (!editor || editor.isDestroyed) return;
        try {
          const doc = parseFromMarkdown(safeContent);
          editor.commands.setContent(doc);
        } catch {
          // 挂载竞态下 view 未就绪：放弃本次水合（后续内容变更会再次触发）
        }
        lastContentRef.current = safeContent;
      });
      return () => cancelAnimationFrame(rafId);
    }, [editor, content]);

    // Track composition events directly on the editor DOM node for CJK protection
    useEffect(() => {
      const dom = safeViewDom(editor);
      if (!dom) return;

      const handleCompositionStart = () => {
        isComposingRef.current = true;
        callbacksRef.current.onCompositionChange?.(true);
      };

      const handleCompositionEnd = () => {
        isComposingRef.current = false;
        callbacksRef.current.onCompositionChange?.(false);
      };

      dom.addEventListener('compositionstart', handleCompositionStart);
      dom.addEventListener('compositionend', handleCompositionEnd);

      return () => {
        dom.removeEventListener('compositionstart', handleCompositionStart);
        dom.removeEventListener('compositionend', handleCompositionEnd);
      };
    }, [editor]);

    // Esc 退出建议状态（capture 阶段兜底）：Radix 弹层在 document-capture 已对
    // Escape preventDefault，PM 的 keydown 链因 defaultPrevented 被整体跳过
    // （prosemirror-view eventBelongsToView），suggestion 插件收不到 Esc，
    // 弹层与 combobox aria 链会滞留。此处以捕获监听直接派发 exit 事务，
    // 走 onExit 统一清理（aria-expanded/controls/activedescendant + 弹层销毁）。
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

    // 命令式句柄：发送前同步取最新 markdown（绕过防抖）
    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => {
          const editor = editorRef.current;
          if (!editor) return '';
          return (
            serializeToMarkdown(editor.getJSON()).trim() ||
            editor.getText().trim()
          );
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
