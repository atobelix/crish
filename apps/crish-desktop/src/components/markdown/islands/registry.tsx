/**
 * Markdown Island 注册表。
 *
 * 新增富交互能力时只需：
 * 1. Rust 输出 `data-md-island` / `data-island-slot` 占位；
 * 2. 在这里注册一个懒加载组件；
 * 3. 块管线与交互边界无需改动。
 */
import type { ComponentType } from 'react';
import { MathIsland } from './MathIsland';
import { MermaidIsland } from './MermaidIsland';

interface MarkdownIslandProps {
  source: string;
  host?: HTMLElement;
  displayMode?: boolean;
}

interface MarkdownIslandDefinition {
  name: string;
  component: ComponentType<MarkdownIslandProps>;
}

const registry = new Map<string, MarkdownIslandDefinition>();

function register(definition: MarkdownIslandDefinition): void {
  registry.set(definition.name, definition);
}

export function getMarkdownIsland(
  name: string
): MarkdownIslandDefinition | undefined {
  return registry.get(name);
}

register({
  name: 'math',
  component: (props) => (
    <MathIsland
      source={props.source}
      displayMode={props.displayMode === true}
    />
  ),
});

register({
  name: 'mermaid',
  component: (props) => (
    <MermaidIsland source={props.source} host={props.host} />
  ),
});
