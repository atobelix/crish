import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 模型：选择服务商、配置密钥，并管理可用模型。
 *
 * Task-F 升级说明：
 * 1. 顶栏升级为 [ 配置文件 (YAML) ▾ ] 组合按钮 (Split Button)；
 * 2. 支持一键打开内置轻量双层代码编辑器弹窗 (YamlConfigEditorModal)；
 * 3. 支持调起外部系统编辑器 (VS Code/Cursor/Zed/记事本等) 与资源管理器定位；
 * 4. 落实审计 1：同厂商自愈降级与置空引导，严禁跨服务商隐式静默切模；
 * 5. 挂载 ensureLsImported + ensureModelsCatalogLoaded；列表/协议读 store。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ensureModelsCatalogLoaded } from '../../api/modelsCatalogStore';
import { ensureLsImported } from '../../api/modelsLsImport';
import styles from './ModelsSettingsTab.module.css';
import yamlStyles from './YamlConfigEditorModal.module.css';
import { Button } from '../ui';
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../settings/SettingsUI';
import { emptyAddDraft, useModelProfilesState } from './useModelProfilesState';
import { ModelProfileList } from './ModelProfileList';
import { ModelsCascadeSelect } from './ModelsCascadeSelect';
import { ModelConfigEditor } from './ModelConfigEditor';
import { ModelsYamlConfigMenu } from './ModelsYamlConfigMenu';
import { useActiveModelSelfHeal } from './useActiveModelSelfHeal';
import { YamlConfigEditorModal } from './YamlConfigEditorModal';
import { useI18n } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

/**
 * 「添加服务商」：中立单按钮——点击直接创建空白服务商并进入配置，
 * 不弹第三方预置下拉（产品不绑定任何官方/第三方服务商）。
 */
export const AddProviderButton: React.FC<{
  onAdd: () => void;
  disabled?: boolean;
}> = ({ onAdd, disabled }) => {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={disabled}
      aria-label={t('settings.models.addProvider')}
      onClick={onAdd}
    >
      {t('settings.models.addProvider')}
    </Button>
  );
};

export const ModelsSettingsTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  const { t } = useI18n();
  const { showToast: _showToast } = useToast();
  const {
    profiles,
    selectedId,
    setSelectedId,
    selected,
    keyDraft,
    setKeyDraft,
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
    runAsLocalMutation,
    saveKey,
    addCustomProvider,
    handleManualAdd,
    openConfigFor,
    closeConfig,
    saveConfig,
    runTest,
    runScan,
    runCheck,
    scanModalOpen,
    setScanModalOpen,
    scannedModelsList,
    confirmScannedModels,
    modelsList,
    modelsCount,
    selectedLabel,
    hasKeySelected,
    activeProfileId,
    globalActiveModelId,
  } = useModelProfilesState();

  // 点击「添加服务商」直接创建空白服务商并进入右侧配置（无下拉预置）
  const handleDirectAdd = useCallback(async () => {
    await addCustomProvider({ baseUrl: '' });
  }, [addCustomProvider]);

  // 内置 YAML 编辑器弹窗开关（外部打开方式菜单见 ModelsYamlConfigMenu）
  const [yamlEditorOpen, setYamlEditorOpen] = useState(false);

  // 进入设置即一次性导入 LS → yaml，再加载字典镜像（单飞，幂等）
  useEffect(() => {
    void (async () => {
      await ensureLsImported();
      await ensureModelsCatalogLoaded();
    })();
  }, []);

  // 全局默认模型写路径 + 停用后同厂商自愈（落实审计 1）
  const applyActiveModel = useActiveModelSelfHeal({
    activeProfileId,
    globalActiveModelId,
    notify,
  });

  // ── 顶栏操作区：模型配置文件 (models.yaml) 组合按钮 + 添加服务商 ──────────────────
  const headerMeta = (
    <div className={yamlStyles.headerActionGroup}>
      {/* 模型配置文件 (models.yaml) 组合 Split Button */}
      <ModelsYamlConfigMenu
        onOpenBuiltinEditor={() => setYamlEditorOpen(true)}
        notify={notify}
      />

      {/* 添加服务商：点击直进配置，无预置下拉 */}
      <AddProviderButton onAdd={() => void handleDirectAdd()} />
    </div>
  );

  return (
    <SettingsPage
      title={t('settings.models.title')}
      meta={headerMeta}
      fillViewport
    >
      {/* Default model */}
      <div className={styles.mrdDefaultSection}>
        <SettingsSection title={t('settings.models.defaultModel')}>
          <SettingsCard>
            <SettingsRow
              title={t('settings.models.globalDefaultModel')}
              desc={t('settings.models.globalDefaultModelDesc')}
              control={
                <ModelsCascadeSelect
                  activeProfileId={activeProfileId || ''}
                  activeModelId={globalActiveModelId || ''}
                  onChange={(pId, mId) =>
                    void applyActiveModel({ providerId: pId, modelId: mId })
                  }
                  onClear={() => void applyActiveModel(null)}
                />
              }
            />
          </SettingsCard>
        </SettingsSection>
      </div>

      {/* Provider split layout */}
      <SettingsSection
        title={t('settings.models.sectionProviders')}
        className={styles.modelsProvidersSection}
      >
        <div className={`${styles.modelsSplit} models-split`}>
          <ModelProfileList
            selectedId={selectedId}
            onSelectProfile={setSelectedId}
          />

          <ModelConfigEditor
            providerConfig={{
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
              refresh,
              notify,
              runAsLocalMutation,
              setSelectedId,
            }}
            modelConfig={{
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
              scanModalOpen,
              setScanModalOpen,
              scannedModelsList,
              confirmScannedModels,
            }}
            capConfig={{
              configOpenId,
              cfgDraft,
              setCfgDraft,
              openConfigFor,
              closeConfig,
              saveConfig,
              runTest,
              testBusy,
              notify,
              runAsLocalMutation,
            }}
          />
        </div>
      </SettingsSection>

      {/* 内置轻量 YAML 编辑器弹窗 */}
      <YamlConfigEditorModal
        open={yamlEditorOpen}
        onClose={() => setYamlEditorOpen(false)}
        onSaved={refresh}
      />
    </SettingsPage>
  );
};
