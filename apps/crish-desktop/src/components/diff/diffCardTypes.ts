import type { DiffChange } from '../../store/types';

export type CompareMode = 'git' | 'session-merged' | `turn-${string}` | 'plain';

export interface ComputedChange {
  change: DiffChange;
  globalIdx: number;
  oldLine: number | undefined;
  newLine: number | undefined;
  isHeader: boolean;
}

export interface SplitPair {
  left: ComputedChange | undefined;
  right: ComputedChange | undefined;
}

export interface PlaceholderRenderItem {
  isCollapsedPlaceholder: true;
  startIndex: number;
  count: number;
}

export interface ChangeRenderItem {
  isCollapsedPlaceholder: false;
  index: number;
  item: ComputedChange;
}

export interface SplitChangeRenderItem {
  isCollapsedPlaceholder: false;
  index: number;
  pair: SplitPair;
}

export type UnifiedRenderItem = PlaceholderRenderItem | ChangeRenderItem;
export type SplitRenderItem = PlaceholderRenderItem | SplitChangeRenderItem;
