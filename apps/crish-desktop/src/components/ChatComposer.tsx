/**
 * 主对话输入区：slash 菜单、textarea、发送/停止、附件条、+ 菜单 / 权限 / 更多。
 * 从 ChatCard 抽出以降低巨石组件变更风险。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import { ComposePlusMenu } from './ComposePlusMenu';
import { PermissionModeMenu } from './PermissionModeMenu';
import type { PermissionMode } from '../api/permissionModes';
import type { ChatAttachment } from '../hooks/useChatStream';

export type SlashCommandItem = { cmd: string; desc: string };

export type ChatComposerProps = {
  chatInput: string;
  setChatInput: (v: string) => void;
  isComposing: boolean;
  setIsComposing: (v: boolean) => void;
  slashMenuOpen: boolean;
  setSlashMenuOpen: (v: boolean) => void;
  slashSelectedIndex: number;
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  filteredCommands: SlashCommandItem[];
  loadSkillSlash: () => void | Promise<void>;
  onPasteImage: (e: React.ClipboardEvent) => void;
  onSend: () => void;
  onStop: () => void;
  canSend: boolean;
  isProcessing: boolean;
  attachments: ChatAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFilesSelected: (files: File[]) => void | Promise<void>;
  showPlusMenu: boolean;
  setShowPlusMenu: (v: boolean) => void;
  showMoreMenu: boolean;
  setShowMoreMenu: (v: boolean) => void;
  showMsgFilter: boolean;
  setShowMsgFilter: React.Dispatch<React.SetStateAction<boolean>>;
  setLocalMsgFilter: (v: string) => void;
  moreMenuRef: React.RefObject<HTMLDivElement | null>;
  permissionMode: PermissionMode;
  onPermissionChange: (m: PermissionMode) => void;
  onExportMarkdown: () => void;
  canExport: boolean;
  onOpenSchedule: () => void;
  onShowToast: (msg: string) => void;
  /** 关闭其它互斥菜单（模型下拉等） */
  onCloseSiblingMenus?: () => void;
  /** 右侧动作区（模型选择等） */
  rightActions?: React.ReactNode;
};

