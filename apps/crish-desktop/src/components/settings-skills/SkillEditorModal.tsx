/**
 * 技能编辑弹窗（PE-05 T05.2 #4）
 *
 * 发现面板已收敛到 ui/Dialog 基座：原为页内 role=dialog 内联区块（声明
 * aria-modal 却无焦点圈定），现由基座提供模态行为（Esc/遮罩 = 跳过导入，
 * 与「跳过」按钮同一动作）；样式归属纠正为本组件 module，skills-discover-*
 * 全局类不再使用。
 * 新建（paths/manual）两个 create 框为页内内联区块，保持原样。
 */
import React, { useId } from 'react';
import * as Lucide from 'lucide-react';
import type { DesktopSkill } from '../../api/skillsApi';
import { Tooltip } from '../Tooltip';
import { Dialog } from '../ui';
import styles from './SkillEditorModal.module.css';

interface SkillEditorModalProps {
  discoverCandidates: DesktopSkill[] | null;
  discoverPick: Record<string, boolean>;
  discoverBusy: boolean;
  setDiscoverPick: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  applyDiscoverImport: (mode: 'selected' | 'all' | 'skip') => Promise<void>;
  createMode: 'none' | 'paths' | 'manual';
  setCreateMode: React.Dispatch<React.SetStateAction<'none' | 'paths' | 'manual'>>;
  createName: string;
  setCreateName: (name: string) => void;
  createDesc: string;
  setCreateDesc: (desc: string) => void;
  createBusy: boolean;
  handleCreate: () => Promise<void>;
  handleImportBrowse: () => Promise<void>;
  handleAiCreateSkill: () => void;
}

export const SkillEditorModal: React.FC<SkillEditorModalProps> = ({
  discoverCandidates,
  discoverPick,
  discoverBusy,
  setDiscoverPick,
  applyDiscoverImport,
  createMode,
  setCreateMode,
  createName,
  setCreateName,
  createDesc,
  setCreateDesc,
  createBusy,
  handleCreate,
  handleImportBrowse,
  handleAiCreateSkill,
}) => {
  const createBoxId = useId();
  const createNameId = useId();
  const createDescId = useId();

  const showDiscover = discoverCandidates != null && discoverCandidates.length > 0;

  return (
    <>
      <Dialog
        open={showDiscover}
        onClose={() => void applyDiscoverImport('skip')}
        title={`发现新技能 ${discoverCandidates?.length ?? 0}`}
        size="lg"
        overlayClassName={styles.skillsDiscoverOverlay}
        footer={
          <div className={styles.skillsDiscoverActions}>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              disabled={discoverBusy}
              onClick={() => void applyDiscoverImport('skip')}
              aria-label="跳过导入"
            >
              跳过
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              disabled={discoverBusy}
              onClick={() => void applyDiscoverImport('all')}
              aria-label={`全部启用 ${discoverCandidates?.length ?? 0} 个新技能`}
            >
              全启
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={discoverBusy}
              aria-busy={discoverBusy || undefined}
              onClick={() => void applyDiscoverImport('selected')}
              aria-label="启用所选新技能"
            >
              {discoverBusy ? '…' : '启用所选'}
            </button>
          </div>
        }
      >
        <div className={styles.skillsDiscoverList} role="group" aria-label="待导入技能">
          {(discoverCandidates ?? []).map((s) => {
            const checked = discoverPick[s.id] !== false;
            return (
              <label
                key={s.id}
                className={styles.skillsDiscoverItem}
                title={s.description || s.name}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={discoverBusy}
                  onChange={(e) =>
                    setDiscoverPick((p) => ({ ...p, [s.id]: e.target.checked }))
                  }
                  aria-label={`${checked ? '取消选择' : '选择'} ${s.name}`}
                />
                <span className={styles.skillsDiscoverName}>{s.name}</span>
              </label>
            );
          })}
        </div>
      </Dialog>

      {createMode === 'paths' ? (
        <section
          className={`${styles.skillsCreateBox} skills-create-box`}
          id={createBoxId}
          aria-label="新建技能"
        >
          <div className="settings-create-paths">
            <button
              type="button"
              className="settings-create-path"
              onClick={() => void handleImportBrowse()}
            >
              <span className="settings-create-path-title">浏览导入</span>
              <span className="settings-create-path-desc">
                选择本机已有技能目录（如 .codex/skills），导入后直接出现在列表
              </span>
            </button>
            <button
              type="button"
              className="settings-create-path"
              onClick={handleAiCreateSkill}
            >
              <span className="settings-create-path-title">AI 创建</span>
              <span className="settings-create-path-desc">
                打开对话，由 AI 写完整 SKILL.md（推荐，无需手写）
              </span>
            </button>
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => setCreateMode('manual')}
          >
            高级：手填空白技能…
          </button>
        </section>
      ) : null}

      {createMode === 'manual' ? (
        <section
          className={`${styles.skillsCreateBox} skills-create-box`}
          id={createBoxId}
          aria-label="手填项目技能"
        >
          <div className={styles.skillsCreateRow}>
            <Tooltip content="写入 .conex/skills/<name>/SKILL.md">
              <input
                id={createNameId}
                className="settings-field-input settings-field-input--sm"
                placeholder="名称"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                aria-label="技能名称"
                disabled={createBusy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && createName.trim()) {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
            </Tooltip>
            <input
              id={createDescId}
              className="settings-field-input settings-field-input--sm"
              placeholder="描述（可选）"
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              aria-label="技能描述（可选）"
              disabled={createBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && createName.trim()) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
            />
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={!createName.trim() || createBusy}
              aria-busy={createBusy || undefined}
              onClick={() => void handleCreate()}
              aria-label={createBusy ? '创建中' : '创建技能'}
            >
              {createBusy ? '…' : '创建'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={() => setCreateMode('paths')}
            >
              返回
            </button>
          </div>
        </section>
      ) : null}
    </>
  );
};
