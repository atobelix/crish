/**
 * index.ts - Custom tags module exports
 */

import { CustomTagRegistry } from './CustomTagRegistry';
import { WidgetDiff } from './WidgetDiff';
import { FileTree } from './FileTree';
import { AiCard } from './AiCard';

export {
  CustomTagRegistry,
  parseComponentAttributes,
  sanitizeCustomTagAttributes,
  isSafeProtocol,
  DISALLOWED_TAGS,
  SAFE_PROTOCOLS,
  MAX_ATTR_LENGTH,
  type ExtraComponentProps,
  type ContainerTagProps,
  type CustomTagDefinition,
  type HastNode,
} from './CustomTagRegistry';

export { CustomTagPortal, type CustomTagPortalProps } from './CustomTagPortal';
export {
  CustomTagErrorBoundary,
  type CustomTagErrorBoundaryProps,
} from './CustomTagErrorBoundary';
export { WidgetDiff, type WidgetDiffProps } from './WidgetDiff';
export { FileTree, type FileTreeProps } from './FileTree';
export { AiCard, type AiCardProps } from './AiCard';

// 默认注册核心自定义组件
export function registerBuiltinCustomTags(): void {
  const registry = CustomTagRegistry.getInstance();
  registry.register({
    name: 'widget-diff',
    type: 'container',
    component: WidgetDiff,
    description: '代码审查比对卡片',
  });
  registry.register({
    name: 'file-tree',
    type: 'container',
    component: FileTree,
    description: '工程文件树卡片',
  });
  registry.register({
    name: 'ai-card',
    type: 'container',
    component: AiCard,
    description: 'AI 步骤决策卡片',
  });
}
