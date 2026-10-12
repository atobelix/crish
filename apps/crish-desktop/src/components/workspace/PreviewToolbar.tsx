/**
 * 预览浏览器工具栏：后退/前进/主页/刷新 + 地址栏（安全 src 判定入参由
 * usePreviewNavigation 提供）+ 书签 + 历史开关 + 外部打开。
 * 纯渲染：一切导航动作与安全校验由 hook 注入。
 */
import React from 'react';

import styles from './PreviewCard.module.css';
import { IconButton, Input } from '../ui';
import { AppIcon } from '../ui/icons/index';

/** 预览状态（可回退/前进/空白/src/加载/地址/书签/历史/外部打开等收敛为单一子对象） */
export interface PreviewToolbarPreviewProps {
  canBack: boolean;
  canForward: boolean;
  blank: boolean;
  /** 可内嵌 src（null = 不可刷新） */
  frameSrc: string | null;
  loading: boolean;
  urlInput: string;
  canBookmark: boolean;
  bookmarked: boolean;
  showHist: boolean;
  canExternal: boolean;
  /** DOM 检查器是否处于激活状态 */
  isInspectorActive?: boolean;
}

/** 导航操作域（后退/前进/主页/刷新/地址提交与变更/清空收敛为单一子对象） */
export interface PreviewToolbarNavigationProps {
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onReload: () => void;
  onUrlSubmit: (raw: string) => void;
  onUrlChange: (v: string) => void;
  onClearUrl?: () => void;
}

/** 工具栏动作域（书签/历史切换/外部打开/DOM 检查器收敛为单一子对象） */
export interface PreviewToolbarActionsProps {
  onBookmark: () => void;
  onToggleHist: () => void;
  onOpenExternal: () => void;
  onToggleInspector?: () => void;
}

export type PreviewToolbarProps = {
  /** 预览状态 */
  preview: PreviewToolbarPreviewProps;
  /** 导航操作域 */
  navigation: PreviewToolbarNavigationProps;
  /** 工具栏动作域 */
  actions: PreviewToolbarActionsProps;
  /** 历史面板 DOM ID（缺省自动通过 useId 生成） */
  historyPanelId?: string;
};

export const PreviewToolbar: React.FC<PreviewToolbarProps> = ({
  preview,
  navigation,
  actions,
  historyPanelId,
}) => {
  const autoHistId = React.useId();
  const histPanelId = historyPanelId || autoHistId;
  const {
    canBack,
    canForward,
    blank,
    frameSrc,
    loading,
    urlInput,
    canBookmark,
    bookmarked,
    showHist,
    canExternal,
    isInspectorActive,
  } = preview;
  const {
    onBack,
    onForward,
    onHome,
    onReload,
    onUrlSubmit,
    onUrlChange,
    onClearUrl: _onClearUrl,
  } = navigation;
  const { onBookmark, onToggleHist, onOpenExternal, onToggleInspector } =
    actions;
  const iconSz = 14;
  return (
    <div
      className={`${styles.bar} side-panel-toolbar`}
      role="toolbar"
      aria-label="预览浏览器工具栏"
    >
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        disabled={!canBack}
        onClick={onBack}
        aria-label="后退"
        tooltip="后退"
        icon={<AppIcon name="chevron-left" size={iconSz} />}
      />
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        disabled={!canForward}
        onClick={onForward}
        aria-label="前进"
        tooltip="前进"
        icon={<AppIcon name="chevron-right" size={iconSz} />}
      />
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        className={styles.hideNarrow}
        onClick={onHome}
        aria-label="主页"
        tooltip="主页（空白预览）"
        icon={<AppIcon name="home" size={iconSz} />}
      />
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        disabled={blank || !frameSrc}
        onClick={onReload}
        aria-label="刷新"
        aria-busy={loading || undefined}
        tooltip="刷新"
        icon={
          loading ? (
            <AppIcon name="loader" size={iconSz} className={styles.spin} />
          ) : (
            <AppIcon name="rotate-cw" size={iconSz} />
          )
        }
      />
      <form
        className={styles.urlForm}
        aria-label="预览地址栏"
        onSubmit={(e) => {
          e.preventDefault();
          // 空提交 → about:blank（validateBrowseUrl 成功静默路径）
          onUrlSubmit(urlInput.trim() ? urlInput : 'about:blank');
        }}
      >
        <Input
          variant="search"
          size="xs"
          className={styles.urlInput}
          value={urlInput}
          placeholder="请输入网址"
          onChange={(e) => onUrlChange(e.target.value)}
          prefixIcon={<AppIcon name="globe" size={13} aria-hidden />}
          spellCheck={false}
          aria-label="预览地址"
          autoComplete="off"
          inputMode="url"
          enterKeyHint="go"
          onFocus={(e) => {
            e.currentTarget.select();
          }}
        />
      </form>
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        active={isInspectorActive}
        className={isInspectorActive ? styles.inspectorActive : undefined}
        onClick={onToggleInspector}
        disabled={blank || !frameSrc}
        aria-label="拾取页面元素"
        aria-pressed={isInspectorActive}
        tooltip={
          isInspectorActive ? '退出元素拾取 (Esc)' : '拾取页面元素 (Inspect)'
        }
        icon={<AppIcon name="mouse-pointer-click" size={iconSz} />}
      />
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        active={bookmarked}
        onClick={onBookmark}
        disabled={!canBookmark}
        aria-label={bookmarked ? '取消书签' : '加入书签'}
        aria-pressed={bookmarked}
        tooltip={
          !canBookmark
            ? '空白页无法加入书签'
            : bookmarked
              ? '取消书签'
              : '加入书签'
        }
        icon={
          <AppIcon
            name="star"
            size={iconSz}
            fill={bookmarked ? 'currentColor' : 'none'}
          />
        }
      />
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        active={showHist}
        data-hist-toggle=""
        onClick={onToggleHist}
        aria-label="历史与书签"
        aria-expanded={showHist}
        aria-controls={histPanelId}
        aria-haspopup="dialog"
        tooltip="历史与书签"
        icon={<AppIcon name="history" size={iconSz} />}
      />
      <IconButton
        type="button"
        variant="ghost"
        size="sm"
        className={styles.hideXNarrow}
        onClick={onOpenExternal}
        disabled={!canExternal}
        aria-label="系统浏览器打开"
        tooltip={canExternal ? '系统浏览器打开' : '当前地址无法外部打开'}
        icon={<AppIcon name="external-link" size={iconSz} />}
      />
    </div>
  );
};
