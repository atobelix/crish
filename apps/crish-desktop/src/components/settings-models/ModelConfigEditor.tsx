import React from 'react';
import type { ProviderProfile } from '../../api/providerProfiles';
import styles from './ModelsSettingsTab.module.css';
import { ModelList } from './ModelList';
import { ModelListHeader } from './ModelListHeader';
import { ManualAddForm } from './ManualAddForm';
import { ProfileHeader } from './ProfileHeader';
import { ProviderProfileForm } from './ProviderProfileForm';
import type { AddDraft, CfgDraft } from './useModelProfilesState';

/** 服务商配置域：profile 选择/名称编辑/密钥/删除 */
export interface ProviderConfigGroup {
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
  refresh: () => void;
  notify: (ok: boolean, text: string) => void;
  setProfiles: (profiles: ProviderProfile[]) => void;
  setSelectedId: (id: string | null) => void;
}

/** 模型列表域：扫描/过滤/手填新增 */
export interface ModelConfigGroup {
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
}

/** 单模型配置抽屉域：config 编辑/测试 */
export interface CapConfigGroup {
  configOpenId: string | null;
  cfgDraft: CfgDraft | null;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  openConfigFor: (model: string) => void;
  closeConfig: () => void;
  saveConfig: () => void;
  runTest: (model: string) => Promise<void>;
  testBusy: string | null;
}

interface ModelConfigEditorProps {
  providerConfig: ProviderConfigGroup;
  modelConfig: ModelConfigGroup;
  capConfig: CapConfigGroup;
}

export const ModelConfigEditor: React.FC<ModelConfigEditorProps> = ({
  providerConfig: pc,
  modelConfig: mc,
  capConfig: cc,
}) => {
  return (
    <section
      className={`${styles.modelsDetail} models-detail`}
      aria-label={pc.selected ? `服务商 · ${pc.selectedLabel}` : '服务商'}
    >
      {!pc.selected ? (
        <div className={`${styles.mrdEmpty} mrd-empty`}>
          {pc.profiles.length === 0
            ? '从左侧添加服务商以开始'
            : '在左侧选择一个服务商'}
        </div>
      ) : (
        <div className={`${styles.mrdBody} mrd-body`}>
          {/* Detail header */}
          <ProfileHeader
            selected={pc.selected}
            selectedLabel={pc.selectedLabel}
            editingName={pc.editingName}
            nameDraft={pc.nameDraft}
            setNameDraft={pc.setNameDraft}
            setEditingName={pc.setEditingName}
            confirmDeleteId={pc.confirmDeleteId}
            setConfirmDeleteId={pc.setConfirmDeleteId}
            refresh={pc.refresh}
            notify={pc.notify}
            setProfiles={pc.setProfiles}
            setSelectedId={pc.setSelectedId}
          />

          {/* Credentials */}
          {pc.selected.id.startsWith('custom-') && (
            <ProviderProfileForm
              selected={pc.selected}
              hasKeySelected={pc.hasKeySelected}
              keyDraft={pc.keyDraft}
              setKeyDraft={pc.setKeyDraft}
              saveKey={pc.saveKey}
              notify={pc.notify}
              refresh={pc.refresh}
            />
          )}

          {/* Model list header */}
          <ModelListHeader
            checkBusy={mc.checkBusy}
            scanBusy={mc.scanBusy}
            runCheck={mc.runCheck}
            runScan={mc.runScan}
            modelFilter={mc.modelFilter}
            setModelFilter={mc.setModelFilter}
            manualOpen={mc.manualOpen}
            setManualOpen={mc.setManualOpen}
            setAddDraft={mc.setAddDraft}
            emptyAddDraft={mc.emptyAddDraft}
          />

          {/* Manual add form */}
          {mc.manualOpen && (
            <ManualAddForm
              addDraft={mc.addDraft}
              setAddDraft={mc.setAddDraft}
              handleManualAdd={mc.handleManualAdd}
              setManualOpen={mc.setManualOpen}
            />
          )}

          {/* Model rows */}
          <ModelList
            providerId={pc.selected.id}
            modelsList={mc.modelsList}
            modelsCount={mc.modelsCount}
            modelFilter={mc.modelFilter}
            configOpenId={cc.configOpenId}
            cfgDraft={cc.cfgDraft}
            setCfgDraft={cc.setCfgDraft}
            openConfigFor={cc.openConfigFor}
            closeConfig={cc.closeConfig}
            saveConfig={cc.saveConfig}
            runTest={cc.runTest}
            testBusy={cc.testBusy}
            refresh={pc.refresh}
          />
        </div>
      )}
    </section>
  );
};
