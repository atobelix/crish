/**
 * 设置 · 技能：单行密度（发现 / 列表 / 预览 / 启用 / 创建）
 *
 * Toast 策略（与 useToastQueue 产品禁令一致）：
 * - 成功：列表状态 / 预览选中 / 表单收起即反馈，绝不 toast
 * - 扫描、启用、同步、创建、导入、复制、打开路径失败：toast
 * - 引擎未同步：formatEngineDegradeToast（先说问题）
 */
import React, { useId } from 'react';
import * as Lucide from 'lucide-react';
import { SettingsSelect } from './SettingsSelect';
import styles from './SkillsSettingsTab.module.css';
import { SettingsPage } from './settings/SettingsUI';
import { Tooltip } from './Tooltip';
import {
  useSkillsSettings,
} from './settings-tabs/skills/useSkillsSettings';
import { SkillCardList as SkillList } from './settings-tabs/skills/SkillList';
import {
  SkillDetailPreview as SkillDetailPanel,
  SkillEditorModal,
} from './settings-tabs/skills/SkillDetailPanel';
import { SkillsMoreMenu } from './settings-tabs/skills/SkillsMoreMenu';

type Props = {
  onShowToast?: (msg: string) => void;
};

export const SkillsSettingsTab: React.FC<Props> = ({ onShowToast }) => {
  const {
    skills,
    loading,
    loadError,
    selectedId,
    setSelectedId,
    selected,
    filter,
    setFilter,
    scopeFilter,
    extraDir,
    setExtraDir,
    extraDirs,
    fsOk,
    enableCommands,
    setEnableCommands,
    busyId,
    showRaw,
    setShowRaw,
    createMode,
    setCreateMode,
    createName,
    setCreateName,
    createDesc,
    setCreateDesc,
    createBusy,
    syncBusy,
    batchBusy,
    discoverBusy,
    batchConfirm,
    discoverCandidates,
    discoverPick,
    setDiscoverPick,
    moreOpen,
    setMoreOpen,
    extraOpen,
    setExtraOpen,
    activeScopeProjectName,
    scopeSelectOptions,
    filtered,
    grouped,
    previewHtml,
    selectedSlash,
    batchEnableCount,
    batchDisableCount,
    refresh,
    applyDiscoverImport,
    handleScopeFilterChange,
    setActivation,
    runBatchActivation,
    handleSyncAll,
    commitExtraDir,
    handlePickExtra,
    handleRemoveExtra,
    handleCreate,
    handleImportBrowse,
    handleAiCreateSkill,
    copySlashCommand,
    clearFilters,
  } = useSkillsSettings(onShowToast);

  const createBoxId = useId();
  const searchId = useId();
  const moreMenuId = useId();

  return (
    <SettingsPage
      title="技能"
      meta={
        <div className={`${styles.skillsTabActions} skills-tab-actions`} role="toolbar" aria-label="技能操作">
          <Tooltip content="导入本机技能 or AI">
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              onClick={() =>
                setCreateMode((m) => (m === 'none' ? 'paths' : 'none'))
              }
              aria-label={createMode !== 'none' ? '收起新建' : '新建技能'}
              aria-expanded={createMode !== 'none'}
              aria-controls={createBoxId}
            >
              <Lucide.Plus size={14} aria-hidden />
              {createMode !== 'none' ? '收起' : '新建'}
            </button>
          </Tooltip>
          <SkillsMoreMenu
            moreOpen={moreOpen}
            setMoreOpen={setMoreOpen}
            moreMenuId={moreMenuId}
            skills={skills}
            filtered={filtered}
            syncBusy={syncBusy}
            loading={loading}
            discoverBusy={discoverBusy}
            enableCommands={enableCommands}
            setEnableCommands={setEnableCommands}
            batchConfirm={batchConfirm ?? 'none'}
            batchBusy={batchBusy}
            batchEnableCount={batchEnableCount}
            batchDisableCount={batchDisableCount}
            onShowToast={onShowToast}
            handleSyncAll={handleSyncAll}
            refresh={refresh}
            runBatchActivation={runBatchActivation}
          />
        </div>
      }
    >
      {loadError ? (
        <div className={`${styles.skillsFsWarn} skills-fs-warn`} role="alert">
          <Tooltip content={loadError}>
            <span>{loadError}</span>
          </Tooltip>{' '}
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="重试扫描技能"
          >
            重试
          </button>
        </div>
      ) : null}

      <SkillEditorModal
        discoverCandidates={discoverCandidates}
        discoverPick={discoverPick}
        discoverBusy={discoverBusy}
        setDiscoverPick={setDiscoverPick}
        applyDiscoverImport={applyDiscoverImport}
        createMode={createMode}
        setCreateMode={setCreateMode}
        createName={createName}
        setCreateName={setCreateName}
        createDesc={createDesc}
        setCreateDesc={setCreateDesc}
        createBusy={createBusy}
        handleCreate={handleCreate}
        handleImportBrowse={handleImportBrowse}
        handleAiCreateSkill={handleAiCreateSkill}
      />

      <div className={`${styles.skillsToolbar} skills-toolbar ${styles.skillsToolbarFocus} skills-toolbar--focus`} role="group" aria-label="筛选">
        <SettingsSelect
          className={`${styles.skillsScopeSelect} skills-scope-select`}
          value={scopeFilter}
          options={scopeSelectOptions}
          onChange={handleScopeFilterChange}
          disabled={loading}
          placeholder="作用域…"
        />
        <input
          id={searchId}
          className={`settings-field-input settings-field-input--sm ${styles.skillsSearch} skills-search`}
          placeholder="搜索技能…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="搜索技能"
        />
      </div>

      {!fsOk ? (
        <div
          className={`${styles.skillsFsWarn} skills-fs-warn`}
          role="status"
          aria-label="需桌面壳以扫描本机技能目录"
        >
          当前环境无法读取本机技能目录
        </div>
      ) : null}

      <div className={`${styles.skillsSplit} skills-split`}>
        <SkillList
          skills={skills}
          loading={loading}
          filtered={filtered}
          grouped={grouped}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          activeScopeProjectName={activeScopeProjectName}
          extraOpen={extraOpen}
          setExtraOpen={setExtraOpen}
          extraDirs={extraDirs}
          extraDir={extraDir}
          setExtraDir={setExtraDir}
          handleRemoveExtra={handleRemoveExtra}
          commitExtraDir={commitExtraDir}
          handlePickExtra={handlePickExtra}
          clearFilters={clearFilters}
          setCreateMode={setCreateMode}
        />

        <SkillDetailPanel
          selected={selected}
          skillsCount={skills.length}
          activeScopeProjectName={activeScopeProjectName}
          selectedSlash={selectedSlash}
          copySlashCommand={copySlashCommand}
          onShowToast={onShowToast}
          busyId={busyId}
          batchBusy={batchBusy}
          setActivation={setActivation}
          showRaw={showRaw}
          setShowRaw={setShowRaw}
          previewHtml={previewHtml}
        />
      </div>
    </SettingsPage>
  );
};
