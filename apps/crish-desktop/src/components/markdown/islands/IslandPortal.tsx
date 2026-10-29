/**
 * 把 Island 组件以 React Portal 的方式挂载到 Rust 生成的占位元素中。
 * 占位元素随块 DOM 一起创建/销毁，Portal 生命周期与块保持一致。
 */
import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { getMarkdownIsland } from './registry';

export interface IslandPortalProps {
  name: string;
  source: string;
  target: HTMLElement;
  host?: HTMLElement;
  displayMode?: boolean;
}

export function IslandPortal({
  name,
  source,
  target,
  host,
  displayMode,
}: IslandPortalProps): ReactElement | null {
  const definition = getMarkdownIsland(name);
  if (!definition) return null;
  const Component = definition.component;
  return createPortal(
    <Component source={source} host={host} displayMode={displayMode} />,
    target
  );
}
