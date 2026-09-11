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
import {
  activateProfileModel,
  clearActiveModelId,
  type ProviderProfile,
} from '../../api/providerProfiles';
import {
  ensureModelsCatalogLoaded,
  getModelsCatalogPath,
} from '../../api/modelsCatalogStore';
import { getLiveModel, getLiveProvider } from '../../api/modelsCatalogLive';
import { ensureLsImported } from '../../api/modelsLsImport';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
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
  useModelProfilesState,
} from './useModelProfilesState';
import { ModelProfileList, ModelsCascadeSelect } from './ModelProfileList';
import { ModelConfigEditor } from './ModelConfigEditor';
import { YamlConfigEditorModal } from './YamlConfigEditorModal';
import { AppIcon } from '../ui/icons/index';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

/** live 树中存在且 enabled !== false。缺节点视为未启用（删除后必须自愈）。 */
export function isLiveModelEnabled(profileId: string, model: string): boolean {
  const spec = getLiveModel(profileId, model);
  return spec != null && spec.enabled !== false;
}

/**
 * 停用模型后的活动模型自愈解析器（落实审计 1，严禁跨厂商静默切换）
 */
export function resolveActiveModelAfterMetaChange(
  currentActive: { profileId: string; model: string } | null,
  _profiles: readonly ProviderProfile[],
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
  const storeIds = (getLiveProvider(currentActive.profileId)?.models ?? []).map(
    (m) => m.id
  );
  const sameProviderNext = storeIds.find((m) => {
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
 * 「添加服务商」：中立单按钮——点击直接创建空白服务商并进入配置，
 * 不弹第三方预置下拉（产品不绑定任何官方/第三方服务商）。
 */
export const AddProviderButton: React.FC<{
  onAdd: () => void;
  disabled?: boolean;
}> = ({ onAdd, disabled }) => (
  <Button
    type="button"
    variant="secondary"
    size="sm"
    disabled={disabled}
    aria-label="添加服务商"
    onClick={onAdd}
  >
    添加服务商
  </Button>
);

/**
 * @deprecated 兼容旧测试入口：历史下拉菜单已废除，现转发为直进配置。
 */
export const AddProviderMenu: React.FC<{
  addOpen: boolean;
  setAddOpen: (v: boolean) => void;
  onAddTemplate?: (format: 'openai' | 'anthropic') => void;
  onAddPreset?: (preset: { id: string; name: string }) => void;
  onAddDirect?: () => void;
}> = ({ onAddDirect }) => {
  // 废弃壳：保持可 import 的旧导出；实际行为 = 直接添加
  return <AddProviderButton onAdd={() => onAddDirect?.()} />;
};

export const ModelsSettingsTab: React.FC<Props> = ({ _onBlockingOverlayChange }) => {
  const { showToast: _showToast } = useToast();
  const {
    profiles, setProfiles, selectedId, setSelectedId, selected,
    keyDraft, setKeyDraft,
    testBusy, scanBusy, checkBusy,
    modelFilter, setModelFilter, configOpenId,
    manualOpen, setManualOpen, addDraft, setAddDraft,
    cfgDraft, setCfgDraft, editingName, setEditingName,
    nameDraft, setNameDraft, confirmDeleteId, setConfirmDeleteId,
    refresh, notify, runAsLocalMutation, saveKey, addCustomProvider,
    handleManualAdd, openConfigFor, closeConfig, saveConfig,
    runTest, runScan, runCheck,
    scanModalOpen, setScanModalOpen, scannedModelsList, confirmScannedModels,
    modelsList, modelsCount,
    selectedLabel, hasKeySelected, activeProfileId, globalActiveModelId,
  } = useModelProfilesState();

  // 点击「添加服务商」直接创建空白服务商并进入右侧配置（无下拉预置）
  const handleDirectAdd = useCallback(async () => {
    await addCustomProvider({ baseUrl: '' });
  }, [addCustomProvider]);

  // ── YAML 编辑器与打开方式状态 ──────────────────────────────────────────
  const [yamlEditorOpen, setYamlEditorOpen] = useState(false);
  const [yamlMenuOpen, setYamlMenuOpen] = useState(false);
  const [availableOpeners, setAvailableOpeners] = useState<HostOpener[]>([]);
  // 真源路径唯一定点 = 字典镜像（Rust workbench_read_models_yaml 返回）；
  // 订阅镜像版本号保证镜像重载后路径与回调同步更新
  const catalogVersion = useModelsCatalogVersion();
  const configFilePath = getModelsCatalogPath();

  // 进入设置即一次性导入 LS → yaml，再加载字典镜像（单飞，幂等）
  useEffect(() => {
    void (async () => {
      await ensureLsImported();
      await ensureModelsCatalogLoaded();
    })();
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

  // 停用后同厂商自愈：enabled 读 live 树，不读 getModelMeta；tick = catalogVersion
  useEffect(() => {
    if (!activeProfileId || !globalActiveModelId) return;

    const currentActive = {
      profileId: activeProfileId,
      model: globalActiveModelId,
    };

    const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
      currentActive,
      profiles,
      isLiveModelEnabled
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
  }, [catalogVersion, profiles, activeProfileId, globalActiveModelId, notify]);

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
          icon={<AppIcon name="file-code" size={13} style={{ opacity: 0.8 }} aria-hidden />}
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
              icon={<AppIcon name="chevron-down" size={13} aria-hidden />}
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
              <AppIcon name="code" size={13} aria-hidden />
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
                <AppIcon name="external-link" size={13} aria-hidden />
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
              <AppIcon name="external-link" size={13} aria-hidden />
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
              <AppIcon name="folder-open" size={13} aria-hidden />
              在文件资源管理器中定位
            </Button>

            <Button
              bare
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={handleCopyPath}
            >
              <AppIcon name="copy" size={13} aria-hidden />
              复制绝对路径
            </Button>
          </div>
        </Menu>
      </div>

      {/* 添加服务商：点击直进配置，无预置下拉 */}
      <AddProviderButton onAdd={() => void handleDirectAdd()} />
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
            saveKey, refresh, notify, runAsLocalMutation, setProfiles, setSelectedId,
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
            notify, runAsLocalMutation,
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
