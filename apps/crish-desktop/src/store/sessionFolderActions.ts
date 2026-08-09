/**
 * 会话 folder rebind action（D5 收敛点）。
 *
 * 真源 = projectStore（crish_projects_v1）；sessions[].folder / folderOrder
 * 为去规范化镜像。收敛后写路径唯一入口为本 action：
 * - 触发点收为「启动一次 + crish-project-changed 事件」两处（AppBootstrap）；
 * - AppBootstrap 对 layoutStore 自身的自订阅已删除（prevSessions 引用比较防环纪律
 *   由「结构保障」替代：action 内一次 immer 写完成 rebind + folderOrder 维护）。
 *
 * 增量优化：opts.changedSessionIds 提供时仅处理该变更集合（避免
 * O(sessions×projects) 全表扫描）；首启 / 项目变更传全量。
 */
import { rebindSessionFoldersToProjects } from '../api/projectStore';
import type { ProjectEntry } from '../api/projectStore';
import type { SessionActions, SessionStoreSlice, SessionImmerSet } from './sessionActions';

export type RebindSessionFoldersOptions = {
  /** 仅处理变更 sessionId 集合；缺省 = 全量扫描 */
  changedSessionIds?: string[];
};

export function createSessionFolderActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>
): Pick<SessionActions, 'rebindSessionFolders'> {
  return {
    rebindSessionFolders: (projects: ReadonlyArray<ProjectEntry>, opts) =>
      set((state) => {
        if (!projects || projects.length === 0) return;
        const targets = opts?.changedSessionIds?.length
          ? state.sessions.filter((s) => opts.changedSessionIds!.includes(s.id))
          : state.sessions;
        if (targets.length === 0) return;
        const n = rebindSessionFoldersToProjects(targets, projects);
        if (n > 0) {
          // folderOrder 去重追加（与 setSessions / createSession 同纪律）
          for (const s of targets) {
            if (s.folder && !state.folderOrder.includes(s.folder)) {
              state.folderOrder.push(s.folder);
            }
            // 索引回绑：经 sessions[] canonical 写后同步 sessionsById
            // （避免 immer fork 陷阱——只改 sessions[] 时 map 持旧引用）
            state.sessionsById[s.id] = s;
          }
        }
      }),
  };
}
