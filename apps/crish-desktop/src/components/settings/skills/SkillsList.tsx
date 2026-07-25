import React from 'react';
import { FolderOpen, Package, Plus, Sparkles, X } from 'lucide-react';
import { Tooltip } from '../SettingsUI';
import { SettingsSelect } from '../../SettingsSelect';
import styles from '../../SkillsSettingsTab.module.css';
import type { DesktopSkill } from '../../../api/skillsApi';

const ACTIVATION_LABEL: Record<string, string> = { enabled: '启用', recommended: '推荐', disabled: '禁用' };

function scopeGroupLabel(scope: string, projectName: string): string {
  if (scope === 'global') return '全局';
  if (scope === 'workspace') return projectName || '工作区';
  if (scope === 'project') return projectName || '当前项目';
  return scope;
}

interface SkillsListProps {
  skills: DesktopSkill[];
  loading: boolean;
  selectedId: string | null;
  filter: string;
  scopeFilter: string;
  scopeSelectOptions: { value: string; label: string; hint?: string }[];
  extraDir: string;
  extraDirs: string[];
  extraOpen: boolean;
  activeScopeProjectName: string;
  grouped: Array<{ scope: string; items: DesktopSkill[] }>;
  onSelect: (id: string) => void;
  onFilterChange: (filter: string) => void;
  onScopeFilterChange: (scope: string) => void;
  onExtraDirChange: (dir: string) => void;
  onExtraDirCommit: () => void;
  onPickExtra: () => void;
  onRemoveExtra: (dir: string) => void;
  onClearFilters: () => void;
}

