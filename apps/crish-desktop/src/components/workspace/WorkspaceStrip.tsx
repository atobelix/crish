import React from 'react';
import styles from './WorkspaceChromeBars.module.css';
import { GENERAL_FOLDER } from '../../api/projectStore';
import { IconSidebarRight } from '../sidebar/SidebarToggleIcons';
import { TabStrip, Button, Tooltip } from '../ui';
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

  const selectTab = (id: string) => {
    const tab = s.workspaceTabs.find((t) => t.id === id);
    if (tab) s.selectWorkspace(tab);
  };

  return (
    <TabStrip
      className={`${styles.wsChromeRow} ${styles.wsChromeRowWorkspace} ws-chrome-row ws-chrome-row--workspace ${className || ''}`}
      data={{ 'data-tauri-drag-region': true }}
      scrollClassName={`${styles.wsChromeScroll} ws-chrome-scroll`}
      tabClassName={`${styles.wsChromeTab} ws-chrome-tab`}
      tabActiveClassName={`${styles.isActive} is-active`}
      ariaLabel="工作区"
      activeId={s.activeWsId ?? null}
      tabs={s.workspaceTabs.map((tab) => ({ id: tab.id, label: tab.label }))}
      onActiveChange={selectTab}
      renderTab={(tab) => {
        const meta = s.workspaceTabs.find((t) => t.id === tab.id);
        return (
          <Tooltip content={meta?.path || tab.label}>
            <button
              type="button"
              className={`${styles.wsChromeTabMain} ws-chrome-tab-main`}
              tabIndex={-1}
              onClick={() => selectTab(tab.id)}
            >
              {meta?.kind === 'project' ? (
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
      }}
      trailing={
        <div
          className={`${styles.wsChromeAddWrap} ws-chrome-add-wrap`}
          ref={add.wrapRef}
        >
          <Tooltip content="添加">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${styles.wsChromeTab} ${styles.wsChromeTabAdd} ws-chrome-tab ws-chrome-tab--add`}
              aria-label="添加工作区"
              aria-haspopup="menu"
              aria-expanded={add.open}
              aria-controls={add.menuId}
              onClick={() => add.setOpen((v) => !v)}
              icon={<Plus size={14} strokeWidth={2} aria-hidden />}
            />
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
      }
      wrapTrailing={
        showTrail ? (
          <div
            className={`${styles.wsChromeTrail} ws-chrome-trail ws-chrome-trail--win`}
            role="toolbar"
            aria-label="顶栏操作"
          >
            <Tooltip
              content={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.wsChromeTrailBtn} no-drag ${!isRightSidebarCollapsed ? 'is-active' : ''} ws-chrome-trail-btn`}
                aria-label={
                  isRightSidebarCollapsed ? '展开右面板' : '收起右面板'
                }
                onClick={toggleRightSidebar}
                icon={<IconSidebarRight size={15} aria-hidden />}
              />
            </Tooltip>

            {onOpenHelp ? (
              <Tooltip content="快捷键与帮助">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${styles.wsChromeTrailBtn} no-drag ws-chrome-trail-btn`}
                  aria-label="快捷键与帮助"
                  onClick={onOpenHelp}
                  icon={
                    <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden />
                  }
                />
              </Tooltip>
            ) : null}
            {onWinMinimize ? (
              <Tooltip content="最小化">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${styles.wsChromeTrailBtn} no-drag ws-chrome-trail-btn`}
                  aria-label="最小化窗口"
                  onClick={onWinMinimize}
                  icon={<Minus size={14} strokeWidth={1.75} aria-hidden />}
                />
              </Tooltip>
            ) : null}
            {onWinMaximize ? (
              <Tooltip content="最大化">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${styles.wsChromeTrailBtn} no-drag ws-chrome-trail-btn`}
                  aria-label="最大化或还原窗口"
                  onClick={onWinMaximize}
                  icon={<Square size={12} strokeWidth={1.75} aria-hidden />}
                />
              </Tooltip>
            ) : null}
            {onWinClose ? (
              <Tooltip content="关闭">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={`${styles.wsChromeTrailBtn} ws-chrome-trail-btn--close no-drag ws-chrome-trail-btn`}
                  aria-label="关闭窗口"
                  onClick={onWinClose}
                  icon={<X size={14} strokeWidth={1.75} aria-hidden />}
                />
              </Tooltip>
            ) : null}
          </div>
        ) : null
      }
    />
  );
};
