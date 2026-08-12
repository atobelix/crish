/**
 * 代码叶 flavour / fence ↔ collab kind 诚实映射（W3-E 方向子集）。
 *
 * 对齐：
 * - `flavourToCollabKind`（`@crish/block-paper-contract`）：`code` / `code_block` / `code-block` → `'code'`
 * - MD 围栏开（`mdPrefix` rule `code_fence`）目标 flavour = `'code'`
 * - 代码叶 `CodeLanguage` = fence info 语言 id（与 CM6 LanguageSupport 钩子对齐的轻量字符串）
 *
 * ## 诚实边界（强制）
 * - **本文件只做映射纯函数**，不挂产品列表、不关 A-BLK-14 e2e
 * - **≠** 产品 e2e 满关；**≠** EL-01；**≠** A-BLK-14 产品 focus e2e
 * - **language 字段有 ≠ 全语言高亮包齐**：当前 CM6 host 仅 plain + javascript 高亮，
 *   其余 id 仍可写入 Model / wire attrs，呈现回落 plain（见 `resolveCm6LanguageExtension`）
 * - fence 语言 ≠ collab `BlockKind`：kind 恒为 `'code'`；语言进 props/attrs 或叶本地态
 *
 * 文件域：`leaves/code/**` 新文件；不碰 `turnInto` / W3-H 同文件。
 */

import {
  flavourToCollabKind,
  type CollabBlockKindWire,
} from '@crish/block-paper-contract';
import type { CodeLanguage } from './CodeLeafModel';

// ---------------------------------------------------------------------------
// Flavour 常量 / 判定
// ---------------------------------------------------------------------------

/**
 * 纸面侧识别为「代码块」的 flavour id 集合（小写）。
 * 与 `flavourToCollabKind` 内 code 分支保持同步——新增别名时两侧同改。
 */
export const CODE_FLAVOUR_IDS = ['code', 'code_block', 'code-block'] as const;

export type CodeFlavourId = (typeof CODE_FLAVOUR_IDS)[number];

/** collab wire 上的代码块 kind 字面量 */
export const CODE_COLLAB_KIND = 'code' as const;

export type CodeCollabKind = typeof CODE_COLLAB_KIND;

/**
 * 纸面 flavour 是否映射为代码块。
 * 委托 `flavourToCollabKind`，避免与 contract 分叉。
 */
export function isCodeFlavour(flavour: string | null | undefined): boolean {
  return flavourToCollabKind(flavour ?? '') === CODE_COLLAB_KIND;
}

/**
 * flavour → collab kind；**仅**当结果为 `'code'` 时返回字面量，否则 null。
 * 未识别 / 其他 kind 不伪装成 code（诚实：callout 等不得进代码叶路径）。
 */
export function codeFlavourToCollabKind(
  flavour: string | null | undefined
): CodeCollabKind | null {
  const kind = flavourToCollabKind(flavour ?? '');
  return kind === CODE_COLLAB_KIND ? CODE_COLLAB_KIND : null;
}

/**
 * 任意 collab kind wire 是否为代码块单元变体。
 */
export function isCodeCollabKind(
  kind: CollabBlockKindWire | null | undefined
): kind is CodeCollabKind {
  return kind === CODE_COLLAB_KIND;
}

// ---------------------------------------------------------------------------
// Fence info → language
// ---------------------------------------------------------------------------

/**
 * 从 MD fence 开行或 info 串解析语言 id。
 *
 * 接受：
 * - 完整开行：`` ```js `` / `` ```typescript `` / `` ``` ``
 * - 纯 info：`js` / `typescript` / `c++`
 * - 空 / 仅反引号 → `plaintext`
 *
 * **不**验证语言是否已接 CM6 LanguageSupport；未知 id 仍原样返回（小写 trim），
 * 由 host `resolveCm6LanguageExtension` 决定是否高亮。
 */
