/**
 * builtinViewFactories — 内置视图工厂解耦表（10 槽全量）。
 *
 * 维度 3 步骤 1 / 3-E：registerBuiltInViews 不再自引 components
 * （斩断 services/view-registry → components 反向边）；实际 lazy import
 * 在此注入（app → components 为合法下行边，无环）。
 * 每个 factory 返回 React.ComponentType<ViewRenderContext>。
 *
 * 迁移清单铁律：chat / terminal / preview / overview / files / diff /
 * runtime / agent / flow-dag / file-viewer —— 共 10 个，严禁缩减。
 */
import React, { lazy } from 'react';
import type { ViewFactoryMap, ViewRenderContext } from './services/view-registry';

export const builtinViewFactories: ViewFactoryMap = {
  chat: () =>
    lazy(() =>
      import('./components/chat-card/ChatCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.ChatCard
            sessionId={ctx.sessionId}
            handleGlobalTabClick={ctx.openView}
          />
        ),
      }))
    ),
  terminal: () =>
    lazy(() =>
      import('./components/workspace/TerminalCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.TerminalCard
            sessionId={ctx?.sessionId}
            panelId={ctx?.panelId}
          />
        ),
      }))
    ),
  preview: () =>
    lazy(() =>
      import('./components/workspace/PreviewCard').then((m) => ({
        // T20：透传 resolver 的 params.target——`preview:<url>` 带目标打开
        default: (ctx: ViewRenderContext) => (
          <m.PreviewCard
            initialTarget={(ctx?.params?.target as string | undefined) ?? null}
          />
        ),
      }))
    ),
  overview: () =>
    lazy(() =>
      import('./components/overview/OverviewCard').then((m) => ({
        default: (ctx: ViewRenderContext) => (
          <m.OverviewCard onOpenPanel={ctx.openView} />
        ),
      }))
    ),
  files: () =>
    lazy(() =>
      import('./components/files/FilesCard').then((m) => ({
        default: () => <m.FilesCard />,
      }))
    ),
  diff: () =>
    lazy(() =>
      import('./components/diff/DiffCard').then((m) => ({
        default: () => <m.DiffCard />,
      }))
    ),
  runtime: () =>
    lazy(() =>
      import('./components/workspace/RuntimePanel').then((m) => ({
        default: () => <m.RuntimePanel />,
      }))
    ),
  agent: () =>
    lazy(() =>
      import('./components/agent-card/AgentCard').then((m) => ({
        default: () => <m.AgentCard />,
      }))
    ),
  'flow-dag': () =>
    lazy(() =>
      import('./components/workspace/FlowDagView').then((m) => ({
        default: () => <m.FlowDagView />,
      }))
    ),
  'file-viewer': () =>
    lazy(() =>
      import('./components/files/FileViewerCard').then((m) => ({
        default: m.FileViewerCardView,
      }))
    ),
};
