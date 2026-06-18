import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export interface CardState {
  id: string; // 'plan' | 'preview' | 'diff' | 'tasks' | 'terminal'
  title: string;
}

export interface CardGroupState {
  id: string;
  activeCardId: string;
  cards: CardState[];
  heightRatio: number; // relative height ratio within the column
}

export interface ColumnState {
  id: string;
  widthRatio: number; // relative width ratio within the workspace
  groups: CardGroupState[];
}

export interface WorkspaceState {
  id: string;
  columns: ColumnState[];
}

export interface SessionState {
  id: string;
  title: string;
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  branchParentId?: string;
  timestamp: string;
}

export interface DropPreviewState {
  colIdx: number;
  groupIdx: number;
  direction: 'top' | 'bottom' | 'left' | 'right' | 'merge';
}

interface DraggedTabState {
  cardId: string;
  sourceGroupId: string;
  workspaceId: string;
  isTabDrag?: boolean;
}

interface LayoutStore {
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  tabModeEnabled: boolean;
  uiSize: 'small' | 'medium' | 'large';
  sidebarCollapsed: boolean;
  sessions: SessionState[];
  folderOrder: string[];
  activeSessionId: string;
  draggedTab: DraggedTabState | null;
  dropPreview: DropPreviewState | null;
  panelsDropdownCoords: { x: number; y: number } | null;

  // UI Settings Actions
  setDropPreview: (preview: DropPreviewState | null) => void;
  setUiSize: (size: 'small' | 'medium' | 'large') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setActiveSessionId: (id: string) => void;
  setPanelsDropdownCoords: (coords: { x: number; y: number } | null) => void;

  // Workspace Actions
  togglePanel: (wsId: string, key: string, isVisible: boolean) => void;
  resizeColumns: (wsId: string, colIdx: number, dx: number, containerWidth: number) => void;
  resizeGroups: (wsId: string, colIdx: number, groupIdx: number, dy: number, containerHeight: number) => void;
  
  // Drag and Drop Tab Actions
  setDraggedTab: (dragged: DraggedTabState | null) => void;
  mergeTab: (wsId: string, cardId: string, sourceGroupId: string, targetGroupId: string, targetIndex?: number) => void;
  detachTabToStandalone: (wsId: string, cardId: string, sourceGroupId: string, colIdx: number, direction: 'top' | 'bottom' | 'new-col', targetGroupIdx?: number) => void;
  moveTabOrGroupRealtime: (wsId: string, cardId: string, sourceGroupId: string, targetColIdx: number, targetGroupIdx: number) => void;
  closeTabInGroup: (wsId: string, groupId: string, cardId: string) => void;

  // Sidebar Actions
  pinSession: (sessionId: string) => void;
  unpinSession: (sessionId: string) => void;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;
  branchSession: (sessionId: string, newTitle: string) => void;
  splitScreenWorkspace: (sessionId: string) => void;
  closeWorkspace: (wsId: string) => void;
  moveSessionRealtime: (sessionId: string, targetSessionId: string | null, targetFolder: string, isPinned: boolean) => void;
  moveFolderRealtime: (folderName: string, targetFolderName: string | null) => void;
  pinFolderSessions: (folderName: string) => void;
  unpinFolderSessions: (folderName: string) => void;
}

const DEFAULT_SESSIONS: SessionState[] = [
  { id: 'sess-1', title: '分析酒馆对话主界面问题', folder: '审计与代码分析', isPinned: false, isArchived: false, timestamp: '10分钟前' },
  { id: 'sess-2', title: '审计三个项目的代码统一性问题', folder: '审计与代码分析', isPinned: false, isArchived: false, timestamp: '1小时前' },
  { id: 'sess-3', title: 'Fix voice playback timing and overla', folder: '语音与播控', isPinned: false, isArchived: false, timestamp: '3天前' },
  { id: 'sess-4', title: '定制菜单与滚动区域优化', folder: '常规会话', isPinned: false, isArchived: false, timestamp: '5天前' },
  { id: 'sess-5', title: '添加终端与主题扩展', folder: '常规会话', isPinned: false, isArchived: false, timestamp: '1周前' },
];

