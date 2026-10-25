/**
 * 空界面（session-empty）项目选择胶囊：放在 composer 卡片外、紧贴其上方左侧。
 * 交互：点击打开 ProjectPickerMenu（以胶囊为锚点左对齐，默认向下、可盖住输入框，
 * 空间不足才向上；方向在打开瞬间锁定，打开期间不翻转）。点外部 / Esc 关闭并把焦点
 * 还给胶囊；选中项目后关闭并把焦点移到输入框。
 */
import React, { useCallback, useRef } from 'react';
import styles from './ComposerProjectPicker.module.css';
import { Button } from '../ui';
import {
  getActiveProject,
  listProjects,
  resolveFolderToProjectId,
  projectFolderLabel,
  GENERAL_FOLDER,
  type ProjectEntry,
} from '../../api/projectStore';
import { ProjectPickerMenu } from './ProjectPickerMenu';
import { AppIcon } from '../ui/icons/index';
import { useScopedSessionId } from '../../contexts/LeafScopeContext';
import { useDraftFolder } from '../../store/storeAccess';

/** 菜单预估高度（搜索 + 列表 180 上限 + 添加项 + 内衬），用于打开瞬间决定方向 */
const PANEL_ESTIMATED_HEIGHT_PX = 300;
const PANEL_SIDE_OFFSET_PX = 6;
const VIEWPORT_PADDING_PX = 12;

type PanelSide = 'top' | 'bottom';

/** 默认向下；下方放不下且上方更宽裕时才向上 */
function resolvePanelSide(trigger: HTMLElement | null): PanelSide {
  if (!trigger || typeof window === 'undefined') return 'bottom';
  const rect = trigger.getBoundingClientRect();
  const need =
    PANEL_ESTIMATED_HEIGHT_PX + PANEL_SIDE_OFFSET_PX + VIEWPORT_PADDING_PX;
  const below = window.innerHeight - rect.bottom;
  const above = rect.top;
  return below >= need || below >= above ? 'bottom' : 'top';
}

/** 聚焦同一 composer 的输入区（限定在当前分屏容器内） */
function focusComposerInput(trigger: HTMLElement | null): void {
  const host =
    trigger?.closest('[data-composer-wrapper]') ||
    trigger?.closest('[data-leaf-panel]') ||
    trigger?.closest('.chatBody');
  const el = host?.querySelector<HTMLElement>(
    '[data-composer-card] [contenteditable="true"], [data-composer-card] textarea:not([disabled])'
  );
  el?.focus();
}

export interface ScopedProjectInfo {
  project: ProjectEntry | null;
  displayName: string;
  isGeneral: boolean;
}

/** 窗格作用域优先的项目解析器（纯函数、零全局副作用） */
export function resolveProjectForScope(
  workspaceKey?: string | null
): ScopedProjectInfo {
  if (workspaceKey !== undefined && workspaceKey !== null) {
    const k = workspaceKey.trim();
    if (
      !k ||
      k === GENERAL_FOLDER ||
      k === '对话' ||
      k === '会话' ||
      k === '常规会话' ||
      k === 'general'
    ) {
      return { project: null, displayName: '通用项目', isGeneral: true };
    }

    const projectId = resolveFolderToProjectId(k);
    if (projectId) {
      const p = listProjects().find((proj) => proj.id === projectId);
      if (p) {
        return {
          project: p,
          displayName: p.name || projectFolderLabel(p.path),
          isGeneral: false,
        };
      }
    }

    // 无法解析到现存项目的内部 proj-* 幽灵 ID，归入通用项目
    if (/^proj-[a-z0-9_-]+$/i.test(k)) {
      const active = getActiveProject();
      if (active) {
        return {
          project: active,
          displayName: active.name || projectFolderLabel(active.path),
          isGeneral: false,
        };
      }
      return { project: null, displayName: '通用项目', isGeneral: true };
    }

    const label = projectFolderLabel(k);
    return { project: null, displayName: label, isGeneral: false };
  }

  const active = getActiveProject();
  if (active) {
    return {
      project: active,
      displayName: active.name || projectFolderLabel(active.path),
      isGeneral: false,
    };
  }
  return {
    project: null,
    displayName: '通用项目',
    isGeneral: true,
  };
}

