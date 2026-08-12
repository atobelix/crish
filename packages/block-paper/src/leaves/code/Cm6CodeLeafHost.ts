/**
 * 真 CM6 代码叶 Host（W3-E 方向子集 · CM6 host 接线）。
 *
 * 实现 `CodeLeafHost`：
 * - mount → `EditorView` 挂到 HTMLElement
 * - focus / blur → view focus / contentDOM.blur
 * - setContent / getContent → doc 全量同步（Model 推送时抑制 onDocChanged 回环）
 * - setLanguage → Compartment.reconfigure（plaintext | javascript）
 * - setReadOnly → Compartment + EditorState.readOnly
 * - destroy → view.destroy()
 * - getEditorView() → 真实 EditorView
 *
 * ## 诚实边界
 * - **≠** 产品 e2e 满关；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - **≠** 全语言高亮完成：仅 plain + javascript 一种 lang；其余 id 回落 plain
 * - **不接 RS** 为关闭项；Intent 仍经 Model / sink
 * - 活动叶编辑 **≠** `ReadonlyCodePresentation` 只读 DOM 件
 */

import {
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';

import type { CodeLanguage } from './CodeLeafModel';
import type { CodeLeafHost } from './CodeLeafHost';

// ---------------------------------------------------------------------------
// 语言解析（可单测、无 DOM）
// ---------------------------------------------------------------------------

/**
 * language id → CM6 Extension。
 * - `javascript` / `js` → @codemirror/lang-javascript
 * - `plaintext` / `text` / `plain` / 未知 → 空扩展（纯文本）
 */
export function resolveCm6LanguageExtension(
  language: CodeLanguage | undefined | null
): Extension {
  const id = (language || 'plaintext').toLowerCase().trim();
  switch (id) {
    case 'javascript':
    case 'js':
      return javascript();
    case 'plaintext':
    case 'text':
    case 'plain':
    case '':
      return [];
    default:
      // 未接全语言包：回落 plain，避免抛错阻断挂载
      return [];
  }
}

/** 是否已识别为「有高亮」的语言（当前仅 js） */
export function isCm6HighlightedLanguage(
  language: CodeLanguage | undefined | null
): boolean {
  const id = (language || 'plaintext').toLowerCase().trim();
  return id === 'javascript' || id === 'js';
}

// ---------------------------------------------------------------------------
// EditorState 工厂（无 DOM；证明 @codemirror/state 接线）
// ---------------------------------------------------------------------------

export type CreateCm6EditorStateOptions = {
  doc?: string;
  language?: CodeLanguage;
  readOnly?: boolean;
  languageComp?: Compartment;
  readOnlyComp?: Compartment;
  /**
   * doc 变更回调（用户键入 / dispatch）。
   * 与 Host 的 onDocChanged 同源；构造纯 state 时可注入。
   */
  onDocChanged?: (content: string, update: ViewUpdate) => void;
  /**
   * 为 true 时跳过 onDocChanged（Model→Host setContent 推送期）。
   * Host 实现用闭包读取 suppress 标志。
   */
  shouldSuppressDocChanged?: () => boolean;
  /** 追加扩展（主题等） */
  extraExtensions?: Extension[];
};

export type Cm6EditorStateBundle = {
  state: EditorState;
  languageComp: Compartment;
  readOnlyComp: Compartment;
};

/**
 * 构造带 language / readOnly Compartment + history + keymap 的 EditorState。
 * **不**创建 EditorView，可在无 DOM 的 node vitest 中调用。
 */
export function createCm6EditorState(
  options: CreateCm6EditorStateOptions = {}
): Cm6EditorStateBundle {
  const languageComp = options.languageComp ?? new Compartment();
  const readOnlyComp = options.readOnlyComp ?? new Compartment();
  const language = options.language ?? 'plaintext';
  const readOnly = options.readOnly ?? false;

  const extensions: Extension[] = [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    languageComp.of(resolveCm6LanguageExtension(language)),
    readOnlyComp.of(EditorState.readOnly.of(readOnly)),
    EditorView.lineWrapping,
  ];

  if (options.onDocChanged || options.shouldSuppressDocChanged) {
    extensions.push(
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (!update.docChanged) return;
        if (options.shouldSuppressDocChanged?.()) return;
        options.onDocChanged?.(update.state.doc.toString(), update);
      })
    );
  }

  if (options.extraExtensions?.length) {
    extensions.push(...options.extraExtensions);
  }

  const state = EditorState.create({
    doc: options.doc ?? '',
    extensions,
  });

  return { state, languageComp, readOnlyComp };
}

// ---------------------------------------------------------------------------
// Host 选项
// ---------------------------------------------------------------------------

export type Cm6CodeLeafHostOptions = {
  initialContent?: string;
  language?: CodeLanguage;
  readOnly?: boolean;
  /**
   * 用户编辑导致 doc 变更时回调（完整 content 字符串）。
   * Model 经 setContent 推送时 **不会** 触发（内部 suppress）。
   * 宿主可在此调用 `model.applyLocalEdit(0, oldLen, content)` 等对齐 Intent。
   */
  onDocChanged?: (content: string) => void;
  /** 追加 CM6 扩展 */
  extraExtensions?: Extension[];
};

