import React, { useState, useId, useCallback } from 'react';
import type { NoteDocumentMeta } from '../../api/noteDocumentContracts';
import { formatRelativeActivity } from '../../api/sessionTime';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import styles from './NoteSidebarDrawer.module.css';
import { AppIcon } from '../ui/icons/index';

export interface NoteSidebarDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  documents: NoteDocumentMeta[];
  activeDocId: string;
  onSelectDoc: (docId: string) => void;
  onCreateDoc: () => void;
  onRenameDoc: (docId: string, newTitle: string) => void;
  onDeleteDoc: (docId: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
}

export const NoteSidebarDrawer: React.FC<NoteSidebarDrawerProps> = ({
  isOpen,
  onClose,
  documents,
  activeDocId,
  onSelectDoc,
  onCreateDoc,
  onRenameDoc,
  onDeleteDoc,
  searchQuery,
  onSearchChange,
}) => {
  const searchInputId = useId();
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const startRename = useCallback((doc: NoteDocumentMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingDocId(doc.id);
    setEditTitle(doc.title);
  }, []);

  const commitRename = useCallback(
    (docId: string) => {
      onRenameDoc(docId, editTitle);
      setEditingDocId(null);
    },
    [editTitle, onRenameDoc]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, docId: string) => {
      if (e.key === 'Enter') {
        commitRename(docId);
      } else if (e.key === 'Escape') {
        setEditingDocId(null);
      }
    },
    [commitRename]
  );

  const formatRelativeTime = (ts: number): string => {
    // 兼容 13 位标准毫秒级与历史 10 位秒级
    const tsMs = ts < 10_000_000_000 ? ts * 1000 : ts;
    return formatRelativeActivity(tsMs) || '刚刚';
  };

  return (
    <aside
      className={`${styles.drawer} ${isOpen ? styles.isOpen : styles.isClosed}`}
      data-testid="note-sidebar-drawer"
      aria-label="笔记管理侧栏"
    >
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <span className={styles.headerTitle}>全部笔记 ({documents.length})</span>
          <div className={styles.actions}>
            <Tooltip content="新建笔记">
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onCreateDoc}
                aria-label="新建笔记"
                data-testid="note-sidebar-create-btn"
              >
                <AppIcon name="plus" size={14} />
              </button>
            </Tooltip>
            <Tooltip content="收起侧栏 (Ctrl+\)">
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onClose}
                aria-label="收起侧栏"
                data-testid="note-sidebar-close-btn"
              >
                <AppIcon name="sidebar-left" size={15} aria-hidden />
              </button>
            </Tooltip>
          </div>
        </div>

        <div className={styles.searchRow} role="search" aria-label="搜索笔记">
          <AppIcon name="search" size={14} className={styles.searchIcon} aria-hidden="true" />
          <input
            id={searchInputId}
            type="search"
            className={styles.searchInput}
            placeholder="搜索笔记标题..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            aria-label="搜索笔记"
          />
        </div>
      </div>

      <div className={styles.list} role="list">
        {documents.length === 0 ? (
          <div className={styles.emptyState}>
            {searchQuery ? '未找到匹配的笔记' : '暂无笔记，点击上方“+”新建'}
          </div>
        ) : (
          documents.map((doc) => {
            const isActive = doc.id === activeDocId;
            const isEditing = doc.id === editingDocId;

            return (
              <div
                key={doc.id}
                role="listitem"
                tabIndex={0}
                className={`${styles.sessionItem} ${styles.item} ${styles.card} ${isActive ? `${styles.active} ${styles.isActive}` : ''}`}
                onClick={() => onSelectDoc(doc.id)}
                onKeyDown={(e) => {
                  if (isEditing) return;
                  if (e.key === 'Enter') {
                    onSelectDoc(doc.id);
                  } else if (e.key === 'F2') {
                    e.preventDefault();
                    setEditingDocId(doc.id);
                    setEditTitle(doc.title);
                  }
                }}
                data-testid={`note-card-${doc.id}`}
              >
                {isEditing ? (
                  <input
                    type="text"
                    className={`${styles.sessionRenameInput} ${styles.renameInput}`}
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => commitRename(doc.id)}
                    onKeyDown={(e) => handleKeyDown(e, doc.id)}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    maxLength={48}
                    aria-label="重命名笔记"
                  />
                ) : (
                  <>
                    <span className={`${styles.sessionTextCol} ${styles.itemTextCol}`}>
                      <Tooltip content={doc.title || '未命名笔记'}>
                        <span className={`${styles.sessionText} ${styles.itemTitle} ${styles.cardTitle}`}>
                          {doc.title || '未命名笔记'}
                        </span>
                      </Tooltip>
                    </span>

                    <span className={`${styles.sessionTrailing} ${styles.itemTrailing}`}>
                      <time className={`${styles.sessionTime} ${styles.itemTime} ${styles.timeTag}`}>
                        {formatRelativeTime(doc.updatedAt)}
                      </time>
                      <div className={`${styles.sessionActions} ${styles.itemActions} ${styles.hoverActions}`}>
                        <Tooltip content="重命名">
                          <button
                            type="button"
                            className={`${styles.sessionActionBtn} ${styles.actionBtn} ${styles.miniBtn}`}
                            onClick={(e) => startRename(doc, e)}
                            aria-label="重命名"
                            tabIndex={-1}
                          >
                            <AppIcon name="edit" size={12} />
                          </button>
                        </Tooltip>
                        <Tooltip content="删除笔记">
                          <button
                            type="button"
                            className={`${styles.sessionActionBtn} ${styles.actionBtn} ${styles.miniBtn}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDeleteId(doc.id);
                            }}
                            aria-label="删除笔记"
                            tabIndex={-1}
                          >
                            <AppIcon name="trash" size={12} />
                          </button>
                        </Tooltip>
                      </div>
                    </span>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* 删除二次确认弹窗（零伪实现，物理真实删除） */}
      {pendingDeleteId && (
        <div className={styles.dialogOverlay} onClick={() => setPendingDeleteId(null)}>
          <div className={styles.dialogBox} onClick={(e) => e.stopPropagation()}>
            <div className={styles.dialogTitle}>确认删除笔记？</div>
            <div className={styles.dialogDesc}>
              删除后该篇文档及全部数据将彻底从数据库中移除，此操作不可撤销。
            </div>
            <div className={styles.dialogFooter}>
              <button
                type="button"
                className={styles.cancelBtn}
                onClick={() => setPendingDeleteId(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={styles.dangerBtn}
                onClick={() => {
                  onDeleteDoc(pendingDeleteId);
                  setPendingDeleteId(null);
                }}
                data-testid="confirm-delete-btn"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default NoteSidebarDrawer;