export interface ComposerProjectPickerProps {
  sessionId?: string | null;
  /** 窗格绑定的项目作用域 Key（支持 project.id / folder / GENERAL_FOLDER） */
  workspaceKey?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProjectChanged?: () => void;
}

export const ComposerProjectPicker: React.FC<ComposerProjectPickerProps> = ({
  sessionId: sessionIdProp,
  workspaceKey,
  open,
  onOpenChange,
  onProjectChanged,
}) => {
  const scopedSessionId = useScopedSessionId(sessionIdProp);
  const draftFolder = useDraftFolder(scopedSessionId);
  const effectiveWorkspaceKey =
    workspaceKey !== undefined && workspaceKey !== null
      ? workspaceKey
      : draftFolder || null;

  // 不给 trigger 直挂 ref（面板 cloneElement 读 element.ref 在 React 19 告警），经外层容器取
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getTrigger = () =>
    rootRef.current?.querySelector<HTMLElement>(
      '[data-composer-project-picker]'
    ) ?? null;
  // 打开瞬间锁定方向：渲染期按 open 边沿解算，避免先渲染再翻转造成闪动
  const sideRef = useRef<PanelSide | null>(null);
  if (open && sideRef.current === null) {
    sideRef.current = resolvePanelSide(getTrigger());
  } else if (!open) {
    sideRef.current = null;
  }
  // 选中项目（onChanged 紧接着同步关闭）→ 关闭后聚焦输入框；其余关闭 → 还给胶囊
  const pickedRef = useRef(false);
  const restoreToComposerRef = useRef(false);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // 选中时菜单会连发两次关闭（ProjectPickerMenu + 面板 onSelect），只认置位、不覆盖
      if (next) {
        restoreToComposerRef.current = false;
      } else if (pickedRef.current) {
        restoreToComposerRef.current = true;
        pickedRef.current = false;
      }
      onOpenChange(next);
    },
    [onOpenChange]
  );

  const handleChanged = useCallback(() => {
    pickedRef.current = true;
    // 移除项目等不关闭菜单的变更：本轮事件后复位，不影响后续 Esc / 点外部的焦点去向
    setTimeout(() => {
      pickedRef.current = false;
    }, 0);
    onProjectChanged?.();
  }, [onProjectChanged]);

  const handleCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    const trigger = getTrigger();
    if (restoreToComposerRef.current) {
      restoreToComposerRef.current = false;
      focusComposerInput(trigger);
      return;
    }
    // 点外部落在另一个可聚焦控件上时尊重用户落点，否则还给胶囊
    const active =
      typeof document !== 'undefined' ? document.activeElement : null;
    if (!active || active === document.body) trigger?.focus();
  }, []);

  const { displayName } = resolveProjectForScope(effectiveWorkspaceKey);
  const ariaLabel = `当前项目：${displayName}，点击切换`;

  return (
    <div ref={rootRef} className={styles.root}>
      <ProjectPickerMenu
        sessionId={scopedSessionId}
        open={open}
        onOpenChange={handleOpenChange}
        onChanged={handleChanged}
        triggerMode="click"
        position={{
          side: sideRef.current ?? 'bottom',
          align: 'start',
          sideOffset: PANEL_SIDE_OFFSET_PX,
        }}
        avoidCollisions={false}
        onCloseAutoFocus={handleCloseAutoFocus}
      >
        <Button
          bare
          type="button"
          className={styles.projectPill}
          data-composer-project-picker=""
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={ariaLabel}
        >
          <AppIcon name="folder-01" size={14} aria-hidden />
          <span className={styles.projectName}>{displayName}</span>
          <AppIcon
            name="chevron-down"
            size={12}
            className={styles.chevron}
            aria-hidden
          />
        </Button>
      </ProjectPickerMenu>
    </div>
  );
};
