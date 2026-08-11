/**
 * 代码叶 Host 契约 + mock + mount（W3-E）。
 *
 * 分层：
 * - `CodeLeafModel`：纯逻辑（content / focus / Intent）—— vitest 主路径
 * - `CodeLeafHost`：编辑面适配器（焦点与 doc 显示）
 * - `createMockCodeLeafHost`：无 DOM 可测 host
 * - `mountCodeLeaf`：挂到 HTMLElement；真实 CM6 挂点在此标注
 *
 * ## 真实 CM6 host 挂点（后续波）
 *
 * ```ts
 * // 可选依赖：@codemirror/state @codemirror/view @codemirror/lang-javascript …
 * import { EditorState, Compartment } from '@codemirror/state';
 * import { EditorView, keymap, placeholder } from '@codemirror/view';
 * import { defaultKeymap, history } from '@codemirror/commands';
 *
 * const langComp = new Compartment();
 * const roComp = new Compartment();
 * const state = EditorState.create({
 *   doc: opts.initialContent,
 *   extensions: [
 *     keymap.of(defaultKeymap),
 *     history(),
 *     langComp.of(languageExtensions[opts.language] ?? []),
 *     roComp.of(EditorState.readOnly.of(opts.readOnly)),
 *     EditorView.updateListener.of((u) => {
 *       if (u.docChanged) opts.onDocChanged?.(u.state.doc.toString(), u);
 *     }),
 *   ],
 * });
 * const view = new EditorView({ state, parent: el });
 * // host.focus  → view.focus()
 * // host.blur   → view.contentDOM.blur()
 * // host.setContent → view.dispatch({ changes: { from:0, to:view.state.doc.length, insert } })
 * // host.setLanguage → view.dispatch({ effects: langComp.reconfigure(...) })
 * // host.setReadOnly → view.dispatch({ effects: roComp.reconfigure(EditorState.readOnly.of(ro)) })
 * // host.destroy → view.destroy()
 * ```
 *
 * 本波 **不** 引入完整 CM6 DOM 依赖：mock host 已满足「可聚焦」+ Intent 通路；
 * 上表为真实 host 的接线契约，保持 Model API 稳定。
 *
 * **W3-E ≠ 全语言高亮完成**。
 */

import type { CodeLanguage } from './CodeLeafModel';
import { CodeLeafModel, type CodeLeafModelOptions } from './CodeLeafModel';

// ---------------------------------------------------------------------------
// Host 接口
// ---------------------------------------------------------------------------

/**
 * 代码叶编辑面宿主。
 * Model 通过此接口推送焦点 / content / 只读 / 语言；不感知 CM6 细节。
 */
export type CodeLeafHost = {
  /** 将焦点交给编辑面（CM6：`EditorView.focus()`） */
  focus(): void;
  /** 失焦（CM6：`view.contentDOM.blur()` 或 document activeElement 移出） */
  blur(): void;
  /** 是否处于焦点（CM6：`view.hasFocus`） */
  hasFocus(): boolean;
  /** 用权威 content 覆盖显示（投影回填 / Model 推送） */
  setContent(content: string): void;
  /** 读当前显示 content */
  getContent(): string;
  setReadOnly(readOnly: boolean): void;
  isReadOnly(): boolean;
  /** 语言切换钩子；真实 CM6 用 Compartment.reconfigure */
  setLanguage?(language: CodeLanguage): void;
  getLanguage?(): CodeLanguage;
  /** 释放 View / 监听 */
  destroy(): void;
};

// ---------------------------------------------------------------------------
// Mock host（无 DOM）
// ---------------------------------------------------------------------------

export type MockCodeLeafHost = CodeLeafHost & {
  /** 审计：focus 调用次数 */
  focusCount: number;
  /** 审计：blur 调用次数 */
  blurCount: number;
  /** 是否已 destroy */
  destroyed: boolean;
  /** 测试直接读内部态 */
  readonly state: {
    content: string;
    language: CodeLanguage;
    readOnly: boolean;
    focused: boolean;
  };
};

export type MockCodeLeafHostOptions = {
  initialContent?: string;
  language?: CodeLanguage;
  readOnly?: boolean;
};

/**
 * 无 DOM 的可审计 host：逻辑层单测默认用此实现。
 */
export function createMockCodeLeafHost(
  options: MockCodeLeafHostOptions = {}
): MockCodeLeafHost {
  const state = {
    content: options.initialContent ?? '',
    language: options.language ?? 'plaintext',
    readOnly: options.readOnly ?? false,
    focused: false,
  };
  let destroyed = false;
  let focusCount = 0;
  let blurCount = 0;

  const assertAlive = (): void => {
    if (destroyed) {
      throw new Error('MockCodeLeafHost：已 destroy，不可再操作');
    }
  };

  const host: MockCodeLeafHost = {
    get focusCount() {
      return focusCount;
    },
    get blurCount() {
      return blurCount;
    },
    get destroyed() {
      return destroyed;
    },
    get state() {
      return state;
    },
    focus() {
      assertAlive();
      focusCount += 1;
      state.focused = true;
    },
    blur() {
      assertAlive();
      blurCount += 1;
      state.focused = false;
    },
    hasFocus() {
      return !destroyed && state.focused;
    },
    setContent(content: string) {
      assertAlive();
      state.content = content;
    },
    getContent() {
      return state.content;
    },
    setReadOnly(readOnly: boolean) {
      assertAlive();
      state.readOnly = Boolean(readOnly);
    },
    isReadOnly() {
      return state.readOnly;
    },
    setLanguage(language: CodeLanguage) {
      assertAlive();
      state.language = language || 'plaintext';
    },
    getLanguage() {
      return state.language;
    },
    destroy() {
      destroyed = true;
      state.focused = false;
    },
  };

  return host;
}

