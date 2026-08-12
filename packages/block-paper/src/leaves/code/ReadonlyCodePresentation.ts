/**
 * 只读代码呈现适配（W3-E 方向子集）。
 *
 * 用途：非活动代码块 / 预览面——**不**启动可编辑 CM6 写路径，
 * 仅挂载等宽只读 DOM（`<pre><code>`），形状可测、可卸载。
 *
 * 与 `Cm6CodeLeafHost` 的边界（dual-engine E4 同构）：
 * - **本适配** = 只读外观 / 挂载形状（language class + 文本）
 * - **Cm6CodeLeafHost** = 活动叶可聚焦编辑（真 EditorView）
 * - 二者 **不得** 互换冒充：只读件 ≠ A-BLK-14 可编辑 e2e
 *
 * ## 诚实边界
 * - **≠** 产品 e2e 满关；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - **≠** 语法高亮引擎（仅 `language-*` class 钩子；token 着色属后续）
 * - 可选并联 `CodeLeafModel({ readOnly: true })` 供快照 / Intent 拒绝路径复用
 *
 * 文件域：`leaves/code/**` 新文件。
 */

import type { BlockId } from '@crish/block-paper-contract';
import {
  CodeLeafModel,
  type CodeLanguage,
  type CodeLeafSnapshot,
} from './CodeLeafModel';
import {
  isCodeFlavour,
  parseFenceInfo,
  resolveCodeLeafLanguage,
  type ResolveCodeLeafLanguageInput,
} from './codeFlavourMap';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ReadonlyCodePresentationSnapshot = {
  blockId: BlockId;
  content: string;
  language: CodeLanguage;
  /** 恒 true：本适配只读 */
  readOnly: true;
  /** DOM 是否已挂载 */
  mounted: boolean;
  /** flavour 审计（可空） */
  flavour: string | null;
};

export type MountReadonlyCodePresentationOptions = {
  blockId: BlockId;
  content?: string;
  /**
   * 语言 id 或 fence info；缺省经 `resolveCodeLeafLanguage`。
   */
  language?: CodeLanguage;
  fenceInfo?: string | null;
  flavour?: string | null;
  attrs?: Record<string, unknown> | null;
  /**
   * 是否并联只读 `CodeLeafModel`（默认 true）。
   * Model 可用于与编辑路径同构的 snapshot / tryApply 拒绝测。
   */
  attachModel?: boolean;
};

export type ReadonlyCodePresentationMount = {
  /** 根元素（pre.bp-code-leaf-readonly） */
  root: HTMLElement;
  /** 内层 code */
  codeEl: HTMLElement;
  /** 当前语言 */
  getLanguage: () => CodeLanguage;
  /** 当前文本 */
  getContent: () => string;
  /** 更新文本（仍只读呈现；不产 Intent） */
  setContent: (content: string) => void;
  /** 更新语言 class */
  setLanguage: (language: CodeLanguage) => void;
  getSnapshot: () => ReadonlyCodePresentationSnapshot;
  /** 可选并联 Model */
  model: CodeLeafModel | null;
  /** 卸载 DOM + detach model host 无（本适配不经 CodeLeafHost） */
  unmount: () => void;
};

// ---------------------------------------------------------------------------
// DOM class / 标记
// ---------------------------------------------------------------------------

export const BP_CODE_READONLY = 'bp-code-leaf-readonly';
export const BP_CODE_READONLY_CODE = 'bp-code-leaf-readonly__code';

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------

/**
 * 将只读代码块挂到 parent。
 *
 * @throws blockId 空；parent 不可 append
 *
 * @example
 * ```ts
 * const mount = mountReadonlyCodePresentation(el, {
 *   blockId: 'b-code',
 *   content: 'const x = 1;',
 *   fenceInfo: '```js',
 *   flavour: 'code',
 * });
 * expect(mount.getLanguage()).toBe('js'); // fence ```js → language id `js`
 * mount.unmount();
 * ```
 */
