/**
 * 预览浏览器工具栏：后退/前进/主页/刷新 + 地址栏（安全 src 判定入参由
 * usePreviewNavigation 提供）+ 书签 + 历史开关 + 外部打开。
 * 纯渲染：一切导航动作与安全校验由 hook 注入。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './PreviewCard.module.css';
import { Button, Tooltip } from '../ui';

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
  onClearUrl: () => void;
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
};

export const PreviewToolbar: React.FC<PreviewToolbarProps> = ({
  preview,
  navigation,
  actions,
}) => {
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
    onClearUrl,
  } = navigation;
  const { onBookmark, onToggleHist, onOpenExternal, onToggleInspector } = actions;
  const iconSz = 14;
  return (
    <div
      className={`${styles.bar} side-panel-toolbar`}
      role="toolbar"
      aria-label="预览浏览器工具栏"
    >
      <Tooltip content="后退">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.navBtn}
          disabled={!canBack}
          onClick={onBack}
          aria-label="后退"
          icon={<Lucide.ChevronLeft size={iconSz} strokeWidth={1.75} />}
        />
      </Tooltip>
      <Tooltip content="前进">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.navBtn}
          disabled={!canForward}
          onClick={onForward}
          aria-label="前进"
          icon={<Lucide.ChevronRight size={iconSz} strokeWidth={1.75} />}
        />
      </Tooltip>
      <Tooltip content="主页（空白预览）">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.navBtn} ${styles.hideNarrow}`}
          onClick={onHome}
          aria-label="主页"
          icon={<Lucide.Home size={iconSz} strokeWidth={1.75} />}
        />
      </Tooltip>
      <Tooltip content="刷新">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={styles.navBtn}
          disabled={blank || !frameSrc}
          onClick={onReload}
          aria-label="刷新"
          aria-busy={loading || undefined}
        >
          {loading ? (
            <Lucide.Loader2
              size={iconSz}
              strokeWidth={1.75}
              className={styles.spin}
            />
          ) : (
            <Lucide.RotateCw size={iconSz} strokeWidth={1.75} />
          )}
        </Button>
      </Tooltip>
      <form
        className={styles.urlForm}
        aria-label="预览地址栏"
        onSubmit={(e) => {
          e.preventDefault();
          // 空提交 → about:blank（validateBrowseUrl 成功静默路径）
          onUrlSubmit(urlInput.trim() ? urlInput : 'about:blank');
        }}
      >
        <Lucide.Globe
          size={iconSz}
          className={styles.urlIco}
          strokeWidth={1.75}
          aria-hidden
        />
        <input
          className={styles.urlInput}
          value={urlInput}
          placeholder="localhost:5173 或 https://…"
          onChange={(e) => onUrlChange(e.target.value)}
          spellCheck={false}
          aria-label="预览地址"
          autoComplete="off"
          inputMode="url"
          enterKeyHint="go"
        />
        {urlInput ? (
          <Tooltip content="清空">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.urlClear}
              onClick={onClearUrl}
              aria-label="清空地址"
              icon={<Lucide.X size={12} strokeWidth={1.75} />}
            />
          </Tooltip>
        ) : null}
      </form>
      <Tooltip
        content={
          isInspectorActive
            ? '退出元素拾取 (Esc)'
            : '拾取页面元素 (Inspect)'
        }
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.navBtn} ${isInspectorActive ? styles.inspectorActive : ''}`}
          onClick={onToggleInspector}
          disabled={blank || !frameSrc}
          aria-label="拾取页面元素"
          aria-pressed={isInspectorActive}
          icon={
            <Lucide.MousePointerClick
              size={iconSz}
              strokeWidth={1.75}
            />
          }
        />
      </Tooltip>
      <Tooltip
        content={
          !canBookmark
            ? '空白页无法加入书签'
            : bookmarked
              ? '取消书签'
              : '加入书签'
        }
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.navBtn} ${bookmarked ? styles.isOn : ''}`}
          onClick={onBookmark}
          disabled={!canBookmark}
          aria-label={bookmarked ? '取消书签' : '加入书签'}
          aria-pressed={bookmarked}
          icon={
            <Lucide.Star
              size={iconSz}
              strokeWidth={1.75}
              fill={bookmarked ? 'currentColor' : 'none'}
            />
          }
        />
      </Tooltip>
      <Tooltip content="历史与书签">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.navBtn} ${showHist ? styles.isOn : ''}`}
          data-hist-toggle=""
          onClick={onToggleHist}
          aria-label="历史与书签"
          aria-expanded={showHist}
          aria-controls="preview-hist-panel"
          aria-haspopup="dialog"
          icon={<Lucide.History size={iconSz} strokeWidth={1.75} />}
        />
      </Tooltip>
      <Tooltip
        content={canExternal ? '系统浏览器打开' : '当前地址无法外部打开'}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.navBtn} ${styles.hideXNarrow}`}
          onClick={onOpenExternal}
          disabled={!canExternal}
          aria-label="系统浏览器打开"
          icon={<Lucide.ExternalLink size={iconSz} strokeWidth={1.75} />}
        />
      </Tooltip>
    </div>
  );
};
