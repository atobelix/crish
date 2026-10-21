/**
 * 把工具成功解析出的 FileDiff 推入右侧变更列表。
 * 必须在 immer set() 配方外调用，否则嵌套 set 会被丢弃。
 *
 * 职责（发布门槛，非落盘）：
 * - 路径抽取 / 规范化（引号剥离、\→/、./ 折叠、尾斜杠；与 isSafeApplyPath 对齐）
 * - 多文件批内按 path key 合并（后写优先，但弱占位不覆盖强内容）
 * - 空列表 / 垃圾路径 / 无内容 no-op
 * - 与 store 已有条目冲突时：missing-base 占位不覆盖更完整 base
 * - 同 path 不同原始写法（src\a vs src/a）推送前清 alias，避免列表重复
 */
import type { FileDiff } from '../store/types';
import { getDiffFiles, pushDiffFile } from './storeAccess';
import { useTerminalStore } from '../store';
import {
  coalescePublishableDiffs,
  isMissingBaseDiff,
  normalizeDiffFilePath,
  preparePublishableDiff,
  resolvePublishDiffConflict,
} from './publishableDiffs';

// 纯计算面已拆至 publishableDiffs.ts；此处保留再导出，既有 import 路径不变。
export * from './publishableDiffs';

/** 清掉同规范化 key 下、与 keepPath 字面不同的 store 条目（反斜杠 alias 等） */
function removePathAliases(rawPaths: Iterable<string>, keepPath: string): void {
  const remove = useTerminalStore.getState().removeDiffFile;
  for (const raw of rawPaths) {
    if (raw !== keepPath) remove(raw);
  }
}

/**
 * 推入右侧变更列表。空 / 全垃圾 → no-op 返回 0。
 * 与 store 已有同 path 冲突时：incoming missing-base 不覆盖更完整 base。
 * 同 path 不同原始写法 → 先 remove alias 再 push，避免 upsert 精确匹配产生重复行。
 * @returns 实际调用 push 的条数
 */
export function publishToolDiffs(files: FileDiff[] | undefined | null): number {
  const ready = coalescePublishableDiffs(files);
  if (!ready.length) return 0;

  // 快照当前列表：规范化 key → 代表条目；并记录所有原始 path 以便清 alias
  const existing = getDiffFiles() || [];
  const byKey = new Map<string, FileDiff>();
  const aliases = new Map<string, Set<string>>();

  for (const e of existing) {
    const k = normalizeDiffFilePath(e.filePath);
    if (!k) continue;
    let set = aliases.get(k);
    if (!set) {
      set = new Set();
      aliases.set(k, set);
    }
    set.add(e.filePath);
    const prevE = byKey.get(k);
    if (!prevE) byKey.set(k, e);
    else byKey.set(k, resolvePublishDiffConflict(prevE, e));
  }

  let pushed = 0;
  for (const f of ready) {
    const prev = byKey.get(f.filePath);
    const rawSet = aliases.get(f.filePath) ?? new Set<string>();

    if (prev) {
      const winner = resolvePublishDiffConflict(prev, f);
      // incoming 为 missing-base 且 store 更丰满 → 跳过覆盖（保留 base）
      if (winner !== f && isMissingBaseDiff(f)) {
        continue;
      }

      const toPush =
        winner === f
          ? f
          : preparePublishableDiff({ ...winner, filePath: f.filePath }) || f;

      // prev 更强且路径已是规范形式、无 alias 重复 → 不重复 push（避免 activeDiffSource 抖动）
      if (winner !== f && prev.filePath === f.filePath && rawSet.size <= 1) {
        continue;
      }

      removePathAliases(rawSet, f.filePath);
      pushDiffFile(toPush);
      byKey.set(f.filePath, toPush);
      aliases.set(f.filePath, new Set([f.filePath]));
      pushed += 1;
      continue;
    }

    pushDiffFile(f);
    byKey.set(f.filePath, f);
    aliases.set(f.filePath, new Set([f.filePath]));
    pushed += 1;
  }
  return pushed;
}
