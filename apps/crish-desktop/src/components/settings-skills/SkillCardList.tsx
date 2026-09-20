import React, { useId } from 'react';

import type { DesktopSkill } from '../../api/skillsApi';
import { Button, Input, Tooltip } from '../ui';
import styles from './SkillsSettingsTab.module.css';
import {
  ACTIVATION_LABEL,
  EMPTY_FILTER_HINT,
  EMPTY_INSTALL_HINT,
  scopeGroupLabel,
} from './useSkillsSettingsState';
import { AppIcon } from '../ui/icons/index';

interface SkillCardListProps {
  skills: DesktopSkill[];
  loading: boolean;
  filtered: DesktopSkill[];
  grouped: Array<{ scope: 'project' | 'workspace' | 'global'; items: DesktopSkill[] }>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  activeScopeProjectName: string;
  extraOpen: boolean;
  setExtraOpen: React.Dispatch<React.SetStateAction<boolean>>;
  extraDirs: string[];
  extraDir: string;
  setExtraDir: (dir: string) => void;
  handleRemoveExtra: (d: string) => void;
  commitExtraDir: (raw: string) => void;
  handlePickExtra: () => Promise<void>;
  clearFilters: () => void;
  setCreateMode: React.Dispatch<React.SetStateAction<'none' | 'paths' | 'manual'>>;
  syncBusy?: boolean | undefined;
  discoverBusy?: boolean | undefined;
  enableCommands?: boolean | undefined;
  setEnableCommands?: ((v: boolean) => void) | undefined;
  batchConfirm?: 'none' | 'enabled' | 'disabled' | null | undefined;
  batchBusy?: boolean | undefined;
  batchEnableCount?: number | undefined;
  batchDisableCount?: number | undefined;
  handleSyncAll?: (() => void) | undefined;
  refresh?: (() => void) | undefined;
  runBatchActivation?: ((confirm: 'enabled' | 'disabled') => Promise<void>) | undefined;
}

