/**
 * L1 宿主与工作区环境上下文。
 *
 * 主控复核裁决：os / shell / workspaceRoot 为会话装配时的**必填运行时实参**，
 * **不设 defaultParams**——严禁把机器特定值（本机工作区绝对路径等）固化进
 * 模板默认值。渲染时三者缺一即回退为空串并告警（由插值器保证，不抛异常）。
 */
import { createPromptTemplate } from '../compiler/interpolate';
import type { PromptTemplate } from '../types';

export interface HostEnvironmentParams {
  os: string;
  shell: string;
  workspaceRoot: string;
}

export const HOST_ENVIRONMENT_PROMPT: PromptTemplate<HostEnvironmentParams> =
  createPromptTemplate<HostEnvironmentParams>(
    {
      id: 'env-host-context',
      name: '宿主与工作区环境上下文',
      description: '声明操作系统、执行 Shell 与当前工作区路径',
      layer: 'environment',
      version: '1.0.0',
      defaultLocale: 'zh-CN',
      tags: ['environment', 'shell', 'os'],
      // 无 defaultParams：os / shell / workspaceRoot 为必填运行时实参，
      // 严禁把机器特定值固化进模板默认值（主控复核裁决）。
    },
    {
      'zh-CN': `[宿主与运行环境]
- **操作系统**：{{os}}
- **默认执行 Shell**：{{shell}}（统一使用 PowerShell 7+，UTF-8 无 BOM）
- **当前工作区根目录**：{{workspaceRoot}}`,
      'en-US': `[Host & Runtime Environment]
- **Operating System**: {{os}}
- **Default Shell**: {{shell}} (PowerShell 7+, UTF-8 no BOM)
- **Workspace Root**: {{workspaceRoot}}`,
    }
  );