export function mountReadonlyCodePresentation(
  parent: HTMLElement,
  opts: MountReadonlyCodePresentationOptions
): ReadonlyCodePresentationMount {
  if (!opts.blockId) {
    throw new Error('mountReadonlyCodePresentation：blockId 不可为空');
  }
  if (!parent || typeof parent.appendChild !== 'function') {
    throw new Error('mountReadonlyCodePresentation：parent 不可用');
  }

  const flavour = opts.flavour ?? null;
  const language = resolveLanguageFromOpts(opts);
  const content = opts.content ?? '';

  const doc = parent.ownerDocument ?? document;
  const pre = doc.createElement('pre');
  pre.className = BP_CODE_READONLY;
  pre.setAttribute('data-bp-code-leaf', 'readonly');
  pre.setAttribute('data-block-id', opts.blockId);
  pre.setAttribute('data-language', language);
  pre.setAttribute('data-read-only', 'true');
  if (flavour) {
    pre.setAttribute('data-flavour', flavour);
  }
  // 非 code flavour 仍可挂（宿主误用时诚实标出）
  if (flavour && !isCodeFlavour(flavour)) {
    pre.setAttribute('data-flavour-mismatch', '1');
  }

  const codeEl = doc.createElement('code');
  codeEl.className = `${BP_CODE_READONLY_CODE} language-${language}`;
  codeEl.textContent = content;
  pre.appendChild(codeEl);
  parent.appendChild(pre);

  let currentLanguage = language;
  let currentContent = content;
  let mounted = true;

  const attachModel = opts.attachModel !== false;
  const model = attachModel
    ? new CodeLeafModel(opts.blockId, content, {
        language: currentLanguage,
        readOnly: true,
      })
    : null;

  const applyLanguageClass = (lang: CodeLanguage): void => {
    // 清旧 language-* class
    const toRemove: string[] = [];
    codeEl.classList.forEach((c) => {
      if (c.startsWith('language-')) toRemove.push(c);
    });
    for (const c of toRemove) codeEl.classList.remove(c);
    codeEl.classList.add(`language-${lang}`);
    pre.setAttribute('data-language', lang);
  };

  return {
    root: pre,
    codeEl,
    getLanguage: () => currentLanguage,
    getContent: () => currentContent,
    setContent: (next: string) => {
      if (!mounted) {
        throw new Error('ReadonlyCodePresentation：已 unmount');
      }
      currentContent = next;
      codeEl.textContent = next;
      model?.replaceFromProjection(next);
    },
    setLanguage: (next: CodeLanguage) => {
      if (!mounted) {
        throw new Error('ReadonlyCodePresentation：已 unmount');
      }
      currentLanguage = parseFenceInfo(next);
      applyLanguageClass(currentLanguage);
      model?.setLanguage(currentLanguage);
    },
    getSnapshot: (): ReadonlyCodePresentationSnapshot => ({
      blockId: opts.blockId,
      content: currentContent,
      language: currentLanguage,
      readOnly: true,
      mounted,
      flavour,
    }),
    model,
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      pre.remove();
      // Model 无 host，无需 detachHost
    },
  };
}

/**
 * 从投影字段构造只读快照（无 DOM；列表虚拟化 / 测形状用）。
 */
export function createReadonlyCodeSnapshot(
  input: {
    blockId: BlockId;
    content?: string;
  } & ResolveCodeLeafLanguageInput
): ReadonlyCodePresentationSnapshot {
  if (!input.blockId) {
    throw new Error('createReadonlyCodeSnapshot：blockId 不可为空');
  }
  return {
    blockId: input.blockId,
    content: input.content ?? '',
    language: resolveCodeLeafLanguage(input),
    readOnly: true,
    mounted: false,
    flavour: input.flavour ?? null,
  };
}

/**
 * 只读 Model 快捷工厂：`readOnly: true` + 解析后的 language。
 * tryApplyLocalEdit 将拒绝（read_only）——与呈现只读一致。
 */
export function createReadonlyCodeLeafModel(
  blockId: BlockId,
  content: string,
  input: ResolveCodeLeafLanguageInput = {}
): CodeLeafModel {
  return new CodeLeafModel(blockId, content, {
    language: resolveCodeLeafLanguage(input),
    readOnly: true,
  });
}

/** 导出 snapshot 类型别名，避免与 CodeLeafSnapshot 混淆 */
export type { CodeLeafSnapshot };

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function resolveLanguageFromOpts(
  opts: MountReadonlyCodePresentationOptions
): CodeLanguage {
  const input: ResolveCodeLeafLanguageInput = {};
  if (opts.flavour !== undefined) input.flavour = opts.flavour;
  if (opts.fenceInfo !== undefined) input.fenceInfo = opts.fenceInfo;
  if (opts.language !== undefined) input.language = opts.language;
  if (opts.attrs !== undefined) input.attrs = opts.attrs;
  return resolveCodeLeafLanguage(input);
}