// ---------------------------------------------------------------------------
// mountCodeLeaf：DOM 挂载入口（真实 CM6 挂点）
// ---------------------------------------------------------------------------

export type MountCodeLeafOptions = {
  blockId: string;
  initialContent?: string;
  language?: CodeLanguage;
  readOnly?: boolean;
  /**
   * 自定义 host 工厂。
   * 默认：若 `el` 可用则装 lightweight DomCodeLeafHost；
   * 无 DOM（node 测）请显式传入 `createMockCodeLeafHost`。
   */
  createHost?: (el: HTMLElement) => CodeLeafHost;
  /** 透传 CodeLeafModelOptions（host 除外，由 mount 注入） */
  modelOptions?: Omit<CodeLeafModelOptions, 'host' | 'language' | 'readOnly'>;
};

/** mount 返回：model + host + 卸载 */
export type CodeLeafMount = {
  model: CodeLeafModel;
  host: CodeLeafHost;
  /** 卸载 host 并从 model 解绑 */
  unmount: () => void;
  /**
   * 真实 CM6 EditorView 挂点占位。
   * 本波 mock/dom host 均为 null；接入 CM6 后返回 View 实例。
   */
  getEditorView: () => unknown | null;
};

/**
 * 轻量 DOM host：用 textarea 承载焦点与文本，**不是** CM6。
 * 用途：浏览器/jsdom 下验证 focus / content 通路；CM6 替换时只换 host 实现。
 *
 * 真实 CM6 替换点：本类整体可替换为 `Cm6CodeLeafHost`（见文件头注释）。
 */
export class DomCodeLeafHost implements CodeLeafHost {
  private readonly textarea: HTMLTextAreaElement;
  private language: CodeLanguage;
  private destroyed = false;

  constructor(
    parent: HTMLElement,
    options: {
      initialContent?: string;
      language?: CodeLanguage;
      readOnly?: boolean;
    } = {}
  ) {
    this.language = options.language ?? 'plaintext';
    const ta = parent.ownerDocument.createElement('textarea');
    ta.className = 'bp-code-leaf-host';
    ta.setAttribute('data-bp-code-leaf', '1');
    ta.setAttribute('data-language', this.language);
    ta.value = options.initialContent ?? '';
    ta.readOnly = options.readOnly ?? false;
    ta.spellcheck = false;
    // 等宽：代码叶视觉基线（CM6 主题接入前）
    ta.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    ta.style.width = '100%';
    ta.style.minHeight = '4em';
    ta.style.boxSizing = 'border-box';
    parent.appendChild(ta);
    this.textarea = ta;
  }

  focus(): void {
    this.assertAlive();
    this.textarea.focus();
  }

  blur(): void {
    this.assertAlive();
    this.textarea.blur();
  }

  hasFocus(): boolean {
    if (this.destroyed) return false;
    const doc = this.textarea.ownerDocument;
    return doc.activeElement === this.textarea;
  }

  setContent(content: string): void {
    this.assertAlive();
    if (this.textarea.value !== content) {
      this.textarea.value = content;
    }
  }

  getContent(): string {
    return this.textarea.value;
  }

  setReadOnly(readOnly: boolean): void {
    this.assertAlive();
    this.textarea.readOnly = Boolean(readOnly);
  }

  isReadOnly(): boolean {
    return this.textarea.readOnly;
  }

  setLanguage(language: CodeLanguage): void {
    this.assertAlive();
    this.language = language || 'plaintext';
    this.textarea.setAttribute('data-language', this.language);
  }

  getLanguage(): CodeLanguage {
    return this.language;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.textarea.remove();
  }

  /** 测试/调试：底层控件 */
  getTextarea(): HTMLTextAreaElement {
    return this.textarea;
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error('DomCodeLeafHost：已 destroy');
    }
  }
}

/**
 * 将代码叶挂到 DOM 元素。
 *
 * @example
 * ```ts
 * const el = document.querySelector('#code-slot')!;
 * const { model, unmount } = mountCodeLeaf(el, {
 *   blockId: 'b-code-1',
 *   initialContent: 'const x = 1;',
 *   language: 'javascript',
 * });
 * model.focus();
 * const intent = model.applyLocalEdit(10, 10, '0');
 * await submitIntent(intent!, sink);
 * unmount();
 * ```
 *
 * 真实 CM6：传入 `createHost: (el) => new Cm6CodeLeafHost(el, …)`（见文件头挂点）。
 */
export function mountCodeLeaf(
  el: HTMLElement,
  opts: MountCodeLeafOptions
): CodeLeafMount {
  if (!opts.blockId) {
    throw new Error('mountCodeLeaf：blockId 不可为空');
  }

  const host =
    opts.createHost?.(el) ??
    new DomCodeLeafHost(el, {
      initialContent: opts.initialContent ?? '',
      language: opts.language ?? 'plaintext',
      readOnly: opts.readOnly ?? false,
    });

  const model = new CodeLeafModel(opts.blockId, opts.initialContent ?? '', {
    ...opts.modelOptions,
    language: opts.language ?? 'plaintext',
    readOnly: opts.readOnly ?? false,
    host,
  });

  return {
    model,
    host,
    unmount: () => {
      model.detachHost();
    },
    /**
     * CM6 挂点：接入 EditorView 后在此返回 view。
     * 当前 Dom/Mock host 无 View → null。
     */
    getEditorView: () => null,
  };
}