function createDefaultWorkspace(id: string): WorkspaceState {
  return {
    id,
    columns: [
      {
        id: `col-chat-${id}`,
        widthRatio: 0.38,
        groups: [
          {
            id: `group-chat-${id}`,
            activeCardId: 'chat',
            cards: [{ id: 'chat', title: 'Chat' }],
            heightRatio: 1.0,
          },
        ],
      },
      {
        id: `col-1-${id}`,
        widthRatio: 0.31,
        groups: [
          {
            id: `group-plan-${id}`,
            activeCardId: 'plan',
            cards: [{ id: 'plan', title: 'Plan' }],
            heightRatio: 0.45,
          },
          {
            id: `group-preview-${id}`,
            activeCardId: 'preview',
            cards: [{ id: 'preview', title: 'Preview' }],
            heightRatio: 0.55,
          },
        ],
      },
      {
        id: `col-2-${id}`,
        widthRatio: 0.31,
        groups: [
          {
            id: `group-diff-${id}`,
            activeCardId: 'diff',
            cards: [{ id: 'diff', title: 'Diff' }],
            heightRatio: 0.5,
          },
          {
            id: `group-tasks-${id}`,
            activeCardId: 'tasks',
            cards: [{ id: 'tasks', title: 'Tasks' }],
            heightRatio: 0.5,
          },
        ],
      },
    ],
  };
}

