/**
 * changes/types.ts — 改动面板领域模型与强类型契约（单一职责）。
 */

import type { GitStatusCode } from '../../../api/gitTreeHelpers';
import type { FileDiff } from '../../../store/types';

export type ChangesScopeMode = 'session' | 'unstaged' | 'branch';

export interface UnifiedFileChange {
  id: string;
  filePath: string;
  fileName: string;
  dirPath: string;
  status: GitStatusCode;
  additions: number;
  deletions: number;
  staged?: boolean;
  conflicted?: boolean;
  rawDiff?: FileDiff;
}
