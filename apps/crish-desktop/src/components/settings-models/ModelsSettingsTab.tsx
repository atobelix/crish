import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 模型：选择服务商、配置密钥，并管理可用模型。
 *
 * Task-F 升级说明：
 * 1. 顶栏升级为 [ 配置文件 (YAML) ▾ ] 组合按钮 (Split Button)；
 * 2. 支持一键打开内置轻量双层代码编辑器弹窗 (YamlConfigEditorModal)；
 * 3. 支持调起外部系统编辑器 (VS Code/Cursor/Zed/记事本等) 与资源管理器定位；
 * 4. 落实审计 1：同厂商自愈降级与置空引导，严禁跨服务商隐式静默切模；
 * 5. 接入 useModelMetaTick 响应式驱动，联动 ModelsCascadeSelect 即时重绘。
 */
import React, { useCallback, useEffect, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  activateProfileModel,
  clearActiveModelId,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { getModelMeta } from '../../api/modelCatalog';
import {
  ensureModelsCatalogLoaded,
  getModelsCatalogPath,
} from '../../api/modelsCatalogStore';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { useModelMetaTick } from '../../hooks/useModelMetaTick';
import {
  listHostOpeners,
  openPathDefault,
  openWithHostOpener,
  type HostOpener,
} from '../../api/hostOpenersApi';
import styles from './ModelsSettingsTab.module.css';
import yamlStyles from './YamlConfigEditorModal.module.css';
import { Button, Menu } from '../ui';
import type { SelectOptionItem } from '../ui';
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../settings/SettingsUI';
import {
  emptyAddDraft,
  PRESETS,
  useModelProfilesState,
  type PresetProvider,
} from './useModelProfilesState';
import { ModelProfileList, ModelsCascadeSelect } from './ModelProfileList';
import { ModelConfigEditor } from './ModelConfigEditor';
import { YamlConfigEditorModal } from './YamlConfigEditorModal';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

/**
 * 停用模型后的活动模型自愈解析器（落实审计 1，严禁跨厂商静默切换）
 */
export function resolveActiveModelAfterMetaChange(
  currentActive: { profileId: string; model: string } | null,
  profiles: readonly ProviderProfile[],
  isModelEnabled: (profileId: string, model: string) => boolean
): { nextActive: { profileId: string; model: string } | null; selfHealed: boolean } {
  if (!currentActive || !currentActive.profileId || !currentActive.model) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 1. 若当前活动模型仍处于启用态，无需自愈
  if (isModelEnabled(currentActive.profileId, currentActive.model)) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 2. 当前活动模型已被停用！仅在【同服务商】内部寻找下一个已启用的模型
  const currentProfile = profiles.find((p) => p.id === currentActive.profileId);
  const sameProviderNext = currentProfile?.models.find((m) => {
    if (m === currentActive.model) return false;
    return isModelEnabled(currentActive.profileId, m);
  });

  if (sameProviderNext) {
    return {
      nextActive: { profileId: currentActive.profileId, model: sameProviderNext },
      selfHealed: true,
    };
  }

  // 3. 该服务商已无任何可用模型 -> 严禁跨厂商切换！直接置空以引导手动选择
  return { nextActive: null, selfHealed: true };
}

/**
 * 「添加服务商」下拉
 */
export const AddProviderMenu: React.FC<{
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
  onAddTemplate: (format: 'openai' | 'anthropic') => void;
  onAddPreset: (preset: PresetProvider) => void;
}> = ({ addOpen, setAddOpen, onAddTemplate, onAddPreset }) => {
  const menuOptions: SelectOptionItem[] = [
    { id: 'openai', label: 'OpenAI 格式', onClick: () => onAddTemplate('openai') },
    { id: 'anthropic', label: 'Anthropic 格式', onClick: () => onAddTemplate('anthropic') },
    ...PRESETS.map((pr) => ({ id: pr.id, label: pr.name, onClick: () => onAddPreset(pr) })),
  ];

  return (
    <Menu
      openState={{ open: addOpen, onOpenChange: setAddOpen }}
      position={{ align: 'end', side: 'bottom', sideOffset: 6 }}
      options={menuOptions}
      panel={{ contentClassName: styles.addProviderMenu }}
      trigger={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={styles.addServiceBtn}
          aria-label="添加服务商"
          icon={<Lucide.Plus size={13} style={{ opacity: 0.75 }} aria-hidden />}
        >
          添加服务商
        </Button>
      }
    >
      <div role="menu" aria-label="添加服务商">
        <div className={styles.addMenuTitle}>接口类型</div>
        <Button
          bare
          type="button"
          role="menuitem"
          className={styles.addMenuOption}
          onClick={() => onAddTemplate('openai')}
        >
          OpenAI 格式
        </Button>
        <Button
          bare
          type="button"
          role="menuitem"
          className={styles.addMenuOption}
          onClick={() => onAddTemplate('anthropic')}
        >
          Anthropic 格式
        </Button>

        <div className={`${styles.addMenuTitle} ${styles.addMenuTitleGap}`}>常用服务</div>
        {PRESETS.map((pr) => (
          <Button
            bare
            key={pr.id}
            type="button"
            role="menuitem"
            className={styles.addMenuOption}
            onClick={() => onAddPreset(pr)}
          >
            {pr.name}
          </Button>
        ))}
      </div>
    </Menu>
  );
};

export const ModelsSettingsTab: React.FC<Props> = ({ _onBlockingOverlayChange }) => {
  const { showToast: _showToast } = useToast();
  const {
    profiles, setProfiles, selectedId, setSelectedId, selected,
    keyDraft, setKeyDraft, addOpen, setAddOpen,
    testBusy, scanBusy, checkBusy,
    modelFilter, setModelFilter, configOpenId,
    manualOpen, setManualOpen, addDraft, setAddDraft,
    cfgDraft, setCfgDraft, editingName, setEditingName,
    nameDraft, setNameDraft, confirmDeleteId, setConfirmDeleteId,
    refresh, notify, saveKey, addFromTemplate, addFromPreset,
    handleManualAdd, openConfigFor, closeConfig, saveConfig,
    runTest, runScan, runCheck,
    scanModalOpen, setScanModalOpen, scannedModelsList, confirmScannedModels,
    modelsList, modelsCount,
    selectedLabel, hasKeySelected, activeProfileId, globalActiveModelId,
  } = useModelProfilesState();

  // ── YAML 编辑器与打开方式状态 ──────────────────────────────────────────
  const [yamlEditorOpen, setYamlEditorOpen] = useState(false);
  const [yamlMenuOpen, setYamlMenuOpen] = useState(false);
  const [availableOpeners, setAvailableOpeners] = useState<HostOpener[]>([]);
  // 真源路径唯一定点 = 字典镜像（Rust workbench_read_models_yaml 返回）；
  // 订阅镜像版本号保证镜像重载后路径与回调同步更新
  const catalogVersion = useModelsCatalogVersion();
  const configFilePath = getModelsCatalogPath();

  // 挂载即确保字典镜像就绪（真源 = ~/.conex/models.yaml；扫描确认/联想预填依赖）
  useEffect(() => {
    void ensureModelsCatalogLoaded();
  }, []);

  // 扫描外部可用编辑器
  useEffect(() => {
    let active = true;
    listHostOpeners()
      .then((openers) => {
        if (!active) return;
        const filtered = openers.filter(
          (o) =>
            o.available &&
            (o.kind === 'editor' ||
              ['vscode', 'cursor', 'zed', 'windsurf', 'trae'].includes(o.id) ||
              o.id.includes('notepad'))
        );
        setAvailableOpeners(filtered);
      })
      .catch(() => {
        /* swallow-ok */
      });
    return () => {
      active = false;
    };
  }, []);

  // ── 审计 1 落实：同厂商自愈降级与置空引导（metaTick 驱动）──────────────
  // tick = modelCatalogMeta 写路径广播（useModelMetaTick），开关切换后本 effect 即时重跑
  const metaTick = useModelMetaTick();
  useEffect(() => {
    if (!activeProfileId || !globalActiveModelId) return;

    const currentActive = {
      profileId: activeProfileId,
      model: globalActiveModelId,
    };

    const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
      currentActive,
      profiles,
      (pId, m) => getModelMeta(pId, m).enabled !== false
    );

    if (selfHealed) {
      if (nextActive) {
        void activateProfileModel(nextActive.profileId, nextActive.model);
        notify(true, `当前模型已停用，已自动切换至同厂商模型: ${nextActive.model}`);
      } else {
        clearActiveModelId();
        notify(false, `当前服务商已无可用模型，请手动选择`);
      }
    }
  }, [metaTick, profiles, activeProfileId, globalActiveModelId, notify]);

  // 调起指定外部编辑器
  const handleOpenExternal = useCallback(
    async (openerId: string) => {
      setYamlMenuOpen(false);
      try {
        await openWithHostOpener(openerId, configFilePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '打开失败';
        notify(false, msg);
      }
    },
    [configFilePath, notify]
  );

  // 调起系统默认程序
  const handleOpenDefault = useCallback(async () => {
    setYamlMenuOpen(false);
    try {
      await openPathDefault(configFilePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '打开失败';
      notify(false, msg);
    }
  }, [configFilePath, notify]);

  // 资源管理器定位
  const handleReveal = useCallback(async () => {
    setYamlMenuOpen(false);
    try {
      await openWithHostOpener('system-file-manager', configFilePath);
    } catch {
      try {
        await openPathDefault(configFilePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '定位失败';
        notify(false, msg);
      }
    }
  }, [configFilePath, notify]);

  // 复制路径
  const handleCopyPath = useCallback(() => {
    setYamlMenuOpen(false);
    try {
      void navigator.clipboard.writeText(configFilePath);
      notify(true, '已复制配置文件绝对路径');
    } catch {
      notify(false, '复制失败');
    }
  }, [configFilePath, notify]);

  // 外部菜单键盘选项定义
  const yamlMenuOptions: SelectOptionItem[] = [
    {
      id: 'builtin',
      label: '内置编辑器打开',
      onClick: () => {
        setYamlMenuOpen(false);
        setYamlEditorOpen(true);
      },
    },
    ...availableOpeners.map((op) => ({
      id: op.id,
      label: op.displayName || op.label || op.id,
      onClick: () => void handleOpenExternal(op.id),
    })),
    { id: 'default', label: '系统默认程序打开', onClick: () => void handleOpenDefault() },
    { id: 'reveal', label: '在文件资源管理器中定位', onClick: () => void handleReveal() },
    { id: 'copy-path', label: '复制绝对路径', onClick: handleCopyPath },
  ];

  // ── 顶栏操作区：配置文件 (YAML) 组合按钮 + 添加服务商 ──────────────────
  const headerMeta = (
    <div className={yamlStyles.headerActionGroup}>
      {/* 配置文件 (YAML) 组合 Split Button */}
      <div className={yamlStyles.configButtonCombo}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Lucide.FileCode2 size={13} style={{ opacity: 0.8 }} aria-hidden />}
          onClick={() => setYamlEditorOpen(true)}
          aria-label="在内置编辑器中编辑配置文件 (YAML)"
        >
          配置文件 (YAML)
        </Button>
        <Menu
          openState={{ open: yamlMenuOpen, onOpenChange: setYamlMenuOpen }}
          position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
          options={yamlMenuOptions}
          panel={{ contentClassName: yamlStyles.yamlDropdownMenu }}
          trigger={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={yamlStyles.configMenuTrigger}
              aria-label="配置文件直达与打开方式"
              icon={<Lucide.ChevronDown size={13} aria-hidden />}
            />
          }
        >
          <div role="menu" aria-label="配置文件直达选项">
            <div className={yamlStyles.menuSectionTitle}>配置文件 (models.yaml)</div>
            <Button
              bare
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => {
                setYamlMenuOpen(false);
                setYamlEditorOpen(true);
              }}
            >
              <Lucide.Code size={13} aria-hidden />
              内置编辑器打开
            </Button>

            <div className={yamlStyles.menuDivider} />
            <div className={yamlStyles.menuSectionTitle}>外部编辑器调起</div>

            {availableOpeners.map((op) => (
              <Button
                bare
                key={op.id}
                type="button"
                role="menuitem"
                className={yamlStyles.menuItemBtn}
                onClick={() => void handleOpenExternal(op.id)}
              >
                <Lucide.ExternalLink size={13} aria-hidden />
                {op.displayName || op.label || op.id}
              </Button>
            ))}

            <Button
              bare
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => void handleOpenDefault()}
            >
              <Lucide.ExternalLink size={13} aria-hidden />
              系统默认程序打开
            </Button>

            <div className={yamlStyles.menuDivider} />
            <div className={yamlStyles.menuSectionTitle}>文件操作</div>

            <Button
              bare
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => void handleReveal()}
            >
              <Lucide.FolderOpen size={13} aria-hidden />
              在文件资源管理器中定位
            </Button>

            <Button
              bare
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={handleCopyPath}
            >
              <Lucide.Copy size={13} aria-hidden />
              复制绝对路径
            </Button>
          </div>
        </Menu>
      </div>

      {/* 添加服务商 */}
      <div style={{ position: 'relative', display: 'inline-block' }}>
        <AddProviderMenu
          addOpen={addOpen}
          setAddOpen={setAddOpen}
          onAddTemplate={addFromTemplate}
          onAddPreset={addFromPreset}
        />
      </div>
    </div>
  );

  return (
    <SettingsPage title="模型" meta={headerMeta} fillViewport>
      {/* Default model */}
      <div style={{ flexShrink: 0 }}>
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
                onChange={async (pId, mId) => {
                  await activateProfileModel(pId, mId);
                  refresh();
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>
      </div>

      {/* Provider split layout */}
      <div className={`${styles.modelsSplit} models-split`}>
        <ModelProfileList
          profiles={profiles}
          selectedId={selectedId}
          onSelectProfile={setSelectedId}
        />

        <ModelConfigEditor
          providerConfig={{
            selected, profiles, selectedLabel, hasKeySelected,
            editingName, nameDraft, setNameDraft, setEditingName,
            confirmDeleteId, setConfirmDeleteId, keyDraft, setKeyDraft,
            saveKey, refresh, notify, setProfiles, setSelectedId,
          }}
          modelConfig={{
            runCheck, runScan, checkBusy, scanBusy,
            modelFilter, setModelFilter, manualOpen, setManualOpen,
            addDraft, setAddDraft, handleManualAdd, emptyAddDraft,
            modelsList, modelsCount,
            scanModalOpen, setScanModalOpen, scannedModelsList, confirmScannedModels,
          }}
          capConfig={{
            configOpenId, cfgDraft, setCfgDraft,
            openConfigFor, closeConfig, saveConfig, runTest, testBusy,
          }}
        />
      </div>

      {/* 内置轻量 YAML 编辑器弹窗 */}
      <YamlConfigEditorModal
        open={yamlEditorOpen}
        onClose={() => setYamlEditorOpen(false)}
        onSaved={refresh}
      />
    </SettingsPage>
  );
};
