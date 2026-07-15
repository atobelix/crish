/**
 * 把工具成功解析出的 FileDiff 推入右侧变更列表。
 * 必须在 immer set() 配方外调用，否则嵌套 set 会被丢弃。
 */
import type { FileDiff } from '../store/types';
import { useLayoutStore } from '../store/layoutStore';

export function publishToolDiffs(files: FileDiff[] | undefined | null): void {
  if (!files?.length) return;
  const push = useLayoutStore.getState().pushDiffFile;
  for (const f of files) {
    push(f);
  }
}
