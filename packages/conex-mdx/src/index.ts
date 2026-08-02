/**
 * @conex/mdx — 公共 ESM 入口（W10 脚手架）
 *
 * ---------------------------------------------------------------------------
 * 运行时状态（重要）
 * ---------------------------------------------------------------------------
 * 本包当前 **仅导出类型与 stub API**。真实编辑器运行时仍在 reference IIFE：
 *
 *   reference/chat-composer-component/js/markdown-editor/*
 *   reference/chat-composer-component/css/markdown-editor/*
 *
 * 在 MIGRATION.md 阶段 B–D 完成前：
 * - Desktop / Workbench **不要**把本包当生产运行时依赖业务路径
 * - Demo / harness 继续加载 reference script 顺序（见 README 迁移映射表）
 * - 本包用于：类型契约、模块所有权、迁移清单、未来 workspace resolve 预挂
 *
 * 目标态：import { mount } from '@conex/mdx' 即完整内核；reference 改消费包。
 * ---------------------------------------------------------------------------
 */

export type {
  AiApplyStrategy,
  AiContext,
  AiContinueRequest,
  AiPort,
  AiPorts,
  AiRewriteRequest,
  AiReviewFinding,
  AiReviewRequest,
  AiReviewResult,
  AiSummarizeRequest,
  AiTextResult,
  Block,
  BlockId,
  BlockType,
  Doc,
  DocMeta,
  EditorExtensions,
  EditorFeatures,
  InlineMark,
  MarkdownEditorHandle,
  MarkdownEditorMountOptions,
  MediaPorts,
  MountOptions,
  SetContentOptions,
  TextRun,
  UploadImagePort,
  UploadImageRequest,
  UploadImageResult,
} from './types';

import type { Doc, MarkdownEditorHandle, MountOptions } from './types';

/** Doc schema 版本（与包 semver 解耦） */
export const VERSION = 2 as const;

/**
 * 主挂载入口 — scaffold stub。
 * 完整实现迁移见 MIGRATION.md 阶段 C；此前请使用 reference `MarkdownEditor.mount`。
 */
export function mount(_hostEl: HTMLElement, _options?: MountOptions): MarkdownEditorHandle {
  throw new Error(
    '@conex/mdx: mount() not implemented yet — runtime still lives in reference/chat-composer-component (W10 scaffold). See packages/conex-mdx/MIGRATION.md',
  );
}

/** 与 mount 同义的工厂别名（规格 §4.2） */
export const createEditor = mount;

/**
 * 纯函数桩：MD → Doc。阶段 B 从 reference parse.js 迁入。
 */
export function parse(_markdown: string): Doc {
  throw new Error('@conex/mdx: parse() not implemented yet (migration phase B)');
}

/**
 * 纯函数桩：Doc → MD。阶段 B 从 reference serialize.js 迁入。
 */
export function serialize(_doc: Doc): string {
  throw new Error('@conex/mdx: serialize() not implemented yet (migration phase B)');
}

/**
 * 旧 Doc → 当前 version。阶段 B 从 reference schema.js 迁入。
 */
export function migrate(doc: Doc): Doc {
  if (doc && typeof doc === 'object' && doc.version === VERSION) {
    return doc;
  }
  throw new Error(
    '@conex/mdx: migrate() incomplete — only identity for version=2 (migration phase B)',
  );
}

export function emptyDoc(): Doc {
  return { version: VERSION, blocks: [] };
}
