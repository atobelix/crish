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
import type { DesktopSkill } from '../../api/skillsApi';
import { Button, Dialog, Input, Switch, Tooltip } from '../ui';
import styles from './SkillEditorModal.module.css';

/** 发现导入域（T4-9c Props 收敛） */
export type SkillDiscoverDomain = {
  discoverCandidates: DesktopSkill[] | null;
  discoverPick: Record<string, boolean>;
  discoverBusy: boolean;
  setDiscoverPick: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  applyDiscoverImport: (mode: 'selected' | 'all' | 'skip') => Promise<void>;
};

/** 新建技能域（T4-9c Props 收敛） */
export type SkillCreateDomain = {
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
};

interface SkillEditorModalProps {
  discover: SkillDiscoverDomain;
  create: SkillCreateDomain;
}

export const SkillEditorModal: React.FC<SkillEditorModalProps> = ({
  discover,
  create,
}) => {
  const {
    discoverCandidates,
    discoverPick,
    discoverBusy,
    setDiscoverPick,
    applyDiscoverImport,
  } = discover;
  const {
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
  } = create;
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
        classNames={{ overlay: styles.skillsDiscoverOverlay }}
        footer={
          <div className={styles.skillsDiscoverActions}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={discoverBusy}
              onClick={() => void applyDiscoverImport('skip')}
              aria-label="跳过导入"
            >
              跳过
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={discoverBusy}
              onClick={() => void applyDiscoverImport('all')}
              aria-label={`全部启用 ${discoverCandidates?.length ?? 0} 个新技能`}
            >
              全启
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={discoverBusy}
              aria-busy={discoverBusy || undefined}
              onClick={() => void applyDiscoverImport('selected')}
              aria-label="启用所选新技能"
            >
              {discoverBusy ? '…' : '启用所选'}
            </Button>
          </div>
        }
      >
        <div
          className={`${styles.skillsDiscoverList} ${styles.skillsDiscoverDialogBody}`}
          role="group"
          aria-label="待导入技能"
        >
          {(discoverCandidates ?? []).map((s) => {
            const checked = discoverPick[s.id] !== false;
            return (
              <Tooltip key={s.id} content={s.description || s.name}>
                <div className={styles.skillsDiscoverItem}>
                  <Switch
                    size="sm"
                    checked={checked}
                    disabled={discoverBusy}
                    aria-label={`${checked ? '取消选择' : '选择'} ${s.name}`}
                    onCheckedChange={(next) =>
                      setDiscoverPick((p) => ({ ...p, [s.id]: next }))
                    }
                  />
                  <span className={styles.skillsDiscoverName}>{s.name}</span>
                </div>
              </Tooltip>
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
          <div className={styles.createSeg} role="group" aria-label="新建方式">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.createPath}
              onClick={() => void handleImportBrowse()}
            >
              浏览导入
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.createPath}
              onClick={handleAiCreateSkill}
            >
              AI 创建
            </Button>
            <p className={styles.createHint}>
              浏览本机技能目录导入，或打开对话由 AI 写 SKILL.md
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreateMode('manual')}
          >
            高级：手填空白技能…
          </Button>
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
              <div className={styles.skillsCreateField}>
                <Input
                  id={createNameId}
                  size="sm"
                  placeholder="名称"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  aria-label="技能名称"
                  disabled={createBusy}
                  onEnter={() => {
                    if (createName.trim()) {
                      void handleCreate();
                    }
                  }}
                />
              </div>
            </Tooltip>
            <div className={styles.skillsCreateField}>
              <Input
                id={createDescId}
                size="sm"
                placeholder="描述（可选）"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                aria-label="技能描述（可选）"
                disabled={createBusy}
                onEnter={() => {
                  if (createName.trim()) {
                    void handleCreate();
                  }
                }}
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!createName.trim() || createBusy}
              aria-busy={createBusy || undefined}
              onClick={() => void handleCreate()}
              aria-label={createBusy ? '创建中' : '创建技能'}
            >
              {createBusy ? '…' : '创建'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCreateMode('paths')}
            >
              返回
            </Button>
          </div>
        </section>
      ) : null}
    </>
  );
};
