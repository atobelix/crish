import React, { lazy } from 'react';
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
import { viewRegistry } from './ViewRegistry';
import type { ViewRenderContext } from './ViewTypes';

// 懒加载组件定义
const ChatCard = lazy(() =>
  import('../../components/chat-card/ChatCard').then((m) => ({
    default: m.ChatCard,
  }))
);
const TerminalCard = lazy(() =>
  import('../../components/workspace/TerminalCard').then((m) => ({
    default: m.TerminalCard,
  }))
);
const PreviewCard = lazy(() =>
  import('../../components/workspace/PreviewCard').then((m) => ({
    default: m.PreviewCard,
  }))
);
const OverviewCard = lazy(() =>
  import('../../components/overview/OverviewCard').then((m) => ({
    default: m.OverviewCard,
  }))
);
const FilesCard = lazy(() =>
  import('../../components/files/FilesCard').then((m) => ({
    default: m.FilesCard,
  }))
);
const DiffCard = lazy(() =>
  import('../../components/diff/DiffCard').then((m) => ({
    default: m.DiffCard,
  }))
);
const RuntimePanel = lazy(() =>
  import('../../components/workspace/RuntimePanel').then((m) => ({
    default: m.RuntimePanel,
  }))
);
const AgentCard = lazy(() =>
  import('../../components/agent-card/AgentCard').then((m) => ({
    default: m.AgentCard,
  }))
);
const FileViewerCard = lazy(() =>
  import('../../components/files/FileViewerCard').then((m) => ({
    default: m.FileViewerCard,
  }))
);

// 一等公民释放：AI 浏览器与编排图
const BrowserPanel = lazy(() =>
  import('../../components/workspace/BrowserPanel').then((m) => ({
    default: m.BrowserPanel,
  }))
);
const FlowDagView = lazy(() =>
  import('../../components/workspace/FlowDagView').then((m) => ({
    default: m.FlowDagView,
  }))
);

let isBuiltInRegistered = false;

export function resetBuiltInViewsRegistrationFlagForTesting(): void {
  isBuiltInRegistered = false;
}

export function registerBuiltInViews(): void {
  if (isBuiltInRegistered && viewRegistry.getView('chat')) return;
  isBuiltInRegistered = true;

  // 1. 对话主视图 (Primary)
  viewRegistry.registerView({
    id: 'chat',
    title: '对话',
    icon: MessageSquare,
    category: 'primary',
    component: (ctx: ViewRenderContext) => (
      <ChatCard
        sessionId={ctx.sessionId}
        handleGlobalTabClick={ctx.openView}
      />
    ),
  });

  // 2. 终端卡片 (Tool)
  viewRegistry.registerView({
    id: 'terminal',
    title: '终端',
    icon: Terminal,
    category: 'tool',
    shortcut: 'Mod+`',
    component: (ctx: ViewRenderContext) => (
      <TerminalCard sessionId={ctx.sessionId} />
    ),
  });

  // 3. Web 预览卡片 (Tool)
  viewRegistry.registerView({
    id: 'preview',
    title: '预览',
    icon: Eye,
    category: 'tool',
    component: () => <PreviewCard />,
  });

  // 4. 总览面板 (Tool)
  viewRegistry.registerView({
    id: 'overview',
    title: '总览',
    icon: LayoutDashboard,
    category: 'tool',
    component: (ctx: ViewRenderContext) => (
      <OverviewCard onOpenPanel={ctx.openView} />
    ),
  });

  // 5. 文件管理器 (Tool)
  viewRegistry.registerView({
    id: 'files',
    title: '文件',
    icon: FolderTree,
    category: 'tool',
    component: () => <FilesCard />,
  });

  // 6. 差异比对卡片 (Tool)
  viewRegistry.registerView({
    id: 'diff',
    title: '差异',
    icon: GitBranch,
    category: 'tool',
    component: () => <DiffCard />,
  });

  // 7. 运行时面板 (Tool)
  viewRegistry.registerView({
    id: 'runtime',
    title: '运行时',
    icon: PlayCircle,
    category: 'tool',
    component: () => <RuntimePanel />,
  });

  // 8. 协作体智能体 (Tool)
  viewRegistry.registerView({
    id: 'agent',
    title: '协作体',
    icon: Bot,
    category: 'tool',
    component: () => <AgentCard />,
  });

  // 9. 一等公民释放：AI 受管浏览器 (Tool)
  viewRegistry.registerView({
    id: 'browser',
    title: 'AI 浏览器',
    icon: Globe,
    category: 'tool',
    component: () => <BrowserPanel />,
  });

  // 10. 一等公民释放：拓扑编排图 (Tool)
  viewRegistry.registerView({
    id: 'flow-dag',
    title: '编排图',
    icon: Workflow,
    category: 'tool',
    component: () => <FlowDagView />,
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
    component: (ctx: ViewRenderContext) => {
      const filePath = (ctx.params?.filePath as string) || '';
      const initialMode =
        (ctx.params?.initialMode as 'plain' | 'diff') || 'plain';
      return (
        <FileViewerCard
          key={filePath}
          filePath={filePath}
          initialMode={initialMode}
        />
      );
    },
  });
}
