import type React from 'react';
import type { IconName } from '@/components/ui/icons';

export type ViewCategory = 'primary' | 'tool' | 'auxiliary' | 'debug';

/** 传递给视图组件的标准纯函数上下文 */
export interface ViewRenderContext {
  /** 当前面板 ID（如 'chat', 'terminal', 'browser', 'flow-dag', 'file-viewer'） */
  readonly panelId: string;
  /** 当前所属二叉树叶子节点 ID */
  readonly leafId: string;
  /** 绑定的会话 ID（多会话分屏时为专属 sessionId；草稿态为 PENDING_DRAFT） */
  readonly sessionId?: string;
  /** 当前叶子是否处于用户激活态 */
  readonly isActive: boolean;
  /** 打开其他面板的路由回调（驱动 Tier 3 LayoutStore 状态变移） */
  readonly openView: (panelId: string) => void;
  /** 统一标题降级文案（可选） */
  readonly fallbackTitle?: string;
  /** 动态视图参数（如 file-viewer 的 filePath, initialMode 等） */
  readonly params?: Record<string, unknown>;
}

export interface ViewDefinition {
  /** 唯一视图标识符（如 'chat', 'terminal', 'browser', 'flow-dag', 'file-viewer'） */
  readonly id: string;
  /** 视图显示标题，支持 Thunk 函数以响应国际化或动态参数 */
  readonly title: string | ((ctx: ViewRenderContext) => string);
  /** 视图图标语义名（经 AppIcon 渲染） */
  readonly icon?: IconName;
  /** 视图分类（'primary' 主对话域 / 'tool' 工具坞 / 'auxiliary' 辅助区 / 'debug' 调试） */
  readonly category: ViewCategory;
  /** 是否单例视图（默认 false，如为 true 则在工作区中只允许打开单个实例） */
  readonly singleton?: boolean;
  /** 默认分屏比例 (0.1 ~ 0.9，默认 0.5) */
  readonly defaultSplitRatio?: number;
  /** 快捷键 (如 'Mod+Shift+T') */
  readonly shortcut?: string;
  /** 视图主渲染组件（支持 React.lazy 动态懒加载组件） */
  readonly component: React.ComponentType<ViewRenderContext>;
  /** 面板头部附加操作插槽组件（可选） */
  readonly headerActions?: React.ComponentType<ViewRenderContext>;
  /** 视图销毁前的生命周期清理回调（如释放 PTY 进程、断开 Tauri 视频 Channel） */
  readonly onDispose?: (ctx: {
    leafId: string;
    sessionId?: string;
  }) => void | Promise<void>;
}

export interface ViewUriResolver {
  readonly prefix: string;
  readonly resolve: (
    uri: string
  ) => { viewId: string; params: Record<string, unknown> } | null;
}
