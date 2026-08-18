// apps/crish-desktop/src/services/view-registry/SlotTypes.ts
import type { ViewRenderContext } from './ViewTypes';

/**
 * 全局插槽映射表 (Declaration Merging 锚点)
 * 各业务域通过 declare module './SlotTypes' 扩充自身插槽契约
 */
export interface SlotMap {
  'workbench.root': {
    kind: 'single';
    ownerProps: Record<string, never>;
  };
  'workbench.topbar': {
    kind: 'single';
    ownerProps: Record<string, never>;
  };
  'workbench.topbar.actions': {
    kind: 'list';
    ownerProps: Record<string, never>;
  };
  'workspace.leaf.panel': {
    kind: 'keyed';
    ownerProps: ViewRenderContext;
  };
  'workspace.leaf.header': {
    kind: 'single';
    ownerProps: { leafId: string; activeTab: string };
  };
}

export type StandardSlotId = keyof SlotMap;

export type SlotKind = 'single' | 'list' | 'keyed' | 'chain';

export type OwnerPropsOf<K extends StandardSlotId | string> =
  K extends StandardSlotId ? SlotMap[K]['ownerProps'] : Record<string, unknown>;

export interface BaseSlotEntry<TContext = any> {
  id: string;
  component: React.ComponentType<TContext>;
}

export interface SingleSlotEntry<TContext = any> extends BaseSlotEntry<TContext> {
  priority?: number; // 默认 0，越小越优先
}

export interface ListSlotEntry<TContext = any> extends BaseSlotEntry<TContext> {
  order?: number; // 默认 100，越小越靠前
}

export interface KeyedSlotEntry<TContext = any> extends BaseSlotEntry<TContext> {
  key: string;
}

export interface ChainSlotEntry<TContext = any> extends BaseSlotEntry<TContext> {
  select: (context: TContext) => boolean;
}
