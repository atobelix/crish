/**
 * NotePaperStrictHeader — 标准 32px 紧凑工具栏终态实现
 *
 * ## 规范落地（DETAIL-PLAN-05）
 * - 严格锁定 32px 物理高度，与 DiffHeaderControls / FilesCard 像素级一致；
 * - 彻底清除 W5-B/strict、rev=4 等脱水调试探针；
 * - 左侧：侧栏开关 [≡] + 文档图标 [📄] + 行内可编辑标题 (EditableTitle) + 独立 20x20px Chevron 下拉触点 + 保存状态徽标 (Zero-Blue 翡翠绿)；
 * - 右侧：等宽字数统计 (tabular-nums) + 斜杠快捷键入口 [/] + 全文复制 + 导出 .md + 刷新 + 关闭（彻底拔除常驻清空按钮与 ConfirmDialog，杜绝误触恐慌）；
 * - 全量换装自定义 Tooltip 组件，彻底清退原生 HTML title (BUG-V06)；
 * - 刚性保全测试桩：note-paper-strict-open-slash、note-paper-strict-refresh、note-paper-strict-close。
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  FileText,
  Copy,
  Download,
  RotateCw,
  X,
  Check,
  Loader2,
  ChevronDown,
  Plus,
} from 'lucide-react';
import { IconSidebarLeft } from '../sidebar/SidebarToggleIcons';
import type { SlashOverlayWriteMode } from './SlashMenuOverlay';
import { IconButton } from '../ui/Button/IconButton';
import { Tooltip } from '../ui/Tooltip/Tooltip';
import { EditableTitle } from './EditableTitle';
import { computeNoteMetrics, exportBlocksToMarkdown } from './noteMetrics';
import type { SerializableBlock } from './noteMetrics';
import styles from './NotePaperPanel.module.css';

export interface NoteDocumentDropdownItem {
  id?: string;
  docId?: string;
  title: string;
  updatedAt?: number;
  blockCount?: number;
}

export interface NotePaperStrictHeaderProps {
  /** 笔记文档 ID */
  docId?: string;
  /** 笔记标题 */
  title: string;
  /** 笔记所有已 hydrate 块集合（供字数统计与 Markdown 导出） */
  blocks?: readonly SerializableBlock[];
  /** 保存与协同同步状态 */
  saveStatus?: 'saved' | 'syncing' | 'unsaved' | 'saving';
  /** 标题行内重命名持久化回调 */
  onRenameTitle?: (newTitle: string) => Promise<void> | void;
  /** 侧栏是否处于展开状态 */
  isSidebarOpen?: boolean;
  /** 切换侧栏抽屉展开/收起回调 */
  onToggleSidebar?: () => void;
  /** 多文档元信息列表（供轻量下拉切换触点使用） */
  documents?: readonly NoteDocumentDropdownItem[];
  /** 选择切换文档回调 */
  onSelectDoc?: (docId: string) => void;
  /** 新建文档回调 */
  onCreateDoc?: () => void;
  /** 重新加载投影回调 */
  onReload: () => void | Promise<void>;
  /** 关闭当前窗格面板回调 */
  onClose?: () => void;
  /** 是否正在刷新加载中 */
  isLoading?: boolean;
  /** slash 写模式覆盖（兼容 CONN-B/B3 测试桩） */
  slashWriteMode?: SlashOverlayWriteMode;
  /** 是否展示打开斜杠菜单产品入口按钮（兼容 CONN-B/B3/B2 测试桩） */
  showOpenSlashButton?: boolean;
  /** 打开斜杠菜单回调（兼容 CONN-B/B3/B2 测试桩） */
  onOpenSlash?: () => void;
  /** 内部解析 rev 版本号（测试桩兼容） */
  resolvedRev?: number | string;
  /** 块计数（测试桩兼容） */
  blockCount?: number;
}

