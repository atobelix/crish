import React, { useState, useId, useCallback } from 'react';
import {
  Plus,
  PanelLeftClose,
  Search,
  Edit2,
  Trash2,
} from 'lucide-react';
import type { NoteDocumentMeta } from '../../api/noteDocumentContracts';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import styles from './NoteSidebarDrawer.module.css';

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
    const diff = Date.now() - tsMs;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
    return `${Math.floor(diff / 86400_000)}天前`;
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
                <Plus size={14} />
              </button>
            </Tooltip>
            <Tooltip content="收起侧栏 (Ctrl+\)">
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onClose}
                aria-label="收起侧栏"
              >
                <PanelLeftClose size={14} />
              </button>
            </Tooltip>
          </div>
        </div>

        <div className={styles.searchRow}>
          <Search size={13} className={styles.searchIcon} />
          <input
            id={searchInputId}
            type="text"
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
                className={`${styles.card} ${isActive ? styles.isActive : ''}`}
                onClick={() => onSelectDoc(doc.id)}
                data-testid={`note-card-${doc.id}`}
              >
                <div className={styles.cardHeader}>
                  {isEditing ? (
                    <input
                      type="text"
                      className={styles.renameInput}
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={() => commitRename(doc.id)}
                      onKeyDown={(e) => handleKeyDown(e, doc.id)}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className={styles.cardTitle} title={doc.title}>
                      {doc.title || '未命名笔记'}
                    </span>
                  )}
                </div>

                <div className={styles.cardMeta}>
                  <span className={styles.timeTag}>{formatRelativeTime(doc.updatedAt)}</span>
                  <span className={styles.blockBadge}>{doc.blockCount} 块</span>

                  <div className={styles.hoverActions}>
                    <Tooltip content="重命名">
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={(e) => startRename(doc, e)}
                        aria-label="重命名"
                      >
                        <Edit2 size={12} />
                      </button>
                    </Tooltip>
                    <Tooltip content="删除笔记">
                      <button
                        type="button"
                        className={styles.miniBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDeleteId(doc.id);
                        }}
                        aria-label="删除笔记"
                      >
                        <Trash2 size={12} />
                      </button>
                    </Tooltip>
                  </div>
                </div>
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
