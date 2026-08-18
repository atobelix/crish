/**
 * 已导入数据列表区（T4-11 R6 拆分产物 · 自 BrowserImportSection 迁出）。
 * 纯展示壳：列表展开/收起按钮、limit 控制、刷新、书签/历史行渲染。
 * 状态与行为由 useHistoryImport hook 经主体接线传入，DOM 结构与文案零改动
 * （测试 BrowserImportSection.test.tsx「列表展示」断言不依赖本文件内部）。
 */
import React from 'react';
import { RefreshCw } from 'lucide-react';
import styles from './BrowserImportSection.module.css';
import { Button, Input } from '../../ui';
import { formatUnixSecTime } from '../../../api/browserImportLib';
import type { BusyKind } from './import-hooks/browserImportShared';
import type { useHistoryImport } from './import-hooks/useHistoryImport';

export interface ImportedListBlockProps {
  /** 忙碌编排（列表加载中禁用按钮）。 */
  busy: BusyKind;
  /** useId 前缀（limit 输入框 id 拼接）。 */
  baseId: string;
  /** useHistoryImport 返回值（列表域状态与行为）。 */
  list: Pick<
    ReturnType<typeof useHistoryImport>,
    | 'listTab'
    | 'historyLimit'
    | 'setHistoryLimit'
    | 'bookmarkRows'
    | 'historyRows'
    | 'listError'
    | 'toggleList'
    | 'refreshList'
  >;
}

export const ImportedListBlock: React.FC<ImportedListBlockProps> = ({
  busy,
  baseId,
  list,
}) => {
  return (
    <div className={styles.block}>
      <h4 className={styles.blockTitle}>已导入数据</h4>
      <div className={styles.row}>
        <Button
          type="button"
          variant={list.listTab === 'bookmarks' ? 'primary' : 'secondary'}
          size="sm"
          disabled={busy === 'list'}
          onClick={() => {
            void list.toggleList('bookmarks');
          }}
        >
          书签列表{list.listTab === 'bookmarks' ? '（收起）' : ''}
        </Button>
        <Button
          type="button"
          variant={list.listTab === 'history' ? 'primary' : 'secondary'}
          size="sm"
          disabled={busy === 'list'}
          onClick={() => {
            void list.toggleList('history');
          }}
        >
          历史列表{list.listTab === 'history' ? '（收起）' : ''}
        </Button>
        {list.listTab ? (
          <>
            {list.listTab === 'history' ? (
              <Input
                id={`${baseId}-hist-limit`}
                label="limit"
                size="sm"
                type="number"
                min={1}
                value={list.historyLimit}
                onChange={(e) => list.setHistoryLimit(e.target.value)}
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={13} aria-hidden />}
              disabled={busy === 'list'}
              onClick={() => {
                void list.refreshList();
              }}
            >
              刷新
            </Button>
          </>
        ) : null}
      </div>
      {list.listError ? (
        <p className={styles.error} role="alert">
          {list.listError}
        </p>
      ) : null}
      {list.listTab === 'bookmarks' && list.bookmarkRows !== null ? (
        <div className={styles.listWrap}>
          <p className={styles.listCaption} role="status">
            共 {list.bookmarkRows.length} 条（导入时间倒序）
          </p>
          {list.bookmarkRows.length === 0 ? (
            <p className={styles.listEmpty}>暂无已导入书签</p>
          ) : (
            <ul className={styles.list}>
              {list.bookmarkRows.map((row) => (
                <li
                  key={`${row.url}\u0000${row.name}`}
                  className={styles.listItem}
                >
                  <span className={styles.itemName}>{row.name}</span>
                  <span className={styles.itemPath}>
                    {row.folder_path.length > 0
                      ? row.folder_path.join(' / ')
                      : '（顶层）'}
                  </span>
                  <span className={styles.itemUrl}>
                    <code>{row.url}</code>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {list.listTab === 'history' && list.historyRows !== null ? (
        <div className={styles.listWrap}>
          <p className={styles.listCaption} role="status">
            共 {list.historyRows.length} 条（visited_at 倒序，limit 截断）
          </p>
          {list.historyRows.length === 0 ? (
            <p className={styles.listEmpty}>暂无已导入历史</p>
          ) : (
            <ul className={styles.list}>
              {list.historyRows.map((row) => (
                <li
                  key={`${row.url}\u0000${row.visited_at}`}
                  className={styles.listItem}
                >
                  <span className={styles.itemTime}>
                    {formatUnixSecTime(row.visited_at)}
                  </span>
                  <span className={styles.itemName}>
                    {row.title || '（无标题）'}
                  </span>
                  <span className={styles.itemUrl}>
                    <code>{row.url}</code>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
};
