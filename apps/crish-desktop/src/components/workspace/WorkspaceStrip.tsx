import React from 'react';
import styles from './WorkspaceChromeBars.module.css';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
import { Tooltip } from '../Tooltip';
import {
  Folder,
  FolderPlus,
  MessagesSquare,
  Minus,
  MoreHorizontal,
  Plus,
  Square,
  X,
} from 'lucide-react';
import {
  useChromeAddMenu,
  useRightSidebarState,
  useWorkspaceChromeState,
  type WorkspaceChromeProps,
} from './workspaceChromeHooks';

/** 仅工作区行（项目 tab + 运行/帮助 + 可选窗控） */
export const WorkspaceStrip: React.FC<WorkspaceChromeProps> = ({
  onAddProject,
  className,
  onOpenHelp,
  onWinMinimize,
  onWinMaximize,
  onWinClose,
}) => {
  const s = useWorkspaceChromeState(onAddProject);
  const { isRightSidebarCollapsed, toggleRightSidebar } =
    useRightSidebarState();
  const showTrail = true; // Always show trail for the right sidebar toggle button
  const add = useChromeAddMenu();

  return (
    <div
      className={`${styles.wsChromeRow} ${styles.wsChromeRowWorkspace} ws-chrome-row ws-chrome-row--workspace ${className || ''}`}
      role="tablist"
      aria-label="工作区"
      data-tauri-drag-region
    >
      <div className={`${styles.wsChromeScroll} ws-chrome-scroll`}>
        {s.workspaceTabs.map((tab) => {
          const active = tab.id === s.activeWsId;
          return (
            <Tooltip key={tab.id} content={tab.path || tab.label}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={`${styles.wsChromeTab} ${active ? styles.isActive + ' is-active' : ''} ws-chrome-tab`}
                onClick={() => s.selectWorkspace(tab)}
              >
                {tab.kind === 'project' ? (
                  <Folder size={13} strokeWidth={1.75} aria-hidden />
                ) : (
                  <MessagesSquare size={13} strokeWidth={1.75} aria-hidden />
                )}
                <span
                  className={`${styles.wsChromeTabLabel} ws-chrome-tab-label`}
                >
                  {tab.label}
                </span>
              </button>
            </Tooltip>
          );
        })}
        <div
          className={`${styles.wsChromeAddWrap} ws-chrome-add-wrap`}
          ref={add.wrapRef}
        >
          <Tooltip content="添加">
            <button
              type="button"
              className={`${styles.wsChromeTab} ${styles.wsChromeTabAdd} ws-chrome-tab ws-chrome-tab--add`}
              aria-label="添加工作区"
              aria-haspopup="menu"
              aria-expanded={add.open}
              aria-controls={add.menuId}
              onClick={() => add.setOpen((v) => !v)}
            >
              <Plus size={14} strokeWidth={2} aria-hidden />
            </button>
          </Tooltip>
          {add.open ? (
            <div
              id={add.menuId}
              className={`${styles.wsChromeAddMenu} ws-chrome-add-menu`}
              role="menu"
              aria-label="添加工作区"
            >
              <button
                type="button"
                role="menuitem"
                className={`${styles.wsChromeAddItem} ws-chrome-add-item`}
                onClick={() => {
                  add.setOpen(false);
                  s.onAdd();
                }}
              >
                <FolderPlus size={16} strokeWidth={1.75} aria-hidden />
                <span
                  className={`${styles.wsChromeAddItemText} ws-chrome-add-item-text`}
                >
                  <span>添加本地项目</span>
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`${styles.wsChromeAddItem} ws-chrome-add-item`}
                onClick={() => {
                  add.setOpen(false);
                  s.selectWorkspace({
                    kind: 'general',
                    id: GENERAL_FOLDER,
                    label: GENERAL_FOLDER,
                  });
                }}
              >
                <MessagesSquare size={16} strokeWidth={1.75} aria-hidden />
                <span
                  className={`${styles.wsChromeAddItemText} ws-chrome-add-item-text`}
                >
                  <span>切换到「对话」</span>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {showTrail ? (
        <div
          className={`${styles.wsChromeTrail} ws-chrome-trail ws-chrome-trail--win`}
          role="toolbar"
          aria-label="顶栏操作"
        >
          <Tooltip
            content={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}
          >
            <button
              type="button"
              className={`${styles.wsChromeTrailBtn} no-drag ${!isRightSidebarCollapsed ? 'is-active' : ''} ws-chrome-trail-btn`}
              aria-label={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}
              onClick={toggleRightSidebar}
            >
              <IconSidebarRight size={15} aria-hidden />
            </button>
          </Tooltip>

          {onOpenHelp ? (
            <Tooltip content="快捷键与帮助">
              <button
                type="button"
                className={`${styles.wsChromeTrailBtn} no-drag ws-chrome-trail-btn`}
                aria-label="快捷键与帮助"
                onClick={onOpenHelp}
              >
                <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          {onWinMinimize ? (
            <Tooltip content="最小化">
              <button
                type="button"
                className={`${styles.wsChromeTrailBtn} no-drag ws-chrome-trail-btn`}
                aria-label="最小化窗口"
                onClick={onWinMinimize}
              >
                <Minus size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          {onWinMaximize ? (
            <Tooltip content="最大化">
              <button
                type="button"
                className={`${styles.wsChromeTrailBtn} no-drag ws-chrome-trail-btn`}
                aria-label="最大化或还原窗口"
                onClick={onWinMaximize}
              >
                <Square size={12} strokeWidth={1.75} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
          {onWinClose ? (
            <Tooltip content="关闭">
              <button
                type="button"
                className={`${styles.wsChromeTrailBtn} ws-chrome-trail-btn--close no-drag ws-chrome-trail-btn`}
                aria-label="关闭窗口"
                onClick={onWinClose}
              >
                <X size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
