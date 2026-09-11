import { useToast } from '../../services/toast/ToastContext';
/**
 * 技能设置页「更多操作」菜单（T05.3.2 迁移到 ui/Menu 基座）。
 * 坐标/Esc/外点关闭由基座接管；键盘漫游（↑↓/Enter）由基座 options 模式提供，
 * renderItem 保留原有批量确认（is-active）视觉与禁用态。
 * （目录迁移 settings-tabs → settings-skills 随 T05.6.2 一并完成）
 */
import React from 'react';

import { clientApi } from '../../api/clientApi';
import { getWorkspacePath } from '../../api/projectStore';
import { getSettingsState } from '../../store/storeAccess';
import styles from './SkillsSettingsTab.module.css';
import { Button, Menu, Tooltip } from '../ui';
import { errText } from './useSkillsSettingsState';
import type { DesktopSkill } from '../../api/skillsApi';
import { AppIcon } from '../ui/icons/index';

/** 批量启用/禁用域状态（T4-9c Props 收敛：6 字段 → 1 对象） */
export type SkillsBatchState = {
  batchConfirm: 'none' | 'enabled' | 'disabled';
  batchBusy: boolean;
  batchEnableCount: number;
  batchDisableCount: number;
  runBatchActivation: (act: 'enabled' | 'disabled') => Promise<void>;
};

interface SkillsMoreMenuProps {
  moreOpen: boolean;
  setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>;
  moreMenuId: string;
  skills: DesktopSkill[];
  filtered: DesktopSkill[];
  syncBusy: boolean;
  loading: boolean;
  discoverBusy: boolean;
  enableCommands: boolean;
  setEnableCommands: (val: boolean) => void;
  batch: SkillsBatchState;
  handleSyncAll: () => Promise<void>;
  refresh: (opts?: { promptNew?: boolean }) => Promise<void>;
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
  batch,
  handleSyncAll,
  refresh,
}) => {
  const { showToast } = useToast();
  const {
    batchConfirm,
    batchBusy,
    batchEnableCount,
    batchDisableCount,
    runBatchActivation,
  } = batch;
  const options = [
    {
      id: 'sync',
      label: syncBusy ? '同步中…' : '同步到引擎',
      disabled: syncBusy || skills.length === 0,
      onClick: () => {
        setMoreOpen(false);
        void handleSyncAll();
      },
    },
    {
      id: 'discover',
      label: '发现新技能',
      disabled: loading || discoverBusy,
      onClick: () => {
        setMoreOpen(false);
        void refresh({ promptNew: true });
      },
    },
    {
      id: 'refresh',
      label: '刷新列表',
      disabled: loading,
      onClick: () => {
        setMoreOpen(false);
        void refresh();
      },
    },
    {
      id: 'toggle-commands',
      label: enableCommands ? '关闭快捷命令' : '开启快捷命令',
      onClick: () => {
        const next = !enableCommands;
        const prev = enableCommands;
        setEnableCommands(next);
        setMoreOpen(false);
        void clientApi
          .saveSettingsEx(getWorkspacePath() || '', 'global', {
            enableSkillCommands: next,
          })
          .then((merged) => {
            getSettingsState().setAppSettings(merged);
          })
          .catch((err) => {
            setEnableCommands(prev);
            showToast(`快捷命令保存失败：${errText(err)}`);
          })
          .finally(() => {
            window.dispatchEvent(new CustomEvent('crish-skills-changed'));
          });
      },
    },
    {
      id: 'enable-all',
      label:
        batchConfirm === 'enabled'
          ? `再点确认全启（${batchEnableCount}）`
          : '全部启用',
      disabled: batchBusy || filtered.length === 0,
      onClick: () => void runBatchActivation('enabled'),
    },
    {
      id: 'disable-all',
      label:
        batchConfirm === 'disabled'
          ? `再点确认全禁（${batchDisableCount}）`
          : '全部禁用',
      disabled: batchBusy || filtered.length === 0,
      onClick: () => void runBatchActivation('disabled'),
    },
  ];

  return (
    <div className={`${styles.skillsMoreWrap} skills-more-wrap`}>
      <Menu
        openState={{ open: moreOpen, onOpenChange: setMoreOpen }}
        trigger={
          <Tooltip content="更多操作">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={moreOpen}
              aria-controls={moreMenuId}
              aria-haspopup="menu"
              aria-label="更多操作"
              icon={<AppIcon name="more-horizontal" size={16} aria-hidden />}
            />
          </Tooltip>
        }
        options={options}
        panel={{ contentClassName: styles.skillsMoreMenuBase }}
      >
        <div id={moreMenuId} role="menu" aria-label="更多技能操作">
          {options.map((opt) => {
            const isConfirmEnabled = opt.id === 'enable-all' && batchConfirm === 'enabled';
            const isConfirmDisabled = opt.id === 'disable-all' && batchConfirm === 'disabled';
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                className={`${styles.skillsMoreItem} skills-more-item ${
                  isConfirmEnabled || isConfirmDisabled ? styles.isActive + ' is-active' : ''
                }`}
                disabled={opt.disabled}
                onClick={(e) => {
                  e.stopPropagation();
                  opt.onClick?.();
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </Menu>
    </div>
  );
};
