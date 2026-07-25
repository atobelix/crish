import type React from 'react';
import type { SessionState } from '../../../store/layoutStore';
import type { ProjectEntry } from '../../../api/projectStore';

export type SidebarDragItem =
  | { type: 'session'; sessionId: string; folderName?: string }
  | { type: 'folder'; folderName: string };

export interface SidebarSessionListProps {
  sessions: SessionState[];
  activeSessionId: string;
  searchQuery: string;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  projects: ProjectEntry[];
  collapsedProjects: Record<string, boolean>;
  generalCollapsed: boolean;
  pinnedCollapsed: boolean;
  projectsSectionCollapsed: boolean;
  /** 正在内联重命名的会话 id */
  renamingSessionId?: string | null;
  onSelectSession: (id: string) => void;
  onContextMenuSession: (e: React.MouseEvent, sessionId: string) => void;
  onToggleProjectCollapsed: (id: string) => void;
  onToggleGeneral: () => void;
  onTogglePinned: () => void;
  onToggleProjectsSection: () => void;
  onOpenProject: (id: string) => void;
  onSortBtnClick: (e: React.MouseEvent) => void;
  onNewSession: () => void;
  /** 添加本地项目（文件夹选择） */
  onAddProject: () => void;
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  /** 开始内联重命名 */
  onStartRename?: (sessionId: string) => void;
  /** 提交重命名；空串取消 */
  onCommitRename?: (sessionId: string, title: string) => void;
  onCancelRename?: () => void;
}