// ---------------------------------------------------------------------------
// Cm6CodeLeafHost
// ---------------------------------------------------------------------------

/**
 * 真 CodeMirror 6 代码叶 Host。
 *
 * @example
 * ```ts
 * const el = document.querySelector('#slot')!;
 * let model: CodeLeafModel | null = null;
 * const host = new Cm6CodeLeafHost(el, {
 *   initialContent: 'const x = 1;',
 *   language: 'javascript',
 *   onDocChanged: (content) => {
 *     if (!model) return;
 *     const old = model.getContent();
 *     if (old === content) return;
 *     model.applyLocalEdit(0, old.length, content);
 *   },
 * });
 * model = new CodeLeafModel('b1', 'const x = 1;', { language: 'javascript', host });
 * // …
 * host.destroy();
 * ```
 */
export class Cm6CodeLeafHost implements CodeLeafHost {
  private readonly view: EditorView;
  private readonly languageComp: Compartment;
  private readonly readOnlyComp: Compartment;
  private language: CodeLanguage;
  private readOnly: boolean;
  private destroyed = false;
  /** Model→View 同步期抑制 onDocChanged，避免回环 */
  private suppressDocChanged = false;
  private onDocChanged: ((content: string) => void) | undefined;

  constructor(parent: HTMLElement, options: Cm6CodeLeafHostOptions = {}) {
    this.language = options.language ?? 'plaintext';
    this.readOnly = options.readOnly ?? false;
    this.onDocChanged = options.onDocChanged;

    const { state, languageComp, readOnlyComp } = createCm6EditorState({
      doc: options.initialContent ?? '',
      language: this.language,
      readOnly: this.readOnly,
      shouldSuppressDocChanged: () => this.suppressDocChanged,
      onDocChanged: (content) => {
        this.onDocChanged?.(content);
      },
      ...(options.extraExtensions
        ? { extraExtensions: options.extraExtensions }
        : {}),
    });

    this.languageComp = languageComp;
    this.readOnlyComp = readOnlyComp;

    this.view = new EditorView({
      state,
      parent,
    });

    // 标记根节点，便于调试 / 选择器
    this.view.dom.classList.add('bp-code-leaf-cm6');
    this.view.dom.setAttribute('data-bp-code-leaf', 'cm6');
    this.view.dom.setAttribute('data-language', this.language);
  }

  // -----------------------------------------------------------------------
  // 扩展 API
  // -----------------------------------------------------------------------

  /** 真实 EditorView；destroy 后返回 null */
  getEditorView(): EditorView | null {
    return this.destroyed ? null : this.view;
  }

  /** 运行时替换 onDocChanged（mount 后绑定 model 时用） */
  setOnDocChanged(cb: ((content: string) => void) | undefined): void {
    this.onDocChanged = cb;
  }

  // -----------------------------------------------------------------------
  // CodeLeafHost
  // -----------------------------------------------------------------------

  focus(): void {
    this.assertAlive();
    this.view.focus();
  }

  blur(): void {
    this.assertAlive();
    this.view.contentDOM.blur();
  }

  hasFocus(): boolean {
    if (this.destroyed) return false;
    return this.view.hasFocus;
  }

  setContent(content: string): void {
    this.assertAlive();
    const current = this.view.state.doc.toString();
    if (current === content) return;

    this.suppressDocChanged = true;
    try {
      this.view.dispatch({
        changes: {
          from: 0,
          to: this.view.state.doc.length,
          insert: content,
        },
        // 标注为外部同步，便于后续过滤
        annotations: [Transaction.remote.of(true)],
      });
    } finally {
      this.suppressDocChanged = false;
    }
  }

  getContent(): string {
    if (this.destroyed) return '';
    return this.view.state.doc.toString();
  }

  setReadOnly(readOnly: boolean): void {
    this.assertAlive();
    const next = Boolean(readOnly);
    if (this.readOnly === next) return;
    this.readOnly = next;
    this.view.dispatch({
      effects: this.readOnlyComp.reconfigure(
        EditorState.readOnly.of(this.readOnly)
      ),
    });
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  setLanguage(language: CodeLanguage): void {
    this.assertAlive();
    const next = language || 'plaintext';
    if (this.language === next) {
      // 仍刷新 data 属性（幂等）
      this.view.dom.setAttribute('data-language', this.language);
      return;
    }
    this.language = next;
    this.view.dom.setAttribute('data-language', this.language);
    this.view.dispatch({
      effects: this.languageComp.reconfigure(
        resolveCm6LanguageExtension(this.language)
      ),
    });
  }

  getLanguage(): CodeLanguage {
    return this.language;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDocChanged = undefined;
    this.view.destroy();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('Cm6CodeLeafHost：已 destroy，不可再操作');
    }
  }
}

/**
 * 类型守卫：host 是否暴露真实 CM6 EditorView。
 * 参数为 `unknown`，便于契约测对 null / 普通对象做否定断言。
 */
export function isCm6CodeLeafHost(host: unknown): host is Cm6CodeLeafHost {
  return host instanceof Cm6CodeLeafHost;
}
