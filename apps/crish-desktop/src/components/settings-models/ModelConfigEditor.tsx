import React from 'react';
import type { ProviderProfile } from '../../api/providerProfiles';
import styles from './ModelsSettingsTab.module.css';
import { ModelList } from './ModelList';
import { ModelListHeader } from './ModelListHeader';
import { ManualAddForm } from './ManualAddForm';
import { ProfileHeader } from './ProfileHeader';
import { ProviderProfileForm } from './ProviderProfileForm';
import { ScanResultsModal } from './ScanResultsModal';
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
  runAsLocalMutation: <T>(fn: () => Promise<T> | T) => Promise<T>;
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
  scanModalOpen: boolean;
  setScanModalOpen: (val: boolean) => void;
  scannedModelsList: string[];
  confirmScannedModels: (models: string[]) => void;
}

/** 单模型配置抽屉域：config 编辑/测试 */
export interface CapConfigGroup {
  configOpenId: string | null;
  cfgDraft: CfgDraft | null;
  setCfgDraft: React.Dispatch<React.SetStateAction<CfgDraft | null>>;
  openConfigFor: (model: string) => void;
  closeConfig: () => void;
  saveConfig: () => void | Promise<void>;
  runTest: (model: string) => Promise<void>;
  testBusy: string | null;
  notify: (ok: boolean, text: string) => void;
  runAsLocalMutation: <T>(fn: () => Promise<T> | T) => Promise<T>;
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
      style={{
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      {!pc.selected ? (
        <div className={`${styles.mrdEmpty} mrd-empty`}>
          {pc.profiles.length === 0
            ? '从左侧添加服务商以开始'
            : '在左侧选择一个服务商'}
        </div>
      ) : (
        <div
          className={`${styles.mrdBody} mrd-body`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 0',
            minHeight: 0,
            height: '100%',
            gap: 'var(--space-3, 12px)',
          }}
        >
          {/* ─────────────────────────────────────────────────────────────
           * 段一：置顶固定头部（服务商名称、编辑、删除与 API Key 凭证）
           * 注入弹性上限 min(45%, 240px) 与局部滚动，防极小视口物理截断按钮 (DEF-GEO-01)
           * ───────────────────────────────────────────────────────────── */}
          <div
            className={`${styles.mrdPinnedHeader || ''} mrd-pinned-header`}
            style={{
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3, 12px)',
            }}
          >
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
            <ProviderProfileForm
              selected={pc.selected}
              hasKeySelected={pc.hasKeySelected}
              keyDraft={pc.keyDraft}
              setKeyDraft={pc.setKeyDraft}
              saveKey={pc.saveKey}
              notify={pc.notify}
              refresh={pc.refresh}
              runAsLocalMutation={pc.runAsLocalMutation}
            />
          </div>

          {/* ─────────────────────────────────────────────────────────────
           * 段二：置顶固定操作栏（搜索框常驻、检测/扫描按钮及手填新增抽屉）
           * 无论模型列表如何滚动，搜索工具栏永远吸顶可见，无需滑回顶部
           * ───────────────────────────────────────────────────────────── */}
          <div
            className={`${styles.mrdActionBar || ''} mrd-action-bar`}
            style={{
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2_5, 10px)',
            }}
          >
            {/* Model list header (包含搜索过滤、扫描与新增按钮) */}
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

            {/* Manual add form (手动添加抽屉，展开时弹性自适应) */}
            {mc.manualOpen && (
              <ManualAddForm
                addDraft={mc.addDraft}
                setAddDraft={mc.setAddDraft}
                handleManualAdd={mc.handleManualAdd}
                setManualOpen={mc.setManualOpen}
                runScan={mc.runScan}
                scanBusy={mc.scanBusy}
                providerVendor={pc.selected?.id.startsWith('custom-') ? undefined : pc.selected?.id}
                scannedModels={mc.scannedModelsList}
                existingModels={mc.modelsList}
              />
            )}
          </div>

          {/* ─────────────────────────────────────────────────────────────
           * 段三：局部独立模型滚动视口（专属独立滚动条）
           * 1. 吸收右侧全部剩余纵向空间 (flex: 1 1 0; min-height: 0)
           * 2. overscroll-behavior: contain 硬件层吸收滚轮动量，杜绝链式穿透
           * 3. models tab 下 SettingsPanel.handleRootWheel 已 early return，
           *    此处无需再 stopPropagation（原 onWheel 冗余，已移除）
           * ───────────────────────────────────────────────────────────── */}
          <div
            className={`${styles.mrdModelListScroll || ''} mrd-model-list-scroll`}
            style={{
              flex: '1 1 0',
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              overscrollBehavior: 'contain',
              scrollbarGutter: 'stable',
              paddingRight: '2px',
            }}
          >
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
              notify={cc.notify}
              runAsLocalMutation={cc.runAsLocalMutation}
            />
          </div>

          {/* 探测模型结果多选同步弹窗 */}
          <ScanResultsModal
            open={mc.scanModalOpen}
            onClose={() => mc.setScanModalOpen(false)}
            providerName={pc.selectedLabel}
            scannedModels={mc.scannedModelsList}
            existingModels={mc.modelsList}
            onConfirm={mc.confirmScannedModels}
          />
        </div>
      )}
    </section>
  );
};
