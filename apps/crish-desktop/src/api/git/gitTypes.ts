/**
 * Git 基础类型与契约定义
 */

export type GitFileStatusCode = 'A' | 'M' | 'D' | 'U' | 'R' | 'C' | '?' | '!' | 'mixed' | string;

export type GitStatusFile = {
  path: string;
  status: GitFileStatusCode;
  staged?: boolean;
  unstaged?: boolean;
  untracked?: boolean;
  conflicted?: boolean;
  originalPath?: string;
};

/**
 * 稳定 reason 码（UI 分支用）：
 * - not-installed：本机无 git / 找不到可执行文件
 * - not-a-repo：有 git 但目录不是仓库
 * - timeout / daemon-offline / error / unavailable
 */
export type GitStatusReason =
  | 'not-installed'
  | 'not-a-repo'
  | 'timeout'
  | 'daemon-offline'
  | 'error'
  | 'unavailable'
  | string;

export type GitStatusResult = {
  found: boolean;
  cwd?: string;
  branch?: string;
  clean?: boolean;
  files: GitStatusFile[];
  stagedCount?: number;
  unstagedCount?: number;
  untrackedCount?: number;
  conflictedCount?: number;
  reason?: GitStatusReason;
  /** 原始 reason 文案（stderr 等），便于诊断 */
  detail?: string;
};