export const SkillCardList: React.FC<SkillCardListProps> = ({
  skills,
  loading,
  filtered,
  grouped,
  selectedId,
  setSelectedId,
  activeScopeProjectName,
  extraOpen,
  setExtraOpen,
  extraDirs,
  extraDir,
  setExtraDir,
  handleRemoveExtra,
  commitExtraDir,
  handlePickExtra,
  clearFilters,
  setCreateMode,
}) => {
  const listLabelId = useId();
  const extraDirId = useId();

  const renderListEmpty = () => {
    if (loading && skills.length === 0) {
      return (
        <div
          className={`${styles.skillsEmptyInline} skills-empty-inline`}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          加载中…
        </div>
      );
    }
    if (loading || filtered.length > 0) return null;

    if (skills.length === 0) {
      return (
        <div
          className={`${styles.skillsEmptyInline} skills-empty-inline ${styles.skillsEmptyInlineCta} skills-empty-inline--cta`}
          role="status"
          aria-live="polite"
        >
          <div>暂无技能</div>
          <Tooltip content="导入本机技能或用 AI 创建">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setCreateMode('paths')}
              aria-label="新建技能"
              icon={<AppIcon name="plus" size={14} aria-hidden />}
            >
              新建技能
            </Button>
          </Tooltip>
        </div>
      );
    }

    return (
      <div
        className={`${styles.skillsEmptyInline} skills-empty-inline`}
        role="status"
        aria-live="polite"
      >
        <div>无匹配 · 共 {skills.length} 个技能</div>
        <div className={`${styles.skillsDiscoverActions} skills-discover-actions`}>
          <Tooltip content={EMPTY_FILTER_HINT}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              aria-label="清除筛选"
            >
              清除筛选
            </Button>
          </Tooltip>
        </div>
      </div>
    );
  };

  return (
    <aside className={`${styles.skillsRail} skills-rail`} aria-labelledby={listLabelId}>
      <div id={listLabelId} className="sr-only">
        技能列表
      </div>
      <div
        className={`${styles.skillsRailList} ${styles.skillsRailNavScroll} skills-rail-list`}
        role="listbox"
        aria-label="技能列表"
        aria-busy={loading || undefined}
        aria-activedescendant={selectedId ? `skill-opt-${selectedId}` : undefined}
      >
        {renderListEmpty()}
        {grouped.map((g) => {
          const groupLabel = scopeGroupLabel(g.scope, activeScopeProjectName);
          return (
            <div key={g.scope} className={`${styles.skillsRailGroup} skills-rail-group`} role="group" aria-label={groupLabel}>
              <div className={`${styles.skillsRailGroupLabel} skills-rail-group-label`}>
                {groupLabel}
                <span aria-label={`${g.items.length} 个`}>{g.items.length}</span>
              </div>
              {g.items.map((s) => {
                const actLabel = ACTIVATION_LABEL[s.activation] || s.activation;
                const isSel = selectedId === s.id;
                return (
                  <Tooltip key={s.id} content={s.description || s.name}>
                    <Button
                      bare
                      id={`skill-opt-${s.id}`}
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      className={`${styles.skillsRailItem} skills-rail-item ${styles.skillsRailItemDense} skills-rail-item--dense ${isSel ? styles.isActive + ' is-active' : ''} act-${s.activation}`}
                      onClick={() => setSelectedId(s.id)}
                      aria-label={`${s.name}，${groupLabel}，${actLabel}${s.system ? '，系统' : ''}`}
                    >
                      <span className={`${styles.skillsRailIcon} skills-rail-icon`} aria-hidden>
                        {s.system ? (
                          <AppIcon name="package" size={12} />
                        ) : (
                          <AppIcon name="sparkles" size={12} />
                        )}
                      </span>
                      <span className={`${styles.skillsRailName} skills-rail-name`}>
                        {s.name}
                        {s.system ? (
                          <em className={`${styles.skillsSysBadge} skills-sys-badge`}>系统</em>
                        ) : null}
                      </span>
                      <span
                        className={`${styles.skillsActDot} skills-act-dot act-${s.activation}`}
                        aria-hidden
                      />
                    </Button>
                  </Tooltip>
                );
              })}
            </div>
          );
        })}
      </div>

      <details
        className={`${styles.skillsExtraDetails} skills-extra-details`}
        open={extraOpen || extraDirs.length > 0}
        onToggle={(e) => setExtraOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className={`${styles.skillsExtraSummary} skills-extra-summary`}>
          高级 · 额外目录
          {extraDirs.length > 0 ? `（${extraDirs.length}）` : ''}
        </summary>
        <div className={styles.skillsExtraList} role="list" aria-label="已添加的额外技能目录">
          {extraDirs.map((d) => (
            <div key={d} className={styles.skillsExtraRow} role="listitem">
              <Tooltip content={d}>
                <span>{d}</span>
              </Tooltip>
              <Tooltip content="移除此目录">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`移除目录 ${d}`}
                  onClick={() => handleRemoveExtra(d)}
                  icon={<AppIcon name="x" size={14} aria-hidden />}
                />
              </Tooltip>
            </div>
          ))}
          <div className={`${styles.skillsExtraAddRow} skills-extra-add-row`}>
              <Tooltip content="技能目录绝对路径 · 回车添加">
                <div className={styles.skillsExtraField}>
                  <Input
                    id={extraDirId}
                    size="sm"
                    placeholder="绝对路径"
                    value={extraDir}
                    onChange={(e) => setExtraDir(e.target.value)}
                    aria-label="额外技能目录绝对路径"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && extraDir.trim()) {
                        e.preventDefault();
                        commitExtraDir(extraDir);
                      }
                    }}
                  />
                </div>
              </Tooltip>
              <Tooltip content="浏览文件夹">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="浏览文件夹"
                  onClick={() => void handlePickExtra()}
                  icon={<AppIcon name="folder-open" size={14} aria-hidden />}
                />
              </Tooltip>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!extraDir.trim()}
                aria-label="添加额外目录"
                onClick={() => commitExtraDir(extraDir)}
              >
                添加
              </Button>
          </div>
        </div>
      </details>
    </aside>
  );
};
