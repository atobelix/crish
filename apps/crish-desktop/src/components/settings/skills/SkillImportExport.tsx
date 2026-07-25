import React, { useMemo } from 'react';
import { MoreHorizontal, Plus, RefreshCw, X } from 'lucide-react';
import { Tooltip } from '../SettingsUI';
import { SettingsSelect } from '../../SettingsSelect';
import { getWorkspacePath, listSettingsScopeProjects, projectFolderLabel } from '../../../api/projectStore';
import styles from '../../SkillsSettingsTab.module.css';
import type { DesktopSkill } from '../../../api/skillsApi';
import type { SkillActivation } from '../../../api/skillsApi';

const ACTIVATION_LABEL: Record<SkillActivation, string> = { enabled: '启用', recommended: '推荐', disabled: '禁用' };

interface SkillImportExportProps {
  skills: DesktopSkill[];
  filtered: DesktopSkill[];
  loading: boolean;
  syncBusy: boolean;
  batchBusy: boolean;
  discoverBusy: boolean;
  moreOpen: boolean;
  batchConfirm: 'enabled' | 'disabled' | null;
  enableCommands: boolean;
  scopeFilter: string;
  createMode: 'none' | 'paths' | 'manual';
  onRefresh: (opts?: { promptNew?: boolean; scope?: string }) => void;
  onSyncAll: () => void;
  onMoreToggle: () => void;
  onBatchActivation: (activation: 'enabled' | 'disabled') => void;
  onEnableCommandsChange: (enable: boolean) => void;
  onNewClick: () => void;
}

export const SkillImportExport: React.FC<SkillImportExportProps> = React.memo(({
  skills, filtered, loading, syncBusy, batchBusy, discoverBusy,
  moreOpen, batchConfirm, enableCommands, scopeFilter, createMode,
  onRefresh, onSyncAll, onMoreToggle, onBatchActivation, onEnableCommandsChange, onNewClick,
}) => {
  const batchEnableCount = useMemo(() => filtered.filter((s) => s.activation !== 'enabled').length, [filtered]);
  const batchDisableCount = useMemo(() => filtered.filter((s) => s.activation !== 'disabled').length, [filtered]);

  return (
    <div className={`${styles.skillsTabActions} skills-tab-actions`} role="toolbar" aria-label="技能操作">
      <Tooltip content="导入本机技能 or AI">
        <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm"
          onClick={onNewClick}
          aria-label={createMode !== 'none' ? '收起新建' : '新建技能'}
          aria-expanded={createMode !== 'none'}>
          <Plus size={14} aria-hidden />{createMode !== 'none' ? '收起' : '新建'}
        </button>
      </Tooltip>
      <div className={`${styles.skillsMoreWrap} skills-more-wrap`}>
        <Tooltip content="更多操作">
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onMoreToggle}
            aria-expanded={moreOpen} aria-haspopup="menu" aria-label="更多操作">
            <MoreHorizontal size={16} aria-hidden />
          </button>
        </Tooltip>
        {moreOpen ? (
          <div className={`${styles.skillsMoreMenu} skills-more-menu`} role="menu" aria-label="更多技能操作">
            <button type="button" role="menuitem" className={`${styles.skillsMoreItem} skills-more-item`}
              onClick={() => { onSyncAll(); }} disabled={syncBusy || skills.length === 0}>
              {syncBusy ? '同步中…' : '同步到引擎'}
            </button>
            <button type="button" role="menuitem" className={`${styles.skillsMoreItem} skills-more-item`}
              onClick={() => onRefresh({ promptNew: true })} disabled={loading || discoverBusy}>
              发现新技能
            </button>
            <button type="button" role="menuitem" className={`${styles.skillsMoreItem} skills-more-item`}
              onClick={() => onRefresh()} disabled={loading}>
              刷新列表
            </button>
            <button type="button" role="menuitem" className={`${styles.skillsMoreItem} skills-more-item`}
              onClick={() => onEnableCommandsChange(!enableCommands)}>
              {enableCommands ? '关闭快捷命令' : '开启快捷命令'}
            </button>
            <button type="button" role="menuitem"
              className={`${styles.skillsMoreItem} skills-more-item ${batchConfirm === 'enabled' ? styles.isActive + ' is-active' : ''}`}
              onClick={() => onBatchActivation('enabled')} disabled={batchBusy || filtered.length === 0}>
              {batchConfirm === 'enabled' ? `再点确认全启（${batchEnableCount}）` : '全部启用'}
            </button>
            <button type="button" role="menuitem"
              className={`${styles.skillsMoreItem} skills-more-item ${batchConfirm === 'disabled' ? styles.isActive + ' is-active' : ''}`}
              onClick={() => onBatchActivation('disabled')} disabled={batchBusy || filtered.length === 0}>
              {batchConfirm === 'disabled' ? `再点确认全禁（${batchDisableCount}）` : '全部禁用'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
