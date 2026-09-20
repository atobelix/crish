import React from 'react';

import {
  externalSourceLabel,
  type DetectedExternalSession,
} from '../../api/import';
import { Button, Input, Tooltip } from '../ui';
import styles from './ExternalSessionImport.module.css';
import { AppIcon } from '../ui/icons/index';

export function formatUpdatedAt(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '时间未知';
  try {
    return new Date(ms).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '时间未知';
  }
}

export function sessionKey(s: DetectedExternalSession): string {
  return s.id;
}

/** 向导步骤 2/3：会话选择与确认导入（列表 + 全选 + 导入按钮） */
export const ImportListSection: React.FC<{
  detected: DetectedExternalSession[];
  selected: Record<string, boolean>;
  selectedCount: number;
  allSelected: boolean;
  busy: boolean;
  importing: boolean;
  listId: string;
  baseId: string;
  onToggleOne: (id: string) => void;
  onToggleAll: () => void;
  onImport: () => Promise<void>;
}> = ({
  detected,
  selected,
  selectedCount,
  allSelected,
  busy,
  importing,
  listId,
  baseId,
  onToggleOne,
  onToggleAll,
  onImport,
}) => {
  return (
    <>
      <div className={styles.importListToolbar}>
        <span className={styles.importListMeta}>
          {detected.length === 0
            ? '暂无检测结果'
            : `共 ${detected.length} 条 · 已选 ${selectedCount}`}
        </span>
        {detected.length > 0 ? (
          <Tooltip content={allSelected ? '取消全选' : '全选'}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onToggleAll}
            >
              {allSelected ? '取消全选' : '全选'}
            </Button>
          </Tooltip>
        ) : null}
      </div>

      {detected.length === 0 ? (
        <div className={styles.importEmpty} role="status">
          本机未发现可导入会话。确认已安装 Claude Code / Codex，且会话目录可读。
        </div>
      ) : (
        <ul
          className={styles.importList}
          id={listId}
          role="listbox"
          aria-label="检测到的外部会话"
          aria-multiselectable="true"
        >
          {detected.map((s) => {
            const key = sessionKey(s);
            const checked = Boolean(selected[key]);
            const checkId = `${baseId}-chk-${key}`;
            return (
              <li
                key={key}
                className={styles.importItem}
                role="option"
                aria-selected={checked}
              >
                <Input
                  bare
                  id={checkId}
                  type="checkbox"
                  className={styles.importCheck}
                  checked={checked}
                  disabled={busy}
                  onChange={() => onToggleOne(key)}
                  aria-label={`选择 ${s.title}`}
                />
                <label htmlFor={checkId} className={styles.importItemBody}>
                  <span className={styles.importItemTitle}>{s.title}</span>
                  <span className={styles.importItemMeta}>
                    <span className={styles.importItemSource}>
                      {externalSourceLabel(s.source)}
                    </span>
                    {s.project ? <span>项目 {s.project}</span> : null}
                    <span>{formatUpdatedAt(s.updatedAt)}</span>
                    <span>{s.messageCount} 条消息</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <div className={styles.importFooter}>
        <Tooltip
          content={
            selectedCount === 0
              ? '请先勾选要导入的会话'
              : `导入 ${selectedCount} 条所选会话`
          }
        >
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy || selectedCount === 0}
            aria-busy={importing || undefined}
            onClick={() => {
              void onImport();
            }}
            icon={
              importing ? (
                <AppIcon name="loader" size={14} aria-hidden />
              ) : (
                <AppIcon name="download" size={14} aria-hidden />
              )
            }
          >
            {importing ? (
              '导入中…'
            ) : (
              <>
                导入所选
                {selectedCount > 0 ? `（${selectedCount}）` : ''}
              </>
            )}
          </Button>
        </Tooltip>
      </div>
    </>
  );
};
