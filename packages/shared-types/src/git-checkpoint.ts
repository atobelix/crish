/**
 * Git 检查点类型（从 agent-runtime/src/git-versioning/git-types.ts 下沉的纯类型）
 *
 * agent-context 的 checkpoint-manifest 需要这些类型来声明 manifest 记录的结构，
 * 通过下沉到 shared-types 避免跨层引用 agent-runtime。
 *
 * 仅下沉 checkpoint-manifest 依赖的类型闭包：GitCheckpointToolCall、GitCheckpoint
 * 及其传递依赖（GitCheckpointStrategy、GitWorkspaceStatus、GitStatusEntry）。
 * 完整的 GitVersioningService 接口和请求/响应类型仍保留在 agent-runtime，
 * 因为它们仅被运行时层使用。
 */

export type GitCheckpointStrategy = 'commit' | 'snapshot';

export interface GitCheckpointToolCall {
  id?: string;
  toolName?: string;
  actor?: string;
  sessionId?: string;
  targetSummary?: string;
}

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
  originalPath?: string;
}

export interface GitWorkspaceStatus {
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
  entries: GitStatusEntry[];
}

export interface GitCheckpoint {
  id: string;
  label: string;
  strategy: GitCheckpointStrategy;
  refName: string;
  commit: string;
  baseCommit: string | null;
  createdAt: string;
  repositoryRoot: string;
  includeUntracked: boolean;
  statusBefore: GitWorkspaceStatus;
  toolCall?: GitCheckpointToolCall;
}
