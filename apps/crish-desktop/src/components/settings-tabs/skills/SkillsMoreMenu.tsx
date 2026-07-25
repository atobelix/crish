/**
 * Header menu component for additional skills actions.
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import { clientApi } from '../../../api/clientApi';
import { getWorkspacePath } from '../../../api/projectStore';
import { useLayoutStore } from '../../../store/layoutStore';
import { Tooltip } from '../../Tooltip';
import styles from '../../SkillsSettingsTab.module.css';
import { errText } from './useSkillsSettings';
import type { SkillItem } from '../../../api/skillsApi';

interface SkillsMoreMenuProps {
  moreOpen: boolean;
  setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>;
  moreMenuId: string;
  skills: SkillItem[];
  filtered: SkillItem[];
  syncBusy: boolean;
  loading: boolean;
  discoverBusy: boolean;
  enableCommands: boolean;
  setEnableCommands: (val: boolean) => void;
  batchConfirm: 'none' | 'enabled' | 'disabled';
  batchBusy: boolean;
  batchEnableCount: number;
  batchDisableCount: number;
  onShowToast?: (msg: string) => void;
  handleSyncAll: () => Promise<void>;
  refresh: (opts?: { promptNew?: boolean }) => Promise<void>;
  runBatchActivation: (act: 'enabled' | 'disabled') => Promise<void>;
}

export const SkillsMoreMenu: React.FC<SkillsMoreMenuProps> = ({
  moreOpen,
  setMoreOpen,
  moreMenuId,
  skills,
  filtered,
  syncBusy,
  loading,
  discoverBusy,
  enableCommands,
  setEnableCommands,
  batchConfirm,
  batchBusy,
  batchEnableCount,
  batchDisableCount,
  onShowToast,
  handleSyncAll,
  refresh,
  runBatchActivation,
}) => {
  return (
    <div className={`${styles.skillsMoreWrap} skills-more-wrap`}>
      <Tooltip content="更多操作">
        <button
          type="button"
          className="ui-btn ui-btn-ghost ui-btn-sm"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-controls={moreMenuId}
          aria-haspopup="menu"
          aria-label="更多操作"
        >
          <Lucide.MoreHorizontal size={16} aria-hidden />
        </button>
      </Tooltip>
      {moreOpen ? (
        <div
          id={moreMenuId}
          className={`${styles.skillsMoreMenu} skills-more-menu`}
          role="menu"
          aria-label="更多技能操作"
        >
          <button
            type="button"
            role="menuitem"
            className={`${styles.skillsMoreItem} skills-more-item`}
            onClick={() => {
              setMoreOpen(false);
              void handleSyncAll();
            }}
            disabled={syncBusy || skills.length === 0}
          >
            {syncBusy ? '同步中…' : '同步到引擎'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.skillsMoreItem} skills-more-item`}
            onClick={() => {
              setMoreOpen(false);
              void refresh({ promptNew: true });
            }}
            disabled={loading || discoverBusy}
          >
            发现新技能
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.skillsMoreItem} skills-more-item`}
            onClick={() => {
              setMoreOpen(false);
              void refresh();
            }}
            disabled={loading}
          >
            刷新列表
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.skillsMoreItem} skills-more-item`}
            onClick={() => {
              const next = !enableCommands;
              const prev = enableCommands;
              setEnableCommands(next);
              setMoreOpen(false);
              void clientApi
                .saveSettingsEx(getWorkspacePath() || '', 'global', {
                  enableSkillCommands: next,
                })
                .then((merged) => {
                  useLayoutStore.getState().setAppSettings(merged);
                })
                .catch((err) => {
                  setEnableCommands(prev);
                  onShowToast?.(`快捷命令保存失败：${errText(err)}`);
                })
                .finally(() => {
                  window.dispatchEvent(new CustomEvent('crish-skills-changed'));
                });
            }}
          >
            {enableCommands ? '关闭快捷命令' : '开启快捷命令'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.skillsMoreItem} skills-more-item ${batchConfirm === 'enabled' ? styles.isActive + ' is-active' : ''}`}
            onClick={() => void runBatchActivation('enabled')}
            disabled={batchBusy || filtered.length === 0}
          >
            {batchConfirm === 'enabled'
              ? `再点确认全启（${batchEnableCount}）`
              : '全部启用'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={`${styles.skillsMoreItem} skills-more-item ${batchConfirm === 'disabled' ? styles.isActive + ' is-active' : ''}`}
            onClick={() => void runBatchActivation('disabled')}
            disabled={batchBusy || filtered.length === 0}
          >
            {batchConfirm === 'disabled'
              ? `再点确认全禁（${batchDisableCount}）`
              : '全部禁用'}
          </button>
        </div>
      ) : null}
    </div>
  );
};
