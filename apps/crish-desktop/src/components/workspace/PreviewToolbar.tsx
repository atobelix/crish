/**
 * 预览浏览器工具栏：后退/前进/主页/刷新 + 地址栏（安全 src 判定入参由
 * usePreviewNavigation 提供）+ 书签 + 历史开关 + 外部打开。
 * 纯渲染：一切导航动作与安全校验由 hook 注入。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './PreviewCard.module.css';
import { Button, Tooltip } from '../ui';

export type PreviewToolbarProps = {
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
  /** AI 受管浏览器模式（BrowserPanel）；true 时工具栏地址栏等仍可见但内容区切换 */
  aiBrowser: boolean;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onReload: () => void;
  onUrlSubmit: (raw: string) => void;
  onUrlChange: (v: string) => void;
  onClearUrl: () => void;
  onBookmark: () => void;
  onToggleHist: () => void;
  onOpenExternal: () => void;
  onToggleAiBrowser: () => void;
};

export const PreviewToolbar: React.FC<PreviewToolbarProps> = ({
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
  aiBrowser,
  onBack,
  onForward,
  onHome,
  onReload,
  onUrlSubmit,
  onUrlChange,
  onClearUrl,
  onBookmark,
  onToggleHist,
  onOpenExternal,
  onToggleAiBrowser,
}) => {
  const iconSz = 14;
  return (
    <div className={styles.bar} role="toolbar" aria-label="预览浏览器工具栏">
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
      <Tooltip content={aiBrowser ? '返回内嵌预览' : 'AI 浏览器（受管窗口）'}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${styles.navBtn} ${aiBrowser ? styles.isOn : ''}`}
          data-ai-browser-toggle=""
          onClick={onToggleAiBrowser}
          aria-label={aiBrowser ? '返回内嵌预览' : 'AI 浏览器（受管窗口）'}
          aria-pressed={aiBrowser}
          icon={<Lucide.Monitor size={iconSz} strokeWidth={1.75} />}
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
