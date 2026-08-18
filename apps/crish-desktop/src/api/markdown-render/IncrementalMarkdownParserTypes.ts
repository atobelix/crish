/**
 * 增量 Markdown 解析器类型与状态接口（从 IncrementalMarkdownParser.ts 拆出，降低 hub 行数）。
 *
 * 职责：仅承载类型契约与内部状态接口定义，无运行时逻辑、无副作用。
 * hub re-export 保持外部 import 路径不变（测试文件仍走 hub）。
 */

import type { ListKind } from './markdownPlugins';

export type BlockType =
  | 'p'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'fence'
  | 'ul'
  | 'ol'
  | 'table'
  | 'quote'
  | 'hr';

export interface BlockNode {
  type: BlockType;
  html: string;
  startLine: number;
  endLine: number;
}

export interface IncrementalParseResult {
  finalizedBlocks: BlockNode[];
  tailBlock: BlockNode | null;
  blockCount: number;
}

export type TableAlignment = 'left' | 'center' | 'right';

export interface FenceState {
  lang: string;
  filePath: string;
  buffer: string[];
  startLine: number;
}

export interface ListItemState {
  kind: ListKind;
  content: string;
  taskChecked?: boolean;
  olStart?: number;
}

export interface ListState {
  kind: ListKind;
  items: ListItemState[];
  baseIndent: number;
  startLine: number;
}

export interface TableState {
  alignments: TableAlignment[];
  rows: string[][];
  inThead: boolean;
  startLine: number;
}
