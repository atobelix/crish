import { MAX_DIFF_FILES } from '@crish/shared-utils/browser';
import type { FileDiff } from '../types';

export const DIFF_LIST_MAX = MAX_DIFF_FILES;

export function upsertDiffFile(diffFiles: FileDiff[], diff: FileDiff, max = DIFF_LIST_MAX): void {
  const i = diffFiles.findIndex((f) => f.filePath === diff.filePath);
  if (i >= 0) diffFiles[i] = diff;
  else diffFiles.unshift(diff);
  if (diffFiles.length > max) diffFiles.length = max;
}

export const TERMINAL_HARD_MAX = 800;
export const TERMINAL_TRIM_TO = 600;

export function appendTerminalLine(buf: string[], line: string, hardMax = TERMINAL_HARD_MAX, trimTo = TERMINAL_TRIM_TO): boolean {
  buf.push(line);
  if (buf.length > hardMax) { buf.splice(0, buf.length - trimTo); return true; }
  return false;
}
