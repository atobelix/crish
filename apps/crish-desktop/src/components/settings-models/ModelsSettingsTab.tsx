/**
 * 设置 · 模型：选择服务商、配置密钥，并管理可用模型。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import { activateProfileModel } from '../../api/providerProfiles';
import styles from './ModelsSettingsTab.module.css';
import { Menu } from '../ui/Menu';
import type { SelectOptionItem } from '../ui/Menu/types';
import { SettingsCard, SettingsPage, SettingsRow, SettingsSection } from '../settings/SettingsUI';
import {
  emptyAddDraft,
  PRESETS,
  useModelProfilesState,
  type PresetProvider,
} from './useModelProfilesState';
import { ModelProfileList, ModelsCascadeSelect } from './ModelProfileList';
import { ModelConfigEditor } from './ModelConfigEditor';

type Props = {
  onShowToast?: (msg: string) => void;
};

/**
 * 「添加服务商」下拉（T05.3.2 由全局 sort-filter-menu 类迁移到 ui/Menu 基座）：
 * - 删除 sort-filter-menu/sort-filter-option/settings-select-trigger 全局类依赖，
 *   样式下沉为本组件 module 类；
 * - 坐标/Esc/外点关闭由基座接管；选择后由 useModelProfilesState 的
 *   addFromTemplate/addFromPreset 关闭（内部 setAddOpen(false)）。
 */
export const AddProviderMenu: React.FC<{
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
  onAddTemplate: (format: 'openai' | 'anthropic') => void;
  onAddPreset: (preset: PresetProvider) => void;
}> = ({ addOpen, setAddOpen, onAddTemplate, onAddPreset }) => {
  // 键盘漫游用选项数组（children 渲染顺序与其一致）
  const menuOptions: SelectOptionItem[] = [
    { id: 'openai', label: 'OpenAI 格式', onClick: () => onAddTemplate('openai') },
    { id: 'anthropic', label: 'Anthropic 格式', onClick: () => onAddTemplate('anthropic') },
    ...PRESETS.map((pr) => ({
      id: pr.id,
      label: pr.name,
      onClick: () => onAddPreset(pr),
    })),
  ];

  return (
    <Menu
      open={addOpen}
      onOpenChange={setAddOpen}
      align="end"
      side="bottom"
      sideOffset={6}
      options={menuOptions}
      contentClassName={styles.addProviderMenu}
      trigger={
        <button
          type="button"
          className={styles.addServiceBtn}
          aria-label="添加服务商"
        >
          <Lucide.Plus size={13} style={{ opacity: 0.75 }} aria-hidden />
          <span>添加服务商</span>
        </button>
      }
    >
      <div role="menu" aria-label="添加服务商">
        <div className={styles.addMenuTitle}>接口类型</div>
        <button
          type="button"
          role="menuitem"
          className={styles.addMenuOption}
          onClick={() => onAddTemplate('openai')}
        >
          OpenAI 格式
        </button>
        <button
          type="button"
          role="menuitem"
          className={styles.addMenuOption}
          onClick={() => onAddTemplate('anthropic')}
        >
          Anthropic 格式
        </button>

        <div className={`${styles.addMenuTitle} ${styles.addMenuTitleGap}`}>常用服务</div>
        {PRESETS.map((pr) => (
          <button
            key={pr.id}
            type="button"
            role="menuitem"
            className={styles.addMenuOption}
            onClick={() => onAddPreset(pr)}
          >
            {pr.name}
          </button>
        ))}
      </div>
    </Menu>
  );
};

export const ModelsSettingsTab: React.FC<Props> = ({ onShowToast }) => {
  const {
    profiles,
    setProfiles,
    selectedId,
    setSelectedId,
    selected,
    keyDraft,
    setKeyDraft,
    addOpen,
    setAddOpen,
    testBusy,
    scanBusy,
    checkBusy,
    modelFilter,
    setModelFilter,
    configOpenId,
    manualOpen,
    setManualOpen,
    addDraft,
    setAddDraft,
    cfgDraft,
    setCfgDraft,
    editingName,
    setEditingName,
    nameDraft,
    setNameDraft,
    confirmDeleteId,
    setConfirmDeleteId,
    refresh,
    notify,
    saveKey,
    addFromTemplate,
    addFromPreset,
    handleManualAdd,
    openConfigFor,
    closeConfig,
    saveConfig,
    runTest,
    runScan,
    runCheck,
    modelsList,
    modelsCount,
    selectedLabel,
    hasKeySelected,
    activeProfileId,
    globalActiveModelId,
    addRef,
  } = useModelProfilesState(onShowToast);

  const headerMeta = (
    <div ref={addRef} style={{ position: 'relative', display: 'inline-block' }}>
      <AddProviderMenu
        addOpen={addOpen}
        setAddOpen={setAddOpen}
        onAddTemplate={addFromTemplate}
        onAddPreset={addFromPreset}
      />
    </div>
  );

  return (
    <SettingsPage title="模型" meta={headerMeta}>
      {/* Default model */}
      <SettingsSection title="默认模型">
        <SettingsCard>
          <SettingsRow
            title="全局默认模型"
            desc="新建对话时使用此模型"
            control={
              <ModelsCascadeSelect
                profiles={profiles}
                activeProfileId={activeProfileId || ''}
                activeModelId={globalActiveModelId || ''}
                onChange={(pId, mId) => {
                  activateProfileModel(pId, mId);
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      {/* Provider split layout */}
      <div className={`${styles.modelsSplit} models-split`}>
        <ModelProfileList
          profiles={profiles}
          selectedId={selectedId}
          onSelectProfile={setSelectedId}
        />

        <ModelConfigEditor
          selected={selected}
          profiles={profiles}
          selectedLabel={selectedLabel}
          hasKeySelected={hasKeySelected}
          editingName={editingName}
          nameDraft={nameDraft}
          setNameDraft={setNameDraft}
          setEditingName={setEditingName}
          confirmDeleteId={confirmDeleteId}
          setConfirmDeleteId={setConfirmDeleteId}
          keyDraft={keyDraft}
          setKeyDraft={setKeyDraft}
          saveKey={saveKey}
          runCheck={runCheck}
          runScan={runScan}
          checkBusy={checkBusy}
          scanBusy={scanBusy}
          modelFilter={modelFilter}
          setModelFilter={setModelFilter}
          manualOpen={manualOpen}
          setManualOpen={setManualOpen}
          addDraft={addDraft}
          setAddDraft={setAddDraft}
          handleManualAdd={handleManualAdd}
          emptyAddDraft={emptyAddDraft}
          modelsList={modelsList}
          modelsCount={modelsCount}
          configOpenId={configOpenId}
          cfgDraft={cfgDraft}
          setCfgDraft={setCfgDraft}
          openConfigFor={openConfigFor}
          closeConfig={closeConfig}
          saveConfig={saveConfig}
          runTest={runTest}
          testBusy={testBusy}
          refresh={refresh}
          notify={notify}
          setProfiles={setProfiles}
          setSelectedId={setSelectedId}
        />
      </div>
    </SettingsPage>
  );
};
