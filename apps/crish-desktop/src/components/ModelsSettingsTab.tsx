/**
 * 设置 · 模型：选择服务商、配置密钥，并管理可用模型。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import { activateProfileModel } from '../api/providerProfiles';
import styles from './ModelsSettingsTab.module.css';
import { SettingsCard, SettingsPage, SettingsRow, SettingsSection } from './settings/SettingsUI';
import {
  emptyAddDraft,
  PRESETS,
  useModelsSettings,
} from './settings-tabs/models/useModelsSettings';
import { ModelProfileList, ModelsCascadeSelect } from './settings-tabs/models/ModelList';
import { ModelConfigEditor } from './settings-tabs/models/ModelFormDialog';

type Props = {
  onShowToast?: (msg: string) => void;
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
  } = useModelsSettings(onShowToast);

  const headerMeta = (
    <div ref={addRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="settings-select-trigger"
        onClick={() => setAddOpen((v) => !v)}
      >
        <Lucide.Plus size={13} style={{ opacity: 0.75 }} />
        <span>添加服务商</span>
      </button>

      {addOpen && (
        <div
          className="sort-filter-menu open"
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 6px)',
            minWidth: '180px',
            zIndex: 'var(--z-settings-dialog)',
          }}
          role="menu"
          aria-label="添加服务商"
        >
          <div className="sort-filter-menu-title">接口类型</div>
          <button
            type="button"
            role="menuitem"
            className="sort-filter-option"
            onClick={() => {
              addFromTemplate('openai');
            }}
          >
            OpenAI 格式
          </button>
          <button
            type="button"
            role="menuitem"
            className="sort-filter-option"
            onClick={() => {
              addFromTemplate('anthropic');
            }}
          >
            Anthropic 格式
          </button>

          <div className="sort-filter-menu-title" style={{ marginTop: '4px' }}>常用服务</div>
          {PRESETS.map((pr) => (
            <button
              key={pr.id}
              type="button"
              role="menuitem"
              className="sort-filter-option"
              onClick={() => {
                addFromPreset(pr);
              }}
            >
              {pr.name}
            </button>
          ))}
        </div>
      )}
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
