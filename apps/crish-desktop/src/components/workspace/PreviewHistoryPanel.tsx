/**
 * 预览历史/书签双列浮层：书签列 + 最近访问列（含清空/逐条移除）。
 * 非模态面板语义（aria-haspopup）；Esc/外点关闭由 usePreviewNavigation 接管。
 */
import React from 'react';

import styles from './PreviewCard.module.css';
import { Button, Tooltip } from '../ui';
import { previewDisplayHost } from '../../api/previewBrowserStore';
import { AppIcon } from '../ui/icons/index';

export type PreviewHistoryPanelProps = {
  history: string[];
  bookmarks: { url: string; title?: string }[];
  activeUrl: string;
  blank: boolean;
  histRef: React.RefObject<HTMLDivElement | null>;
  onPickUrl: (u: string) => void;
  onRemoveBookmark: (url: string) => void;
  onClearHistory: () => void;
  onRemoveHistory: (url: string) => void;
  id?: string;
};

export const PreviewHistoryPanel: React.FC<PreviewHistoryPanelProps> = ({
  history,
  bookmarks,
  activeUrl,
  blank,
  histRef,
  onPickUrl,
  onRemoveBookmark,
  onClearHistory,
  onRemoveHistory,
  id,
}) => {
  const autoId = React.useId();
  const panelId = id || autoId;
  const histCount = history.length;
  const bookCount = bookmarks.length;

  return (
    <div
      id={panelId}
      ref={histRef}
      className={`${styles.histPanel} ${styles.histPanelFloat}`}
      role="dialog"
      aria-modal="true"
      aria-label="书签与历史"
    >
      <div className={styles.histCol}>
        <div className={styles.histTitle}>
          书签{bookCount > 0 ? `（${bookCount}）` : ''}
        </div>
        {bookmarks.length === 0 ? (
          <div className={styles.histEmpty}>暂无书签</div>
        ) : (
          bookmarks.map((b) => {
            const isCurrent = b.url === activeUrl && !blank;
            return (
              <div key={b.url} className={styles.histRow}>
                <Tooltip content={b.url}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.histItem}
                    onClick={() => onPickUrl(b.url)}
                    aria-current={isCurrent ? 'true' : undefined}
                  >
                    {isCurrent
                      ? `当前 · ${b.title || b.url}`
                      : b.title || b.url}
                  </Button>
                </Tooltip>
                <Tooltip content="移除书签">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className={styles.histX}
                    aria-label={`移除书签 ${b.title || b.url}`}
                    onClick={() => onRemoveBookmark(b.url)}
                    icon={<AppIcon name="x" size={12} />}
                  />
                </Tooltip>
              </div>
            );
          })
        )}
      </div>
      <div className={styles.histCol}>
        <div className={styles.histTitleRow}>
          <div className={styles.histTitle}>
            最近访问{histCount > 0 ? `（${histCount}）` : ''}
          </div>
          {history.length > 0 ? (
            <Tooltip content="清空全部历史">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={styles.histClear}
                aria-label="清空全部历史"
                onClick={onClearHistory}
              >
                清空
              </Button>
            </Tooltip>
          ) : null}
        </div>
        {history.length === 0 ? (
          <div className={styles.histEmpty}>暂无历史</div>
        ) : (
          history.slice(0, 14).map((u) => {
            const isCurrent = u === activeUrl && !blank;
            const label = previewDisplayHost(u) || u;
            return (
              <div key={u} className={styles.histRow}>
                <Tooltip content={u}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.histItem}
                    onClick={() => onPickUrl(u)}
                    aria-current={isCurrent ? 'true' : undefined}
                  >
                    {isCurrent ? `当前 · ${label}` : label}
                  </Button>
                </Tooltip>
                <Tooltip content="从历史移除">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className={styles.histX}
                    aria-label={`从历史移除 ${label}`}
                    onClick={() => onRemoveHistory(u)}
                    icon={<AppIcon name="x" size={12} />}
                  />
                </Tooltip>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
