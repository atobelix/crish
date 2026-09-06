/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TiptapEditorField 编辑器装配（F1-β 拆分）：
 * - buildTiptapEditorOptions：extensions + onUpdate + editorProps（keydown/drop/paste）
 *   一次性稳定装配（useMemo 空依赖），运行期动态 prop 全部经 ref 桥（bridge）取最新值，
 *   避免 tiptap v3 useEditor 每渲染 setOptions 重建 ExtensionManager。
 * - Enter/IME 决策来自 ./TiptapKeymap（纯函数）。
 */
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import DOMPurify from 'dompurify';
import {
  SlashExtension,
  MentionExtension,
  MentionSuggestionExtension,
  slashSuggestionKey,
  mentionSuggestionKey,
} from './SlashExtension';
import { DirTreeExtension, dirTreeSuggestionKey } from './DirTreeExtension';
import { openFileInPanel } from '../../api/filePanelOpener';
import { serializeToMarkdown } from './serialization/markdownSerializer';
import { isImeComposition, resolveTiptapKeydown } from './TiptapKeymap';
import { readCodeBlockIndent } from '../../api/codeBlockIndent';
import type { SlashCommandItem, MentionCandidate } from './composerTypes';
import styles from './TiptapEditorField.module.css';

/**
 * 大文档序列化警告阈值（R-08，08-detail T5.5）：建议 50KB，
 * 实现时按压测校准（100KB 级序列化全量同步成本见 07 审计 R-08）。
 * 超过阈值在防抖窗口末帧 / 发送路径回调 onOversizeWarning（宿主 toast）。
 */
export const SERIALIZE_WARN_CHARS = 50000;

/** 编辑器运行期回调（宿主经 ref 桥接，装配不重建） */
export interface TiptapEditorCallbacks {
  onSendMarkdown?: (markdown: string) => void;
  onMarkdownChange?: (markdown: string) => void;
  onCompositionChange?: (isComposing: boolean) => void;
  onDropFiles?: (files: File[]) => void;
  onPasteImage?: (file: File, event: ClipboardEvent) => void;
  onOversizeWarning?: (charCount: number) => void;
}

/**
 * 编辑器装配所需全部 ref 桥（结构类型，接受 useRef 返回值 / 派生对象）。
 * 装配只依赖这些稳定引用，故 useMemo 空依赖安全。
 */
export interface TiptapEditorBridge {
  placeholderRef: { current: string };
  sendShortcutRef: { current: 'enter' | 'ctrlEnter' };
  slashExtraItemsRef: { current: SlashCommandItem[] };
  mentionCandidatesRef: { current: MentionCandidate[] };
  containerRef: { current: HTMLElement | null };
  isComposingRef: { current: boolean };
  lastContentRef: { current: string | undefined };
  debounceTimerRef: { current: NodeJS.Timeout | null };
  editorRef: { current: any };
  oversizeWarnedRef: { current: boolean };
  callbacksRef: { current: TiptapEditorCallbacks };
  slashListboxId: string;
  mentionListboxId: string;
  dirTreeListboxId?: string;
}

/**
 * R-08：序列化结果大文档检查（防抖末帧 / 发送路径共用）。
 * 超过阈值且未警告过 → 回调宿主（toast）；回落阈值以下后允许再次警告。
 */
function createOversizeWatcher(bridge: TiptapEditorBridge) {
  return (markdown: string): void => {
    const len = markdown?.length ?? 0;
    if (len > SERIALIZE_WARN_CHARS) {
      if (!bridge.oversizeWarnedRef.current) {
        bridge.oversizeWarnedRef.current = true;
        bridge.callbacksRef.current.onOversizeWarning?.(len);
      }
    } else if (bridge.oversizeWarnedRef.current) {
      bridge.oversizeWarnedRef.current = false;
    }
  };
}

