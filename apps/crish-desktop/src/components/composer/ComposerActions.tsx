import React from 'react';
import { Plus } from 'lucide-react';
import styles from '../ChatComposer.module.css';
import { ComposePlusMenu } from '../ComposePlusMenu';
import { PermissionModeMenu } from '../PermissionModeMenu';
import { Tooltip } from '../settings/SettingsUI';
import type { PermissionMode } from '../../api/permissionModes';

interface ComposerActionsProps {
  showPlusMenu: boolean;
  setShowPlusMenu: (v: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  chatInput: string;
  setChatInput: (v: string) => void;
  loadSkillSlash: () => void | Promise<void>;
  focusComposerTextarea: () => void;
  onCloseSiblingMenus?: () => void;
  permissionMode: PermissionMode;
  onPermissionChange: (m: PermissionMode) => void;
  rightActions?: React.ReactNode;
  plusBtnRef: React.RefObject<HTMLButtonElement | null>;
  plusMenuId: string;
  onFilesSelected: (files: File[]) => void | Promise<void>;
  focusAfterFileSelect?: boolean;
}

export const ComposerActions: React.FC<ComposerActionsProps> = ({
  showPlusMenu,
  setShowPlusMenu,
  fileInputRef,
  chatInput,
  setChatInput,
  loadSkillSlash,
  focusComposerTextarea,
  onCloseSiblingMenus,
  permissionMode,
  onPermissionChange,
  rightActions,
  plusBtnRef,
  plusMenuId,
  onFilesSelected,
}) => (
  <>
    <input
      ref={fileInputRef as React.RefObject<HTMLInputElement>}
      type="file"
      multiple
      accept="image/*,.txt,.md,.json,.ts,.tsx,.js,.jsx,.css,.html,.py,.rs,.go,.java,.c,.cpp,.h,.yml,.yaml,.toml,.xml,.csv,.log,.sh,.ps1"
      aria-hidden
      tabIndex={-1}
      style={{ display: 'none' }}
      onChange={async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (!files.length) return;
        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        const oversized = files.filter((f) => f.size > MAX_FILE_SIZE);
        if (oversized.length > 0) {
          const names = oversized.map((f) => f.name).join('、');
          alert(`以下文件超过 10MB 大小限制：${names}`);
          return;
        }
        await onFilesSelected(files);
        requestAnimationFrame(focusComposerTextarea);
      }}
    />

    <div className={styles.footerActions} data-composer-footer="1">
      <div className={styles.leftActions} style={{ position: 'relative' }}>
        <Tooltip content="添加文件、技能、扩展…">
          <button
            ref={plusBtnRef}
            type="button"
            className={`${styles.plusBtn} ${showPlusMenu ? styles.isOpen : ''}`}
            aria-label="打开添加菜单"
            aria-haspopup="menu"
            aria-expanded={showPlusMenu}
            aria-controls={showPlusMenu ? plusMenuId : undefined}
            onClick={() => {
              if (showPlusMenu) {
                setShowPlusMenu(false);
                requestAnimationFrame(() => plusBtnRef.current?.focus());
              } else {
                setShowPlusMenu(true);
                onCloseSiblingMenus?.();
              }
            }}
          >
            <Plus size={16} aria-hidden />
          </button>
        </Tooltip>
        <ComposePlusMenu
          id={plusMenuId}
          open={showPlusMenu}
          onClose={() => setShowPlusMenu(false)}
          onAddFiles={() => fileInputRef.current?.click()}
          onInsertSkillSlash={() => {
            if (!chatInput.startsWith('/')) {
              setChatInput(chatInput ? `/${chatInput}` : '/');
            }
            void loadSkillSlash();
            requestAnimationFrame(focusComposerTextarea);
          }}
          restoreFocusRef={plusBtnRef}
        />
        <PermissionModeMenu
          mode={permissionMode}
          onChange={(m) => {
            onPermissionChange(m);
            setShowPlusMenu(false);
            onCloseSiblingMenus?.();
          }}
        />
      </div>
      <div className={styles.rightActions}>{rightActions}</div>
    </div>
  </>
);