export const ChatComposer: React.FC<ChatComposerProps> = ({
  chatInput,
  setChatInput,
  isComposing,
  setIsComposing,
  slashMenuOpen,
  setSlashMenuOpen,
  slashSelectedIndex,
  setSlashSelectedIndex,
  filteredCommands,
  loadSkillSlash,
  onPasteImage,
  onSend,
  onStop,
  canSend,
  isProcessing,
  attachments,
  setAttachments,
  fileInputRef,
  onFilesSelected,
  showPlusMenu,
  setShowPlusMenu,
  showMoreMenu,
  setShowMoreMenu,
  showMsgFilter,
  setShowMsgFilter,
  setLocalMsgFilter,
  moreMenuRef,
  permissionMode,
  onPermissionChange,
  onExportMarkdown,
  canExport,
  onOpenSchedule,
  onShowToast: _onShowToast,
  onCloseSiblingMenus,
  rightActions,
}) => {
  return (
    <>
      <div className="input-container" style={{ position: 'relative' }}>
        {slashMenuOpen && filteredCommands.length > 0 && (
          <div
            className="slash-commands-popover"
            style={{
              position: 'absolute',
              bottom: 'calc(100% + 8px)',
              left: 0,
              width: 260,
              background: 'var(--bg-primary)',
              borderRadius: 12,
              boxShadow: 'var(--shadow-lg)',
              padding: 6,
              zIndex: 15,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {filteredCommands.map((c, i) => (
              <div
                key={c.cmd}
                className={`slash-command-item ${i === slashSelectedIndex ? 'active' : ''}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '8px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: i === slashSelectedIndex ? 'var(--accent-light)' : 'transparent',
                  color: i === slashSelectedIndex ? 'var(--accent-color)' : 'var(--text-secondary)',
                }}
                onClick={() => {
                  setSlashMenuOpen(false);
                  if (c.cmd === '/schedule') {
                    setChatInput('');
                    onOpenSchedule();
                    return;
                  }
                  setChatInput(c.cmd + ' ');
                }}
                onMouseEnter={() => setSlashSelectedIndex(i)}
              >
                <span style={{ fontWeight: 600, fontSize: 12, color: 'var(--text-primary)' }}>
                  {c.cmd}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{c.desc}</span>
              </div>
            ))}
          </div>
        )}

        <textarea
          placeholder="输入消息，或键入 / 打开命令…（可粘贴截图）"
          rows={1}
          value={chatInput}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onChange={(e) => {
            const val = (e.target as HTMLTextAreaElement).value;
            setChatInput(val);
            if (val.startsWith('/') && !val.includes(' ')) {
              setSlashMenuOpen(true);
              void loadSkillSlash();
            } else {
              setSlashMenuOpen(false);
            }
          }}
          onPaste={(e) => {
            void onPasteImage(e);
          }}
          onKeyDown={(e) => {
            if (isComposing) return;
            if (slashMenuOpen && filteredCommands.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSlashSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSlashSelectedIndex(
                  (prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length,
                );
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const selectedCmd = filteredCommands[slashSelectedIndex].cmd;
                setSlashMenuOpen(false);
                if (selectedCmd === '/schedule') {
                  setChatInput('');
                  onOpenSchedule();
                  return;
                }
                setChatInput(selectedCmd + ' ');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setSlashMenuOpen(false);
              }
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          style={{ flex: 1 }}
        />

        <div className="chat-input-buttons">
          {isProcessing ? (
            <>
              <button
                type="button"
                className="send-btn queue-btn"
                title="加入队列，当前回复结束后发送"
                onClick={onSend}
                disabled={!canSend}
              >
                排队
              </button>
              <button
                type="button"
                className="send-btn"
                title="停止生成"
                onClick={onStop}
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              >
                <Lucide.Square size={16} fill="currentColor" />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="send-btn"
              title="发送 (Enter)"
              onClick={onSend}
              disabled={!canSend}
            >
              <Lucide.CornerDownLeft size={16} />
            </button>
          )}
        </div>
      </div>

      {attachments.length > 0 && (
        <div className="chat-attach-strip" aria-label="附件">
          {attachments.map((a) => (
            <span
              key={a.name}
              className={`chat-attach-chip ${a.dataUrl ? 'chat-attach-chip--image' : ''}`}
              title={a.name}
            >
              {a.dataUrl ? (
                <img src={a.dataUrl} alt={a.name} className="chat-attach-thumb" />
              ) : (
                <Lucide.Paperclip size={14} className="chat-attach-icon" />
              )}
              <span className="chat-attach-name">{a.name}</span>
              <button
                type="button"
                className="ui-btn ui-btn-ghost chat-attach-remove"
                aria-label={`移除 ${a.name}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => x.name !== a.name))}
              >
                <Lucide.X size={14} />
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        ref={fileInputRef as React.RefObject<HTMLInputElement>}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (!files.length) return;
          await onFilesSelected(files);
        }}
      />

      <div className="footer-actions">
        <div className="left-actions" style={{ position: 'relative' }}>
          <button
            type="button"
            className={`plus-btn ${showPlusMenu ? 'is-open' : ''}`}
            title="添加"
            onClick={() => {
              if (showPlusMenu) {
                setShowPlusMenu(false);
              } else {
                setShowPlusMenu(true);
                onCloseSiblingMenus?.();
                setShowMoreMenu(false);
              }
            }}
          >
            <Lucide.Plus size={16} />
          </button>
          <ComposePlusMenu
            open={showPlusMenu}
            onClose={() => setShowPlusMenu(false)}
            onAddFiles={() => fileInputRef.current?.click()}
          />
          <PermissionModeMenu
            mode={permissionMode}
            onChange={(m) => {
              onPermissionChange(m);
              setShowPlusMenu(false);
              onCloseSiblingMenus?.();
              setShowMoreMenu(false);
            }}
          />
          <div className="chat-more-wrap" ref={moreMenuRef as React.RefObject<HTMLDivElement>}>
            <button
              type="button"
              className={`plus-btn${showMoreMenu ? ' is-open' : ''}${showMsgFilter ? ' is-on' : ''}`}
              title="更多"
              aria-label="更多"
              aria-haspopup="menu"
              aria-expanded={showMoreMenu}
              onClick={() => {
                setShowMoreMenu(!showMoreMenu);
                setShowPlusMenu(false);
                onCloseSiblingMenus?.();
              }}
            >
              <Lucide.MoreHorizontal size={16} />
            </button>
            {showMoreMenu ? (
              <div className="chat-more-menu" role="menu" aria-label="更多操作">
                <button
                  type="button"
                  className="chat-more-item"
                  role="menuitem"
                  aria-pressed={showMsgFilter}
                  onClick={() => {
                    setShowMsgFilter((v) => {
                      const next = !v;
                      if (!next) setLocalMsgFilter('');
                      return next;
                    });
                    setShowMoreMenu(false);
                  }}
                >
                  <Lucide.Search size={15} strokeWidth={1.75} />
                  <span>{showMsgFilter ? '关闭搜索' : '搜索本会话'}</span>
                </button>
                <button
                  type="button"
                  className="chat-more-item"
                  role="menuitem"
                  disabled={!canExport}
                  onClick={() => {
                    onExportMarkdown();
                    setShowMoreMenu(false);
                  }}
                >
                  <Lucide.FileDown size={15} strokeWidth={1.75} />
                  <span>导出 Markdown</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="right-actions">{rightActions}</div>
      </div>
    </>
  );
};
