/**
 * draftLifecycle.ts — 新对话草稿生命周期与调度器（单一职责）。
 *
 * 核心契约：
 * 1. 确定性绑定：显式传入 workspaceKey 时（如从项目列表「+」或常规对话「+」触发），严格绑定该标识；
 * 2. 动态活跃度：未显式传入时（如窗格加号或左侧顶部新建对话），按 resolveMostActiveProjectFolder() 自动关联；
 * 3. 运行期工作区同步：调用 activateWorkspaceForSessionFolder(targetFolder) 激活底层 cwd 与 LocalStorage；
 * 4. 注册表登记：将草稿 ID 与 targetFolder 记入 draftFolderRegistry；
 * 5. 导航收口：原子完成表面切换至 chat、清理 AgentPanel 焦点与 openNewDraftTab。
 */

import { useLayoutStore } from '../layoutStore';
import { clearAgentPanelFocus } from '../../api/openAgentPanel';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  canonicalSessionFolder,
  activateWorkspaceForSessionFolder,
} from '../../api/projectStore';
import { mintDraftSessionId } from '../draftSession';
import { draftFolderRegistry } from './draftFolderRegistry';
import { resolveMostActiveProjectFolder } from './draftProjectResolver';

export interface NewDraftOptions {
  /** 目标叶子节点 ID（多分屏窗格下） */
  leafId?: string;
  /** 显式指定的项目或文件夹标识 */
  workspaceKey?: string;
}

/**
 * 导航并进入新对话草稿（全链路原子调度收口点）。
 */
export function navigateToNewDraft(
  workspaceKeyOrOpts?: string | NewDraftOptions
): void {
  const opts: NewDraftOptions =
    typeof workspaceKeyOrOpts === 'string'
      ? { workspaceKey: workspaceKeyOrOpts }
      : workspaceKeyOrOpts || {};

  // 1. 切回 chat 主功能表面并清理侧边栏焦点
  useLayoutStore.getState().setChatMainSurface('chat');
  try {
    clearAgentPanelFocus();
  } catch {
    /* ignore in tests where session root might not be fully wired */
  }

  // 2. 确定目标项目 folder（显式指定优先，否则动态解析最近活跃项目）
  const rawFolder = opts.workspaceKey?.trim();
  const targetFolder = rawFolder
    ? canonicalSessionFolder(rawFolder)
    : resolveMostActiveProjectFolder();

  // 3. 同步底层工作区环境（cwd 与 activeProjectId）
  try {
    void activateWorkspaceForSessionFolder(targetFolder);
  } catch {
    /* ignore if environment is headless */
  }

  // 4. 调度 Shell 打开新草稿 Tab
  const root = getCompositionRoot();
  if (root?.shell?.openNewDraftTab) {
    root.shell.openNewDraftTab({
      leafId: opts.leafId,
      workspaceKey: targetFolder,
    });
  }

  // 5. 将草稿 ID 登记到注册表中
  const targetLeafId =
    opts.leafId || root?.shell?.getState?.()?.lastChatLeafId || 'root';
  const draftId = mintDraftSessionId(targetLeafId);
  draftFolderRegistry.set(draftId, targetFolder);
}
