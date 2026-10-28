/**
 * apps/crish-desktop/src/components/ui/internal/layer-stack/LayerContext.tsx
 *
 * 全局浮层拓扑树上下文 (LayerContext & LayerProvider)
 *
 * 职责：
 * 1. 维护 React 树中浮层/模态的层级嵌套拓扑（Dialog -> Popover/Menu -> Select -> Submenu）；
 * 2. 跨 Portal 传递 parentId 与所属 tier，使下层浮层自动感知父级宿主；
 * 3. 驱动 LIFO 级联退栈、外点点击豁免树（Branch-Aware）与 Esc 顶层单发拦截。
 */
import React, {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import type { LayerTier } from './layerStackTypes';

export interface LayerContextValue {
  /** 当前宿主浮层的唯一 ID（子组件以此作为 parentId） */
  layerId: string | null;
  /** 当前宿主浮层所属的架构分层 */
  tier: LayerTier | null;
}

export const LayerContext = createContext<LayerContextValue>({
  layerId: null,
  tier: null,
});

/**
 * 获取当前所在的父级 Layer 上下文
 */
export function useLayerContext(): LayerContextValue {
  return useContext(LayerContext);
}

export interface LayerProviderProps {
  layerId: string;
  tier: LayerTier;
  children: ReactNode;
}

/**
 * 浮层层级上下文 Provider
 * 放置在 Dialog, Menu, Popover, Select 等浮层外层或 Portal 内部，供子浮层自动建立树形拓扑关系。
 */
export function LayerProvider({ layerId, tier, children }: LayerProviderProps) {
  const value = useMemo<LayerContextValue>(
    () => ({ layerId, tier }),
    [layerId, tier]
  );
  return (
    <LayerContext.Provider value={value}>{children}</LayerContext.Provider>
  );
}