export const useLayoutStore = create<LayoutStore>()(
  immer((set) => ({
    workspaces: [createDefaultWorkspace('ws-0')],
    activeWorkspaceIndex: 0,
    tabModeEnabled: false,
    uiSize: 'medium',
    sidebarCollapsed: false,
    sessions: DEFAULT_SESSIONS,
    folderOrder: ['审计与代码分析', '语音与播控', '常规会话'],
    activeSessionId: 'sess-2',
    draggedTab: null,
    dropPreview: null,
    panelsDropdownCoords: null,

    setDropPreview: (preview) => set((state) => { state.dropPreview = preview; }),
    setUiSize: (size) => set((state) => { state.uiSize = size; }),
    setSidebarCollapsed: (collapsed) => set((state) => { state.sidebarCollapsed = collapsed; }),
    setTabModeEnabled: (enabled) => set((state) => { state.tabModeEnabled = enabled; }),
    setActiveSessionId: (id) => set((state) => { state.activeSessionId = id; }),
    setPanelsDropdownCoords: (coords) => set((state) => { state.panelsDropdownCoords = coords; }),

    togglePanel: (wsId, key, isVisible) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      const cardId = key;
      const cardTitle = key.charAt(0).toUpperCase() + key.slice(1);

      if (isVisible) {
        // Check if card already exists anywhere in this workspace
        let alreadyExists = false;
        ws.columns.forEach((col) => {
          col.groups.forEach((g) => {
            if (g.cards.some((c) => c.id === cardId)) {
              alreadyExists = true;
            }
          });
        });
        if (alreadyExists) return;

        // If tab mode is enabled, try to merge it into the first active non-chat card group
        if (state.tabModeEnabled) {
          let targetGroup: CardGroupState | null = null;
          for (let i = 1; i < ws.columns.length; i++) {
            if (ws.columns[i].groups.length > 0) {
              targetGroup = ws.columns[i].groups[0];
              break;
            }
          }

          if (targetGroup) {
            targetGroup.cards.push({ id: cardId, title: cardTitle });
            targetGroup.activeCardId = cardId;
            return;
          }
        }

        // Otherwise, open as a standalone card group.
        // Determine default column index (0 = Chat (locked), 1 = Plan/Preview, 2 = Diff/Tasks/Terminal)
        let defaultColIdx = 1;
        if (key === 'tasks' || key === 'terminal') defaultColIdx = 2;

        const targetColIdx = Math.min(defaultColIdx, ws.columns.length);

        while (ws.columns.length <= targetColIdx) {
          ws.columns.push({
            id: `col-${ws.columns.length}-${ws.id}`,
            widthRatio: 0.3,
            groups: [],
          });
        }

        const col = ws.columns[targetColIdx];
        const evenHeight = 1 / (col.groups.length + 1);
        col.groups.forEach((g) => {
          g.heightRatio = evenHeight;
        });

        col.groups.push({
          id: `group-${cardId}-${Date.now()}-${ws.id}`,
          activeCardId: cardId,
          cards: [{ id: cardId, title: cardTitle }],
          heightRatio: evenHeight,
        });

        // Filter empty columns
        ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);

        // Always re-normalize column widths so the new column is visible
        {
          const total = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
          ws.columns.forEach((c) => { c.widthRatio /= total; });
        }

      } else {
        // Hide panel: Find and remove it from whichever group it's inside
        ws.columns.forEach((col) => {
          col.groups.forEach((group) => {
            const cardIdx = group.cards.findIndex((c) => c.id === cardId);
            if (cardIdx !== -1) {
              group.cards.splice(cardIdx, 1);
              // If we removed the active card, switch active
              if (group.activeCardId === cardId && group.cards.length > 0) {
                group.activeCardId = group.cards[0].id;
              }
            }
          });

          // Filter out groups that have no cards left
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.cards.length > 0);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            // Equalize remaining heights
            const evenHeight = 1 / col.groups.length;
            col.groups.forEach((g) => { g.heightRatio = evenHeight; });
          }
        });

        // Filter out empty columns (except Chat column)
        ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
        
        // Re-normalize column widths
        const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
        ws.columns.forEach((c) => { c.widthRatio /= sum; });
      }
    }),

    resizeColumns: (wsId, colIdx, dx, containerWidth) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length - 1) return;

      const colLeft = ws.columns[colIdx];
      const colRight = ws.columns[colIdx + 1];

      const ratioDelta = dx / containerWidth;
      const newLeft = colLeft.widthRatio + ratioDelta;
      const newRight = colRight.widthRatio - ratioDelta;

      if (newLeft > 0.1 && newRight > 0.1) {
        colLeft.widthRatio = newLeft;
        colRight.widthRatio = newRight;
      }
    }),

    resizeGroups: (wsId, colIdx, groupIdx, dy, containerHeight) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws || colIdx < 0 || colIdx >= ws.columns.length) return;

      const col = ws.columns[colIdx];
      if (groupIdx < 0 || groupIdx >= col.groups.length - 1) return;

      const groupTop = col.groups[groupIdx];
      const groupBottom = col.groups[groupIdx + 1];

      const ratioDelta = dy / containerHeight;
      const newTop = groupTop.heightRatio + ratioDelta;
      const newBottom = groupBottom.heightRatio - ratioDelta;

      if (newTop > 0.1 && newBottom > 0.1) {
        groupTop.heightRatio = newTop;
        groupBottom.heightRatio = newBottom;
      }
    }),

    setDraggedTab: (dragged) => set((state) => {
      state.draggedTab = dragged;
    }),

    mergeTab: (wsId, cardId, sourceGroupId, targetGroupId, targetIndex) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      // ── Same-group reorder (tab drag within same card) ──────────────────
      if (sourceGroupId === targetGroupId) {
        let group: any = null;
        ws.columns.forEach((col) => col.groups.forEach((g) => {
          if (g.id === sourceGroupId) group = g;
        }));
        if (!group) return;
        const fromIdx = group.cards.findIndex((c: CardState) => c.id === cardId);
        if (fromIdx === -1) return;
        const [card] = group.cards.splice(fromIdx, 1);
        // Adjust index for the gap created by removal
        let toIdx = targetIndex !== undefined ? targetIndex : group.cards.length;
        if (toIdx > fromIdx) toIdx = Math.max(0, toIdx - 1);
        toIdx = Math.min(toIdx, group.cards.length);
        group.cards.splice(toIdx, 0, card);
        group.activeCardId = cardId;
        return;
      }

      // ── Cross-group merge ───────────────────────────────────────────────
      let sourceGroup: any = null;
      let targetGroup: any = null;
      let draggedCard: CardState | null = null;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
          if (g.id === targetGroupId) {
            targetGroup = g;
          }
        });
      });

      if (!targetGroup || !draggedCard) return;

      // Add to target at specific index if provided, otherwise append
      if (targetIndex !== undefined && targetIndex >= 0 && targetIndex <= targetGroup.cards.length) {
        targetGroup.cards.splice(targetIndex, 0, draggedCard);
      } else {
        targetGroup.cards.push(draggedCard);
      }
      targetGroup.activeCardId = cardId;

      // Clean up source group if empty
      if (sourceGroup && (sourceGroup as CardGroupState).cards.length === 0) {
        ws.columns.forEach((col) => {
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.id !== sourceGroupId);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            const evenHeight = 1 / col.groups.length;
            col.groups.forEach((g) => { g.heightRatio = evenHeight; });
          }
        });

        // Filter out empty columns
        ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
        const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
        ws.columns.forEach((c) => { c.widthRatio /= sum; });
      } else if (sourceGroup) {
        // Switch active tab of source if the removed tab was active
        if ((sourceGroup as CardGroupState).activeCardId === cardId && (sourceGroup as CardGroupState).cards.length > 0) {
          (sourceGroup as CardGroupState).activeCardId = (sourceGroup as CardGroupState).cards[0].id;
        }
      }

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId && state.draggedTab.sourceGroupId === sourceGroupId) {
        state.draggedTab.sourceGroupId = targetGroupId;
      }
    }),

    detachTabToStandalone: (wsId, cardId, sourceGroupId, colIdx, direction, targetGroupIdx) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      const sourceCol = ws.columns.find((col) => col.groups.some((g) => g.id === sourceGroupId));

      let sourceGroup: any = null;
      let draggedCard: CardState | null = null;

      // Extract card from source group
      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
        });
      });

      if (!draggedCard) return;

      const cardTitle = cardId.charAt(0).toUpperCase() + cardId.slice(1);

      // Check if the source column only has 1 group, and that group is now empty (meaning it will be deleted)
      const isSourceColGoingToBeDeleted = sourceCol && 
        sourceCol.groups.length === 1 && 
        sourceCol.groups[0].cards.length === 0;

      const inheritedWidth = (isSourceColGoingToBeDeleted && sourceCol) ? sourceCol.widthRatio : 0.3;

      const newGroupId = `group-det-${cardId}-${Date.now()}-${Math.floor(Math.random() * 1000)}-${ws.id}`;

      if (direction === 'new-col') {
        // Create new column at colIdx
        const newCol: ColumnState = {
          id: `col-new-${Date.now()}-${ws.id}`,
          widthRatio: inheritedWidth,
          groups: [
            {
              id: newGroupId,
              activeCardId: cardId,
              cards: [{ id: cardId, title: cardTitle }],
              heightRatio: 1.0,
            },
          ],
        };
        ws.columns.splice(colIdx, 0, newCol);
      } else {
        // Add to existing column as a split group (top or bottom relative to targetGroupIdx)
        const col = ws.columns[colIdx];
        const numGroups = col.groups.length + 1;
        const evenHeight = 1 / numGroups;
        col.groups.forEach((g) => { g.heightRatio = evenHeight; });

        const newGroup: CardGroupState = {
          id: newGroupId,
          activeCardId: cardId,
          cards: [{ id: cardId, title: cardTitle }],
          heightRatio: evenHeight,
        };

        if (targetGroupIdx !== undefined && targetGroupIdx >= 0 && targetGroupIdx <= col.groups.length) {
          const insertIdx = direction === 'top' ? targetGroupIdx : targetGroupIdx + 1;
          col.groups.splice(insertIdx, 0, newGroup);
        } else {
          if (direction === 'top') {
            col.groups.unshift(newGroup);
          } else {
            col.groups.push(newGroup);
          }
        }
      }

      // Clean up source group if empty
      if (sourceGroup && (sourceGroup as CardGroupState).cards.length === 0) {
        ws.columns.forEach((col) => {
          const oldGroupsLength = col.groups.length;
          col.groups = col.groups.filter((g) => g.id !== sourceGroupId);
          if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
            const evenHeight = 1 / col.groups.length;
            col.groups.forEach((g) => { g.heightRatio = evenHeight; });
          }
        });
      } else if (sourceGroup) {
        if ((sourceGroup as CardGroupState).activeCardId === cardId && (sourceGroup as CardGroupState).cards.length > 0) {
          (sourceGroup as CardGroupState).activeCardId = (sourceGroup as CardGroupState).cards[0].id;
        }
      }

      // Clean up empty columns (except Chat column)
      ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);

      // Normalize all widths
      const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
      ws.columns.forEach((c) => { c.widthRatio /= sum; });

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId && state.draggedTab.sourceGroupId === sourceGroupId) {
        state.draggedTab.sourceGroupId = newGroupId;
      }
    }),

    moveTabOrGroupRealtime: (wsId, cardId, sourceGroupId, targetColIdx, targetGroupIdx) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      // Find source group and card
      let sourceCol: any = null;
      let sourceGroup: any = null;
      let draggedCard: any = null;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === sourceGroupId) {
            sourceCol = col;
            sourceGroup = g;
            const idx = g.cards.findIndex((c) => c.id === cardId);
            if (idx !== -1) {
              draggedCard = g.cards[idx];
              g.cards.splice(idx, 1);
            }
          }
        });
      });

      if (!draggedCard || !sourceCol || !sourceGroup) return;

      const cardTitle = cardId.charAt(0).toUpperCase() + cardId.slice(1);

      // Clean up source group if empty
      if (sourceGroup.cards.length === 0) {
        sourceCol.groups = sourceCol.groups.filter((g: any) => g.id !== sourceGroupId);
        if (sourceCol.groups.length > 0) {
          const sum = sourceCol.groups.reduce((a: number, b: any) => a + b.heightRatio, 0);
          sourceCol.groups.forEach((g: any) => { g.heightRatio /= sum; });
        }
      } else {
        if (sourceGroup.activeCardId === cardId) {
          sourceGroup.activeCardId = sourceGroup.cards[0].id;
        }
      }

      // Clean up empty columns (except Chat column)
      const oldColCount = ws.columns.length;
      ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
      if (ws.columns.length !== oldColCount) {
        const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
        ws.columns.forEach((c) => { c.widthRatio /= sum; });
      }

      // Bound targetColIdx
      const colIdx = Math.min(Math.max(targetColIdx, 1), ws.columns.length - 1);
      const col = ws.columns[colIdx];

      // Create new group
      const newGroupId = `group-det-${cardId}-${Date.now()}-${Math.floor(Math.random() * 1000)}-${ws.id}`;
      const newGroup: CardGroupState = {
        id: newGroupId,
        activeCardId: cardId,
        cards: [{ id: cardId, title: cardTitle }],
        heightRatio: 1.0,
      };

      // Insert group at targetGroupIdx
      const insertIdx = Math.min(Math.max(targetGroupIdx, 0), col.groups.length);
      col.groups.splice(insertIdx, 0, newGroup);

      // Equidistribute heights in target column
      const evenHeight = 1 / col.groups.length;
      col.groups.forEach((g) => { g.heightRatio = evenHeight; });

      // Keep dragged tab in sync
      if (state.draggedTab && state.draggedTab.cardId === cardId) {
        state.draggedTab.sourceGroupId = newGroupId;
      }
    }),

    closeTabInGroup: (wsId, groupId, cardId) => set((state) => {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws) return;

      ws.columns.forEach((col) => {
        col.groups.forEach((g) => {
          if (g.id === groupId) {
            g.cards = g.cards.filter((c) => c.id !== cardId);
            if (g.activeCardId === cardId && g.cards.length > 0) {
              g.activeCardId = g.cards[0].id;
            }
          }
        });

        // Filter empty groups
        const oldGroupsLength = col.groups.length;
        col.groups = col.groups.filter((g) => g.cards.length > 0);
        if (col.groups.length > 0 && col.groups.length !== oldGroupsLength) {
          const evenHeight = 1 / col.groups.length;
          col.groups.forEach((g) => { g.heightRatio = evenHeight; });
        }
      });

      // Filter empty columns
      ws.columns = ws.columns.filter((c) => c.id.includes('chat') || c.groups.length > 0);
      const sum = ws.columns.reduce((a, b) => a + b.widthRatio, 0);
      ws.columns.forEach((c) => { c.widthRatio /= sum; });
    }),

    pinSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isPinned = true;
    }),

    unpinSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isPinned = false;
    }),

    archiveSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isArchived = true;
    }),

    unarchiveSession: (sessionId) => set((state) => {
      const sess = state.sessions.find((s) => s.id === sessionId);
      if (sess) sess.isArchived = false;
    }),

    branchSession: (sessionId, newTitle) => set((state) => {
      const original = state.sessions.find((s) => s.id === sessionId);
      if (!original) return;

      const newSess: SessionState = {
        id: `sess-branch-${Date.now()}`,
        title: newTitle,
        folder: original.folder,
        isPinned: false,
        isArchived: false,
        branchParentId: sessionId,
        timestamp: '刚刚',
      };
      // Insert branch right after the original session
      const idx = state.sessions.findIndex((s) => s.id === sessionId);
      state.sessions.splice(idx + 1, 0, newSess);
    }),

    splitScreenWorkspace: (_sessionId) => set((state) => {
      const newWsId = `ws-${Date.now()}`;
      state.workspaces.push(createDefaultWorkspace(newWsId));
      state.activeWorkspaceIndex = state.workspaces.length - 1;
    }),

    closeWorkspace: (wsId) => set((state) => {
      if (state.workspaces.length <= 1) return; // Keep at least one workspace
      const idx = state.workspaces.findIndex((w) => w.id === wsId);
      if (idx !== -1) {
        state.workspaces.splice(idx, 1);
        state.activeWorkspaceIndex = Math.max(0, idx - 1);
      }
    }),

    moveSessionRealtime: (sessionId, targetSessionId, targetFolder, isPinned) => set((state) => {
      const sessIdx = state.sessions.findIndex((s) => s.id === sessionId);
      if (sessIdx === -1) return;

      const [sess] = state.sessions.splice(sessIdx, 1);
      sess.isPinned = isPinned;
      sess.folder = targetFolder;

      if (targetSessionId) {
        const tIdx = state.sessions.findIndex((s) => s.id === targetSessionId);
        if (tIdx !== -1) {
          state.sessions.splice(tIdx, 0, sess);
        } else {
          state.sessions.push(sess);
        }
      } else {
        state.sessions.push(sess);
      }
    }),

    moveFolderRealtime: (folderName, targetFolderName) => set((state) => {
      const idx = state.folderOrder.indexOf(folderName);
      if (idx === -1) return;
      state.folderOrder.splice(idx, 1);
      if (targetFolderName) {
        const tIdx = state.folderOrder.indexOf(targetFolderName);
        if (tIdx !== -1) {
          state.folderOrder.splice(tIdx, 0, folderName);
        } else {
          state.folderOrder.push(folderName);
        }
      } else {
        state.folderOrder.push(folderName);
      }
    }),

    pinFolderSessions: (folderName) => set((state) => {
      state.sessions.forEach((s) => {
        if (s.folder === folderName) {
          s.isPinned = true;
        }
      });
    }),

    unpinFolderSessions: (folderName) => set((state) => {
      state.sessions.forEach((s) => {
        if (s.folder === folderName) {
          s.isPinned = false;
        }
      });
    }),
  }))
);

if (typeof window !== 'undefined') {
  (window as any).useLayoutStore = useLayoutStore;
}
