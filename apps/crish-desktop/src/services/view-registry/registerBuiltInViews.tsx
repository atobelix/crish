import {
  MessageSquare,
  Terminal,
  Eye,
  LayoutDashboard,
  FolderTree,
  GitBranch,
  PlayCircle,
  Bot,
  Globe,
  Workflow,
  FileCode,
} from 'lucide-react';
import type React from 'react';
import { viewRegistry } from './ViewRegistry';
import type { ViewRenderContext } from './ViewTypes';

/**
 * 视图 factory 注入面（维度 3 步骤 1 / 3-E）。
 *
 * ## 为何注入
 *
 * 此前 `registerBuiltInViews` 自身 `React.lazy(() => import('../../components/...'))`
 * 共 11 处，形成 `services/view-registry → components` 大反向边（services 不应
 * 反向依赖 components 渲染层）。
 *
 * 现改为**参数注入**：调用方（main.tsx startup）传入 factory map，本函数只
 * 负责将 factory 产出注册到 viewRegistry，不再 import 任何 components。
 * 实际 lazy import 在 main.tsx 完成（app → components 为合法下行边，无环）。
 *
 * ## 类型
 *
 * - 每个 factory 是 `() => React.ComponentType<ViewRenderContext>`：
 *   factory 内部可自由组合 `React.lazy` + 适配器（把 ViewRenderContext 投影成
 *   各组件真实 props，如 chat 的 sessionId/handleGlobalTabClick、file-viewer 的
 *   filePath/initialMode 参数提取等）。
 * - 仅类型 import 不产生运行期依赖边（本文件不 import 任何 components 模块）。
 */
export type ViewFactoryMap = Record<
  string,
  () => React.ComponentType<ViewRenderContext>
>;

let isBuiltInRegistered = false;

export function resetBuiltInViewsRegistrationFlagForTesting(): void {
  isBuiltInRegistered = false;
}

/**
 * 注册内置视图到 viewRegistry。
 *
 * @param factories 由调用方注入的 lazy factory map（main.tsx startup）。
 *   key 为视图 id（chat/terminal/preview/overview/files/diff/runtime/agent/
 *   browser/flow-dag/file-viewer）；value 为返回 `React.ComponentType<ViewRenderContext>`
 *   的 factory。缺失的 id 跳过注册（防御；调用方应提供全部 11 个）。
 */
export function registerBuiltInViews(factories: ViewFactoryMap): void {
  if (isBuiltInRegistered && viewRegistry.getView('chat')) return;
  isBuiltInRegistered = true;

  // 1. 对话主视图 (Primary)
  viewRegistry.registerView({
    id: 'chat',
    title: '对话',
    icon: MessageSquare,
    category: 'primary',
    component: factories['chat']?.() ?? fallbackComponent,
  });

  // 2. 终端卡片 (Tool)
  viewRegistry.registerView({
    id: 'terminal',
    title: '终端',
    icon: Terminal,
    category: 'tool',
    shortcut: 'Mod+`',
    component: factories['terminal']?.() ?? fallbackComponent,
  });

  // 3. Web 预览卡片 (Tool)
  viewRegistry.registerView({
    id: 'preview',
    title: '预览',
    icon: Eye,
    category: 'tool',
    component: factories['preview']?.() ?? fallbackComponent,
  });

  // 4. 总览面板 (Tool)
  viewRegistry.registerView({
    id: 'overview',
    title: '总览',
    icon: LayoutDashboard,
    category: 'tool',
    component: factories['overview']?.() ?? fallbackComponent,
  });

  // 5. 文件管理器 (Tool)
  viewRegistry.registerView({
    id: 'files',
    title: '文件',
    icon: FolderTree,
    category: 'tool',
    component: factories['files']?.() ?? fallbackComponent,
  });

  // 6. 差异比对卡片 (Tool)
  viewRegistry.registerView({
    id: 'diff',
    title: '差异',
    icon: GitBranch,
    category: 'tool',
    component: factories['diff']?.() ?? fallbackComponent,
  });

  // 7. 运行时面板 (Tool)
  viewRegistry.registerView({
    id: 'runtime',
    title: '运行时',
    icon: PlayCircle,
    category: 'tool',
    component: factories['runtime']?.() ?? fallbackComponent,
  });

  // 8. 协作体智能体 (Tool)
  viewRegistry.registerView({
    id: 'agent',
    title: '协作体',
    icon: Bot,
    category: 'tool',
    component: factories['agent']?.() ?? fallbackComponent,
  });

  // 9. 一等公民释放：AI 受管浏览器 (Tool)
  viewRegistry.registerView({
    id: 'browser',
    title: 'AI 浏览器',
    icon: Globe,
    category: 'tool',
    component: factories['browser']?.() ?? fallbackComponent,
  });

  // 10. 一等公民释放：拓扑编排图 (Tool)
  viewRegistry.registerView({
    id: 'flow-dag',
    title: '编排图',
    icon: Workflow,
    category: 'tool',
    component: factories['flow-dag']?.() ?? fallbackComponent,
  });

  // 11. 文件查看器 (Auxiliary - 结构化 viewParams: { filePath, initialMode })
  viewRegistry.registerView({
    id: 'file-viewer',
    title: (ctx: ViewRenderContext) => {
      const path = (ctx.params?.filePath as string) || '';
      return path.replace(/^.*[\\/]/, '') || '文件查看';
    },
    icon: FileCode,
    category: 'auxiliary',
    component: factories['file-viewer']?.() ?? fallbackComponent,
  });
}

/**
 * factory 缺失时的兜底组件（防御）。
 * 正常路径由 main.tsx 提供全部 11 个 factory；此兜底仅用于异常/测试场景，
 * 避免单个 factory 缺失导致整批注册崩溃。
 */
const fallbackComponent: React.FC<ViewRenderContext> = () => null;
