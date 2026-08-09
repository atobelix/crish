import React from 'react';
import type { ProviderProfile } from '../../api/providerProfiles';
import styles from './ModelsSettingsTab.module.css';
import { ModelList } from './ModelList';
import { ModelListHeader } from './ModelListHeader';
import { ManualAddForm } from './ManualAddForm';
import { ProfileHeader } from './ProfileHeader';
import { ProviderProfileForm } from './ProviderProfileForm';
import type { AddDraft, CfgDraft } from './useModelProfilesState';

interface ModelConfigEditorProps {
  selected: ProviderProfile | null;
  profiles: ProviderProfile[];
  selectedLabel: string;
  hasKeySelected: boolean;
  editingName: boolean;
  nameDraft: string;
  setNameDraft: (val: string) => void;
  setEditingName: (val: boolean) => void;
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
  keyDraft: string;
  setKeyDraft: (val: string) => void;
  saveKey: () => Promise<void>;
  runCheck: () => Promise<void>;
  runScan: () => Promise<void>;
  checkBusy: boolean;
  scanBusy: boolean;
  modelFilter: string;
  setModelFilter: (val: string) => void;
  manualOpen: boolean;
  setManualOpen: (val: boolean) => void;
  addDraft: AddDraft;
  setAddDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  handleManualAdd: () => void;
  emptyAddDraft: () => AddDraft;
  modelsList: string[];
  modelsCount: number;
  configOpenId: string | null;
  cfgDraft: CfgDraft | null;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  openConfigFor: (model: string) => void;
  closeConfig: () => void;
  saveConfig: () => void;
  runTest: (model: string) => Promise<void>;
  testBusy: string | null;
  refresh: () => void;
  notify: (ok: boolean, text: string) => void;
  setProfiles: (profiles: ProviderProfile[]) => void;
  setSelectedId: (id: string | null) => void;
}

export const ModelConfigEditor: React.FC<ModelConfigEditorProps> = ({
  selected,
  profiles,
  selectedLabel,
  hasKeySelected,
  editingName,
  nameDraft,
  setNameDraft,
  setEditingName,
  confirmDeleteId,
  setConfirmDeleteId,
  keyDraft,
  setKeyDraft,
  saveKey,
  runCheck,
  runScan,
  checkBusy,
  scanBusy,
  modelFilter,
  setModelFilter,
  manualOpen,
  setManualOpen,
  addDraft,
  setAddDraft,
  handleManualAdd,
  emptyAddDraft,
  modelsList,
  modelsCount,
  configOpenId,
  cfgDraft,
  setCfgDraft,
  openConfigFor,
  closeConfig,
  saveConfig,
  runTest,
  testBusy,
  refresh,
  notify,
  setProfiles,
  setSelectedId,
}) => {
  return (
    <section
      className={`${styles.modelsDetail} models-detail`}
      aria-label={selected ? `服务商 · ${selectedLabel}` : '服务商'}
    >
      {!selected ? (
        <div className={`${styles.mrdEmpty} mrd-empty`}>
          {profiles.length === 0
            ? '从左侧添加服务商以开始'
            : '在左侧选择一个服务商'}
        </div>
      ) : (
        <div className={`${styles.mrdBody} mrd-body`}>
          {/* Detail header */}
          <ProfileHeader
            selected={selected}
            selectedLabel={selectedLabel}
            editingName={editingName}
            nameDraft={nameDraft}
            setNameDraft={setNameDraft}
            setEditingName={setEditingName}
            confirmDeleteId={confirmDeleteId}
            setConfirmDeleteId={setConfirmDeleteId}
            refresh={refresh}
            notify={notify}
            setProfiles={setProfiles}
            setSelectedId={setSelectedId}
          />

          {/* Credentials */}
          {selected.id.startsWith('custom-') && (
            <ProviderProfileForm
              selected={selected}
              hasKeySelected={hasKeySelected}
              keyDraft={keyDraft}
              setKeyDraft={setKeyDraft}
              saveKey={saveKey}
              notify={notify}
              refresh={refresh}
            />
          )}

          {/* Model list header */}
          <ModelListHeader
            checkBusy={checkBusy}
            scanBusy={scanBusy}
            runCheck={runCheck}
            runScan={runScan}
            modelFilter={modelFilter}
            setModelFilter={setModelFilter}
            manualOpen={manualOpen}
            setManualOpen={setManualOpen}
            setAddDraft={setAddDraft}
            emptyAddDraft={emptyAddDraft}
          />

          {/* Manual add form */}
          {manualOpen && (
            <ManualAddForm
              addDraft={addDraft}
              setAddDraft={setAddDraft}
              handleManualAdd={handleManualAdd}
              setManualOpen={setManualOpen}
            />
          )}

          {/* Model rows */}
          <ModelList
            providerId={selected.id}
            modelsList={modelsList}
            modelsCount={modelsCount}
            modelFilter={modelFilter}
            configOpenId={configOpenId}
            cfgDraft={cfgDraft}
            setCfgDraft={setCfgDraft}
            openConfigFor={openConfigFor}
            closeConfig={closeConfig}
            saveConfig={saveConfig}
            runTest={runTest}
            testBusy={testBusy}
            refresh={refresh}
          />
        </div>
      )}
    </section>
  );
};
