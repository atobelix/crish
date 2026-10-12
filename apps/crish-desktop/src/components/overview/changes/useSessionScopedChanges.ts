/**
 * useSessionScopedChanges.ts — 当前会话作用域文件改动派生与响应式 Hook（单一职责）。
 *
 * 核心设计：
 * 1. 严格以当前会话为真理源（SSOT），拒绝跨会话数据污染；
 * 2. 深度扫描当前会话主消息及子 Agent 消息中的文件修改工具调用；
 * 3. 结合终端内存实时 Diff 缓冲区，保证即时编辑与历史水合双向一致；
 * 4. 会话无文件产出时严格返回空数组，杜绝全局 Git 脏改动渗透。
 */

import { useMemo } from 'react';
import { useSessionStore, useTerminalField } from '../../../store/storeAccess';
import { useScopedSessionId } from '../../../contexts/LeafScopeContext';
import {
  selectDiffFiles,
  selectActiveDiffSource,
} from '../../../store/storeAccess';
import { selectSessionDiffFiles } from '../../../api/sessionDiffDerivation';
import type { GitStatusCode } from '../../../api/gitTreeHelpers';
import type { UnifiedFileChange } from './types';

export function useSessionScopedChanges(
  workspaceRoot?: string,
  sessionIdProp?: string | null
) {
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const session = useSessionStore((s) =>
    scopedSessionId ? s.sessionsById[scopedSessionId] || null : null
  );
  const diffFiles = useTerminalField(selectDiffFiles);
  const activeDiffSource = useTerminalField(selectActiveDiffSource);

  // 1. 收集当前会话的所有消息（含子 Agent 协同消息）
  const allMessages = useMemo(() => {
    if (!session) return [];
    const list = [...(session.messages || [])];
    if (session.agents && session.agents.length > 0) {
      for (const agent of session.agents) {
        if (agent.messages && agent.messages.length > 0) {
          list.push(...agent.messages);
        }
      }
    }
    return list;
  }, [session]);

  // 2. 纯逻辑函数从消息中精准派生当前会话文件改动
  const sessionDiffs = useMemo(() => {
    if (allMessages.length === 0) return [];
    return selectSessionDiffFiles(allMessages, workspaceRoot);
  }, [allMessages, workspaceRoot]);

  // 3. 聚合当前会话的派生 Diff 与内存实时编辑缓冲区
  const unifiedFiles = useMemo<UnifiedFileChange[]>(() => {
    const fileMap = new Map<string, UnifiedFileChange>();

    // 先加入会话历史中派生的持久化 Diff
    for (const diff of sessionDiffs) {
      const normalized = diff.filePath.replace(/\\/g, '/');
      const lastSlash = normalized.lastIndexOf('/');
      const fileName =
        lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
      const dirPath = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';

      fileMap.set(normalized, {
        id: normalized,
        filePath: diff.filePath,
        fileName: fileName || diff.filePath,
        dirPath,
        status:
          (diff.gitStatus as GitStatusCode) ||
          (diff.additions > 0 && diff.deletions === 0 ? 'A' : 'M'),
        additions: diff.additions,
        deletions: diff.deletions,
        rawDiff: diff,
      });
    }

    // 仅当会话本身已有消息/改动时，才允许融入当前活跃的终端实时 Diff
    if (sessionDiffs.length > 0) {
      const liveList = diffFiles?.length
        ? diffFiles
        : activeDiffSource
          ? [activeDiffSource]
          : [];
      for (const live of liveList) {
        const normalized = live.filePath.replace(/\\/g, '/');
        const existing = fileMap.get(normalized);
        if (existing) {
          existing.additions = Math.max(
            existing.additions,
            live.additions || 0
          );
          existing.deletions = Math.max(
            existing.deletions,
            live.deletions || 0
          );
          existing.rawDiff = live;
        }
      }
    }

    return Array.from(fileMap.values());
  }, [sessionDiffs, diffFiles, activeDiffSource]);

  return {
    activeSessionId: scopedSessionId,
    sessionFiles: unifiedFiles,
    totalFiles: unifiedFiles.length,
    isEmpty: unifiedFiles.length === 0,
  };
}