export function parseFenceInfo(
  fenceOrInfo: string | null | undefined
): CodeLanguage {
  if (fenceOrInfo == null) return 'plaintext';
  let s = String(fenceOrInfo).trim();
  if (!s) return 'plaintext';

  // 剥离围栏开：```lang 或 ~~~lang（GFM 偶见）
  const open = s.match(/^(`{3,}|~{3,})\s*([^\s`]*)/);
  if (open) {
    s = (open[2] ?? '').trim();
  }

  // info 可能含额外参数（`js {highlight: [1]}` 等）——只取首 token
  const token = s.split(/\s+/)[0] ?? '';
  if (!token) return 'plaintext';

  // 语言 id：字母数字 + 常见符号（c++、objective-c、f#）
  const normalized = token.toLowerCase();
  if (!/^[\w.+#-]+$/.test(normalized)) {
    return 'plaintext';
  }
  return normalized;
}

/**
 * fence 开行（如 `` ```python ``）→ CodeLanguage。
 * 与 `parseFenceInfo` 同语义；命名强调「开行」输入。
 */
export function fenceOpenToLanguage(fenceOpenLine: string): CodeLanguage {
  return parseFenceInfo(fenceOpenLine);
}

// ---------------------------------------------------------------------------
// 解析代码叶语言（投影 / 插入路径）
// ---------------------------------------------------------------------------

export type ResolveCodeLeafLanguageInput = {
  /** 纸面 flavour；非 code 系时仍可带 language，但调用方应先 `isCodeFlavour` */
  flavour?: string | null;
  /**
   * MD fence info 或开行（优先）。
   * 例：`js` / `` ```rust ``
   */
  fenceInfo?: string | null;
  /**
   * 投影 / props 上的 language 字段（次优先）。
   */
  language?: string | null;
  /**
   * collab props.attrs 透传表；读 `language` / `lang` / `fence`。
   */
  attrs?: Record<string, unknown> | null;
};

/**
 * 解析代码叶应使用的 `CodeLanguage`。
 *
 * 优先级：`fenceInfo` → 显式 `language` → attrs.language|lang|fence → `plaintext`。
 * **不**因 flavour 非 code 抛错（调用方过滤）；flavour 仅作审计上下文。
 */
export function resolveCodeLeafLanguage(
  input: ResolveCodeLeafLanguageInput = {}
): CodeLanguage {
  if (input.fenceInfo != null && String(input.fenceInfo).trim() !== '') {
    return parseFenceInfo(input.fenceInfo);
  }
  if (input.language != null && String(input.language).trim() !== '') {
    return parseFenceInfo(String(input.language));
  }
  const attrs = input.attrs;
  if (attrs && typeof attrs === 'object') {
    for (const key of ['language', 'lang', 'fence'] as const) {
      const v = attrs[key];
      if (typeof v === 'string' && v.trim() !== '') {
        return parseFenceInfo(v);
      }
    }
  }
  return 'plaintext';
}

/**
 * 构造代码块 insert 时建议的 collab attrs 子集（language 进 attrs）。
 * kind 仍由 `codeFlavourToCollabKind` / `flavourToCollabKind` 决定，**不**把 lang 写进 kind。
 */
export function codeLeafAttrsForLanguage(
  language: CodeLanguage | null | undefined
): Record<string, unknown> {
  const lang = parseFenceInfo(language ?? 'plaintext');
  if (lang === 'plaintext') {
    return {};
  }
  return { language: lang };
}

/**
 * 一次解析：flavour 是否代码块 + collab kind + 叶语言。
 * 便于 PaperList / slash 插入路径单点调用。
 */
export type CodeLeafKindResolution = {
  /** 是否为代码 flavour */
  isCode: boolean;
  /** collab kind；非 code 时为 `flavourToCollabKind` 原始结果 */
  kindWire: CollabBlockKindWire;
  /** 叶语言（非 code 时仍可解析，调用方按 isCode 决定是否用） */
  language: CodeLanguage;
};

export function resolveCodeLeafKindAndLanguage(
  input: ResolveCodeLeafLanguageInput & { flavour: string }
): CodeLeafKindResolution {
  const kindWire = flavourToCollabKind(input.flavour ?? '');
  const isCode = kindWire === CODE_COLLAB_KIND;
  return {
    isCode,
    kindWire,
    language: resolveCodeLeafLanguage(input),
  };
}