export const SkillsList: React.FC<SkillsListProps> = React.memo(({
  skills, loading, selectedId, filter, scopeFilter, scopeSelectOptions,
  extraDir, extraDirs, extraOpen, activeScopeProjectName, grouped,
  onSelect, onFilterChange, onScopeFilterChange, onExtraDirChange,
  onExtraDirCommit, onPickExtra, onRemoveExtra, onClearFilters,
}) => {
  const EMPTY_INSTALL_HINT = '可放在项目 .conex/skills/、~/.codex/skills/、~/.claude/skills/，或下方添加额外目录';

  const renderListEmpty = () => {
    if (loading && skills.length === 0) return (<div className={`${styles.skillsEmptyInline} skills-empty-inline`} role="status" aria-live="polite" aria-busy="true">加载中…</div>);
    if (loading || grouped.reduce((n, g) => n + g.items.length, 0) > 0) return null;
    if (skills.length === 0) return (
      <Tooltip content={EMPTY_INSTALL_HINT}><div className={`${styles.skillsEmptyInline} skills-empty-inline ${styles.skillsEmptyInlineCta} skills-empty-inline--cta`} role="status" aria-live="polite">
        <div>暂无技能</div>
        <Tooltip content="导入本机技能或用 AI 创建">
          <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" aria-label="新建技能"><Plus size={14} aria-hidden /> 新建技能</button>
        </Tooltip>
      </div></Tooltip>
    );
    return (
      <div className={`${styles.skillsEmptyInline} skills-empty-inline`} role="status" aria-live="polite">
        <div>无匹配 · 共 {skills.length} 个技能</div>
        <div className={`${styles.skillsDiscoverActions} skills-discover-actions`} style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClearFilters} aria-label="清除筛选">清除筛选</button>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className={`${styles.skillsToolbar} skills-toolbar ${styles.skillsToolbarFocus} skills-toolbar--focus`} role="group" aria-label="筛选">
        <SettingsSelect className={`${styles.skillsScopeSelect} skills-scope-select`} value={scopeFilter}
          options={scopeSelectOptions} onChange={onScopeFilterChange} disabled={loading} placeholder="作用域…" />
        <input className={`settings-field-input settings-field-input--sm ${styles.skillsSearch} skills-search`}
          placeholder="搜索技能…" value={filter} onChange={(e) => onFilterChange(e.target.value)} aria-label="搜索技能" />
      </div>
      <aside className={`${styles.skillsRail} skills-rail`} aria-label="技能列表">
        <div className={`${styles.skillsRailList} skills-rail-list`} role="listbox" aria-label="技能列表"
          aria-busy={loading || undefined} aria-activedescendant={selectedId ? `skill-opt-${selectedId}` : undefined}>
          {renderListEmpty()}
          {grouped.map((g) => {
            const groupLabel = scopeGroupLabel(g.scope, activeScopeProjectName);
            return (
              <div key={g.scope} className={`${styles.skillsRailGroup} skills-rail-group`} role="group" aria-label={groupLabel}>
                <div className={`${styles.skillsRailGroupLabel} skills-rail-group-label`}>
                  {groupLabel}<span aria-label={`${g.items.length} 个`}>{g.items.length}</span>
                </div>
                {g.items.map((s) => {
                  const actLabel = ACTIVATION_LABEL[s.activation] || s.activation;
                  const isSel = selectedId === s.id;
                  return (
                    <Tooltip key={s.id} content={s.description || s.name}>
                      <button id={`skill-opt-${s.id}`} type="button" role="option" aria-selected={isSel}
                        className={`${styles.skillsRailItem} skills-rail-item ${styles.skillsRailItemDense} skills-rail-item--dense ${isSel ? styles.isActive + ' is-active' : ''} act-${s.activation}`}
                        onClick={() => onSelect(s.id)}
                        aria-label={`${s.name}，${groupLabel}，${actLabel}${s.system ? '，系统' : ''}`}>
                        <span className={`${styles.skillsRailIcon} skills-rail-icon`} aria-hidden>
                          {s.system ? <Package size={12} /> : <Sparkles size={12} />}
                        </span>
                        <span className={`${styles.skillsRailName} skills-rail-name`}>
                          {s.name}{s.system ? <em className={`${styles.skillsSysBadge} skills-sys-badge`}>系统</em> : null}
                        </span>
                        <Tooltip content={actLabel}><span className={`${styles.skillsActDot} skills-act-dot act-${s.activation}`} aria-hidden /></Tooltip>
                      </button>
                    </Tooltip>
                  );
                })}
              </div>
            );
          })}
        </div>
        <details className={`${styles.skillsExtraDetails} skills-extra-details`} open={extraOpen || extraDirs.length > 0}
          onToggle={(e) => { const d = e.target as HTMLDetailsElement; /* open state handled externally */ }}>
          <summary className={`${styles.skillsExtraSummary} skills-extra-summary`}>
            高级 · 额外目录{extraDirs.length > 0 ? `（${extraDirs.length}）` : ''}
          </summary>
          <div className="settings-list" role="list" aria-label="已添加的额外技能目录">
            {extraDirs.map((d) => (
              <div key={d} className="settings-list-row" role="listitem">
                <div className="settings-list-copy"><Tooltip content={d}><div className="settings-list-title settings-path-ellipsis">{d}</div></Tooltip></div>
                <div className="settings-list-control">
                  <Tooltip content="移除此目录">
                    <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label={`移除目录 ${d}`} onClick={() => onRemoveExtra(d)}><X size={14} aria-hidden /></button>
                  </Tooltip>
                </div>
              </div>
            ))}
            <div className="settings-list-row">
              <div className={`${styles.skillsExtraAddRow} skills-extra-add-row`}>
                <Tooltip content="技能目录绝对路径 · 回车添加">
                  <input className="settings-field-input settings-field-input--sm" placeholder="绝对路径" value={extraDir}
                    onChange={(e) => onExtraDirChange(e.target.value)} aria-label="额外技能目录绝对路径"
                    onKeyDown={(e) => { if (e.key === 'Enter' && extraDir.trim()) { e.preventDefault(); onExtraDirCommit(); } }} />
                </Tooltip>
                <Tooltip content="浏览文件夹">
                  <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label="浏览文件夹" onClick={onPickExtra}><FolderOpen size={14} aria-hidden /></button>
                </Tooltip>
                <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={!extraDir.trim()} aria-label="添加额外目录" onClick={onExtraDirCommit}>添加</button>
              </div>
            </div>
          </div>
        </details>
      </aside>
    </>
  );
});