/**
 * 一次性稳定装配：extensions + onUpdate + editorProps。
 * 注意：装配一次性固定（调用方 useMemo 空依赖），回调全部经 bridge 取最新值；
 * aria 属性为运行期动态值，走 DOM setAttribute 同步（不经装配重建）。
 */
export function buildTiptapEditorOptions(bridge: TiptapEditorBridge) {
  const checkOversize = createOversizeWatcher(bridge);

  const extensions = [
    StarterKit.configure({
      // 彻底禁用所有块级博客排版节点，对话输入框保持纯净行内修饰流
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      blockquote: false,
      codeBlock: {}, // 保留行内与围栏代码块结构，提供 Enter 换行保护
      horizontalRule: false,
      dropcursor: false,
      gapcursor: false,
      link: false,
    }),
    Placeholder.configure({
      // 动态占位符：函数形式每次装饰时读取最新值（processing 双态）
      placeholder: () => bridge.placeholderRef.current ?? '',
    }),
    // 链接 mark 注册（对齐序列化 link 分支，[text](url) 水合保真；不自动链接）
    Link.configure({
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
    }),
    MentionExtension,
    // 宿主系统/skill 命令以引用桥接，动态更新无需重建编辑器
    SlashExtension.configure({
      extraItemsRef: bridge.slashExtraItemsRef,
      listboxId: bridge.slashListboxId,
      containerRef: bridge.containerRef,
    }),
    // @ 提及建议（候选人引用桥接；空列表兜底不弹面板）
    MentionSuggestionExtension.configure({
      candidatesRef: bridge.mentionCandidatesRef,
      listboxId: bridge.mentionListboxId,
      containerRef: bridge.containerRef,
    }),
    DirTreeExtension.configure({
      listboxId: bridge.dirTreeListboxId,
      containerRef: bridge.containerRef,
    }),
  ];

  return {
    extensions,
    onUpdate: ({ editor }: any) => {
      // 性能优化：防抖处理海量节点下的 serializeToMarkdown 计算，避免主线程卡顿
      if (bridge.debounceTimerRef.current) {
        clearTimeout(bridge.debounceTimerRef.current);
      }
      bridge.debounceTimerRef.current = setTimeout(() => {
        const markdown = serializeToMarkdown(editor.getJSON());
        bridge.lastContentRef.current = markdown;
        // R-08：防抖窗口末帧全量序列化的大文档预算提示（宿主 toast）
        checkOversize(markdown);
        bridge.callbacksRef.current.onMarkdownChange?.(markdown);
      }, 150);
    },
    editorProps: {
      attributes: {
        class: styles.proseMirrorField ?? '',
        'data-testid': 'chat-input',
      },
      handleKeyDown: (view: any, event: KeyboardEvent | any) => {
        // CRM-03: IME Composition Protection Gate（view.composing + event.isComposing + DOM 监听）
        if (isImeComposition(view, event, bridge.isComposingRef)) {
          bridge.callbacksRef.current.onCompositionChange?.(true);
          return false; // Pass through to browser native CJK IME candidate selection
        }

        // CodeBlock Enter 保护（SRS 3.7.1）：代码块内 Enter 只换行，绝不触发发送
        const inCodeBlock =
          view.state.selection.$from.parent.type.name === 'codeBlock';
        const suggestionActive = Boolean(
          slashSuggestionKey.getState(view.state)?.active ||
            mentionSuggestionKey.getState(view.state)?.active ||
            dirTreeSuggestionKey.getState(view.state)?.active
        );

        const action = resolveTiptapKeydown(event, {
          sendShortcut: bridge.sendShortcutRef.current,
          inCodeBlock,
          suggestionActive,
        });

        if (action === 'insertIndent') {
          event.preventDefault();
          view.dispatch(view.state.tr.insertText(readCodeBlockIndent()));
          return true;
        }

        // codeBlock 内 Shift+Tab 也不把焦点挪出编辑器
        if (
          event.key === 'Tab' &&
          inCodeBlock &&
          !suggestionActive &&
          !event.altKey &&
          !(event.ctrlKey || event.metaKey)
        ) {
          event.preventDefault();
          return true;
        }

        // Send Keymaps（决策为纯函数，见 TiptapKeymap）
        if (action === 'send') {
          event.preventDefault();
          const editor = bridge.editorRef.current;
          if (!editor) return true;

          // 强制立即执行一次同步转换以保证发送内容最新
          const json = editor.getJSON();
          const markdown =
            serializeToMarkdown(json).trim() || editor.getText().trim();

          // R-08：发送瞬间同步全量序列化的大文档预算提示
          checkOversize(markdown);

          if (markdown && bridge.callbacksRef.current.onSendMarkdown) {
            bridge.callbacksRef.current.onSendMarkdown(markdown);
            editor.commands.clearContent();
            bridge.lastContentRef.current = '';
            bridge.callbacksRef.current.onMarkdownChange?.('');
          }
          return true;
        }

        // 换行结构变更（Enter / Shift+Enter）：取消防抖并在帧内立即同步最新 markdown，消除高度响应延迟
        if (event.key === 'Enter') {
          if (bridge.debounceTimerRef.current) {
            clearTimeout(bridge.debounceTimerRef.current);
            bridge.debounceTimerRef.current = null;
          }
          requestAnimationFrame(() => {
            const editor = bridge.editorRef.current;
            if (!editor || editor.isDestroyed) return;
            const markdown = serializeToMarkdown(editor.getJSON());
            bridge.lastContentRef.current = markdown;
            checkOversize(markdown);
            bridge.callbacksRef.current.onMarkdownChange?.(markdown);
          });
        }

        return false;
      },
      handleClickOn: (
        _view: any,
        _pos: number,
        node: { type?: { name?: string }; attrs?: Record<string, unknown> },
        _nodePos: number,
        event: MouseEvent,
        direct: boolean
      ) => {
        if (!direct || node?.type?.name !== 'mention') return false;
        const kind = String(node.attrs?.kind || 'file');
        const id = String(node.attrs?.id || node.attrs?.label || '');
        if (kind !== 'file' || !id) return false;
        event.preventDefault();
        openFileInPanel(id);
        return true;
      },
      handleDrop: (
        view: any,
        event: DragEvent | any,
        _slice: any,
        moved: boolean
      ) => {
        if (
          !moved &&
          event.dataTransfer &&
          event.dataTransfer.files.length > 0
        ) {
          event.preventDefault();
          event.stopPropagation?.();
          bridge.callbacksRef.current.onDropFiles?.(
            Array.from(event.dataTransfer.files)
          );
          return true;
        }
        return false;
      },
      handlePaste: (view: any, event: any) => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;

        // 1. 图片粘贴 → 转交适配层（宿主附件链），不落入编辑器
        const items = clipboardData.items;
        if (items && items.length > 0) {
          for (let idx = 0; idx < items.length; idx++) {
            const item = items.item ? items.item(idx) : items[idx];
            if (item && item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file) {
                event.preventDefault();
                bridge.callbacksRef.current.onPasteImage?.(file, event);
                return true;
              }
            }
          }
        }

        // 2. HTML 粘贴 → DOMPurify 清洗后以安全 HTML 插入（防 XSS 注入）
        const html = clipboardData.getData('text/html');
        if (html) {
          event.preventDefault();
          const cleaned = DOMPurify.sanitize(html, {
            FORBID_TAGS: [
              'script',
              'style',
              'iframe',
              'object',
              'embed',
              'form',
              'link',
              'meta',
              'img',
              'video',
              'audio',
              'source',
              'input',
              'button',
              'textarea',
            ],
            FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
          });
          view.pasteHTML(cleaned);
          return true;
        }

        // 3. 纯文本由 ProseMirror 默认处理
        return false;
      },
    },
  };
}