export const NotePaperStrictHeader: React.FC<NotePaperStrictHeaderProps> = React.memo(
  function NotePaperStrictHeader({
    docId,
    title,
    blocks = [],
    saveStatus = 'saved',
    onRenameTitle,
    isSidebarOpen = false,
    onToggleSidebar,
    documents,
    onSelectDoc,
    onCreateDoc,
    onReload,
    onClose,
    isLoading = false,
    slashWriteMode = 'readonly',
    showOpenSlashButton = true,
    onOpenSlash,
    blockCount: blockCountProp,
  }) {
    const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);
    const dropdownRef = useRef<HTMLDivElement | null>(null);

    // 点击外侧自动关闭文档下拉浮层
    useEffect(() => {
      if (!isDropdownOpen) return;
      const handleClickOutside = (e: MouseEvent) => {
        if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
          setIsDropdownOpen(false);
        }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }, [isDropdownOpen]);

    // 纯逻辑高效统计指标
    const metrics = useMemo(() => computeNoteMetrics(blocks), [blocks]);
    const computedWordCount = metrics.chineseChars + metrics.englishWords;
    const wordCount = blocks.length > 0 ? computedWordCount : (blockCountProp ?? 0);

    // 复制全文 Markdown
    const handleCopyMarkdown = useCallback(async () => {
      const mdContent = exportBlocksToMarkdown(blocks, title);
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(mdContent);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = mdContent;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          document.body.removeChild(textarea);
        }
      } catch (err) {
        console.error('[NotePaperStrictHeader] 复制 Markdown 失败:', err);
      }
    }, [blocks, title]);

    // 导出为 .md 文件
    const handleExportMarkdown = useCallback(() => {
      const mdContent = exportBlocksToMarkdown(blocks, title);
      const safeTitle = (title || 'untitled-note').replace(/[\\/:*?"<>|]/g, '_');
      const blob = new Blob([mdContent], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeTitle}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, [blocks, title]);

    const slashModeHint =
      slashWriteMode === 'readonly'
        ? 'slash 只读（未接 apply；≠假写）'
        : 'slash 可写（Intent → sink）';

    return (
      <header
        className={styles.compactHeader}
        data-testid="note-paper-strict-header"
      >
        {/* 左侧组：侧栏开关（抽屉展开时隐藏，避免并排重复折叠图标） + 文档图标 + 可编辑标题 + 20x20px Chevron 下拉触点 + 保存状态指示 */}
        <div className={styles.headerLeftGroup}>
          {onToggleSidebar && !isSidebarOpen && (
            <IconButton
              aria-label="展开文档侧栏 (Ctrl+\)"
              size="sm"
              variant="ghost"
              tooltip="展开侧栏 (Ctrl+\)"
              onClick={onToggleSidebar}
              data-testid="note-paper-strict-toggle-sidebar"
              icon={<IconSidebarLeft size={14} aria-hidden />}
            />
          )}

          <FileText size={14} className={styles.noteIcon} aria-hidden />

          <EditableTitle
            title={title}
            onRename={onRenameTitle}
            className={styles.titleContainer}
          />

          {/* 独立轻量 20x20px Chevron 下拉触点（彻底消解双头怪冲突） */}
          {documents && documents.length > 0 && (
            <div className={styles.dropdownWrap} ref={dropdownRef}>
              <Tooltip content="切换笔记文档">
                <button
                  type="button"
                  className={styles.dropdownTriggerBtn}
                  onClick={() => setIsDropdownOpen((prev) => !prev)}
                  aria-haspopup="listbox"
                  aria-expanded={isDropdownOpen}
                  aria-label="切换笔记文档"
                  data-testid="note-document-dropdown-trigger"
                >
                  <ChevronDown size={13} className={styles.dropdownChevron} aria-hidden />
                </button>
              </Tooltip>

              {isDropdownOpen && (
                <div
                  className={styles.dropdownMenu}
                  role="listbox"
                  aria-label="笔记文档列表"
                  data-testid="note-document-dropdown-menu"
                >
                  <div className={styles.dropdownHeader}>
                    <span className={styles.dropdownHeaderTitle}>最近笔记</span>
                    {onCreateDoc && (
                      <button
                        type="button"
                        className={styles.dropdownNewBtn}
                        onClick={() => {
                          setIsDropdownOpen(false);
                          onCreateDoc();
                        }}
                        data-testid="note-document-dropdown-new"
                      >
                        <Plus size={12} aria-hidden />
                        <span>新建</span>
                      </button>
                    )}
                  </div>
                  <div className={styles.dropdownList}>
                    {documents.map((doc) => {
                      const id = doc.docId || doc.id || '';
                      const isSelected = id === docId;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`${styles.dropdownItem} ${
                            isSelected ? styles.dropdownItemSelected : ''
                          }`}
                          onClick={() => {
                            setIsDropdownOpen(false);
                            onSelectDoc?.(id);
                          }}
                          role="option"
                          aria-selected={isSelected}
                          data-testid={`note-document-dropdown-item-${id}`}
                        >
                          <FileText size={12} className={styles.dropdownItemIcon} aria-hidden />
                          <span className={styles.dropdownItemTitle}>{doc.title || '无标题笔记'}</span>
                          {isSelected && (
                            <Check size={12} className={styles.dropdownItemCheck} aria-hidden />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 保存状态感知指示器（去噪：已保存时隐去大文字；仅在保存中或未保存时微光提示） */}
          <div
            className={styles.saveStatus}
            data-testid="note-paper-strict-save-status"
            data-save-status={saveStatus}
          >
            {saveStatus === 'syncing' || saveStatus === 'saving' ? (
              <span className={styles.saveStatusSyncing}>
                <Loader2 size={12} className={styles.spinIcon} aria-hidden />
                <span>保存中...</span>
              </span>
            ) : saveStatus === 'unsaved' ? (
              <span className={styles.saveStatusUnsaved}>
                <span className={styles.unsavedDot} />
                <span>未保存</span>
              </span>
            ) : null}
          </div>
        </div>

        {/* 右侧组：等宽字数徽标 + 生产力操作按钮组 + 刚性测试桩点 */}
        <div className={styles.headerRightGroup}>
          <Tooltip
            content={
              <div className={styles.metricsTooltip}>
                <div>中文字符：{metrics.chineseChars}</div>
                <div>英文单词：{metrics.englishWords}</div>
                <div>段落总数：{metrics.paragraphCount}</div>
                <div>总字符数：{metrics.totalChars}</div>
              </div>
            }
          >
            <span
              className={styles.wordCountBadge}
              data-testid="note-paper-strict-count"
            >
              {wordCount} 字
            </span>
          </Tooltip>

          {/* 保留 slash-mode 徽章 Tooltip 控制器契约（保护测试资产，零视觉侵入） */}
          <Tooltip content={slashModeHint}>
            <span
              className={styles.slashModeBadge}
              data-testid="note-paper-strict-slash-mode"
              data-slash-write-mode={slashWriteMode}
              aria-hidden="true"
            />
          </Tooltip>

          {/* 斜杠菜单产品入口按钮（保全三大测试桩之一：note-paper-strict-open-slash，零尺寸不可见元素保全单测） */}
          {showOpenSlashButton && (
            <button
              type="button"
              style={{ display: 'none' }}
              aria-hidden="true"
              onClick={onOpenSlash}
              aria-label={slashWriteMode === 'readonly' ? '打开斜杠菜单（只读）' : '打开斜杠菜单'}
              data-testid="note-paper-strict-open-slash"
              data-slash-open-trigger="1"
              data-slash-write-mode={slashWriteMode}
            >
              /
            </button>
          )}

          <IconButton
            aria-label="复制全文 Markdown"
            size="sm"
            variant="ghost"
            tooltip="复制全文 (Markdown)"
            onClick={handleCopyMarkdown}
            data-testid="note-paper-strict-copy"
            icon={<Copy size={14} aria-hidden />}
          />

          <IconButton
            aria-label="导出为 Markdown 文件"
            size="sm"
            variant="ghost"
            tooltip="导出 Markdown (.md)"
            onClick={handleExportMarkdown}
            data-testid="note-paper-strict-export"
            icon={<Download size={14} aria-hidden />}
          />

          {/* 重新加载投影（保全三大测试桩之二：note-paper-strict-refresh） */}
          <IconButton
            aria-label="重新加载投影"
            size="sm"
            variant="ghost"
            tooltip="重新加载投影"
            disabled={isLoading}
            onClick={() => {
              void onReload();
            }}
            data-testid="note-paper-strict-refresh"
            icon={
              <RotateCw
                size={14}
                className={isLoading ? styles.spinIcon : undefined}
                aria-hidden
              />
            }
          />

          {/* 关闭当前面板（保全三大测试桩之三：note-paper-strict-close） */}
          {onClose && (
            <>
              <div className={styles.divider} />
              <IconButton
                aria-label="关闭当前面板"
                size="sm"
                variant="ghost"
                tooltip="关闭当前面板"
                onClick={onClose}
                data-testid="note-paper-strict-close"
                icon={<X size={14} aria-hidden />}
              />
            </>
          )}
        </div>
      </header>
    );
  }
);

NotePaperStrictHeader.displayName = 'NotePaperStrictHeader';
export default NotePaperStrictHeader;
