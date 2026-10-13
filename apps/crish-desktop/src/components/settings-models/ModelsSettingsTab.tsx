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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ensureModelsCatalogLoaded,
  getModelsCatalogPath,
  modelsCatalogStore,
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
import { emptyAddDraft, useModelProfilesState } from './useModelProfilesState';
import { ModelProfileList, ModelsCascadeSelect } from './ModelProfileList';
import { ModelConfigEditor } from './ModelConfigEditor';
import { YamlConfigEditorModal } from './YamlConfigEditorModal';
import { getOpenerIcon } from '../files/FileActions';
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
 * 停用模型后的活动模型自愈解析器（落实审计 1，严禁跨厂商静默切换）。
 * 名单与启用态只读统一树；`profiles` 参数已废除——树就是唯一名单源。
 */
export function resolveActiveModelAfterMetaChange(
  currentActive: { providerId: string; modelId: string } | null,
  isModelEnabled: (providerId: string, modelId: string) => boolean
): {
  nextActive: { providerId: string; modelId: string } | null;
  selfHealed: boolean;
} {
  if (!currentActive || !currentActive.providerId || !currentActive.modelId) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 1. 若当前活动模型仍处于启用态，无需自愈
  if (isModelEnabled(currentActive.providerId, currentActive.modelId)) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 2. 当前活动模型已被停用！仅在【同服务商】内部寻找下一个已启用的模型
  const storeIds = (
    getLiveProvider(currentActive.providerId)?.models ?? []
  ).map((m) => m.id);
  const sameProviderNext = storeIds.find((m) => {
    if (m === currentActive.modelId) return false;
    return isModelEnabled(currentActive.providerId, m);
  });

  if (sameProviderNext) {
    return {
      nextActive: {
        providerId: currentActive.providerId,
        modelId: sameProviderNext,
      },
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

export const ModelsSettingsTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
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

  /**
   * 全局默认模型唯一写路径 = 统一树 setActiveModel（workbench_apply_models_config
   * 的 CAS）。修订冲突先重读真源再重试一次，仍失败则明确报错，绝不静默吞掉。
   */
  const applyActiveModel = useCallback(
    async (ref: { providerId: string; modelId: string } | null) => {
      const first = await modelsCatalogStore.setActiveModel(ref);
      if (first.ok) return true;
      const reloaded = await modelsCatalogStore.ensureLoaded(true);
      if (!reloaded) {
        notify(false, first.error);
        return false;
      }
      const retry = await modelsCatalogStore.setActiveModel(ref);
      if (!retry.ok) notify(false, retry.error);
      return retry.ok;
    },
    [notify]
  );

  // 点击「添加服务商」直接创建空白服务商并进入右侧配置（无下拉预置）
  const handleDirectAdd = useCallback(async () => {
    await addCustomProvider({ baseUrl: '' });
  }, [addCustomProvider]);

  // ── YAML 编辑器与打开方式状态 ──────────────────────────────────────────
  const [yamlEditorOpen, setYamlEditorOpen] = useState(false);
  const [yamlMenuOpen, setYamlMenuOpen] = useState(false);
  const [availableOpeners, setAvailableOpeners] = useState<HostOpener[]>([]);
  const [systemFileManagerOpener, setSystemFileManagerOpener] =
    useState<HostOpener | null>(null);
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
        const fileManager =
          openers.find((o) => o.id === 'system-file-manager') ?? null;
        setSystemFileManagerOpener(fileManager);
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

  // 停用后同厂商自愈：enabled 读 live 树，不读 getModelMeta；tick = catalogVersion。
  // 树规范化会把失效 activeModel 置空，所以以「上一次仍有效的活动模型」为基准判定，
  // 严禁跨服务商静默切换（落实审计 1）。
  const lastActiveModelRef = useRef<{
    providerId: string;
    modelId: string;
  } | null>(null);

  useEffect(() => {
    const current =
      activeProfileId && globalActiveModelId
        ? { providerId: activeProfileId, modelId: globalActiveModelId }
        : null;
    const previous = lastActiveModelRef.current;
    lastActiveModelRef.current = current;

    if (current) {
      const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
        current,
        isLiveModelEnabled
      );
      if (!selfHealed) return;
      void applyActiveModel(nextActive);
      if (nextActive) {
        notify(
          true,
          `当前模型已停用，已自动切换至同厂商模型: ${nextActive.modelId}`
        );
      } else {
        notify(false, `当前服务商已无可用模型，请手动选择`);
      }
      return;
    }

    if (
      !previous ||
      isLiveModelEnabled(previous.providerId, previous.modelId)
    ) {
      return;
    }
    const { nextActive } = resolveActiveModelAfterMetaChange(
      previous,
      isLiveModelEnabled
    );
    if (nextActive) {
      void applyActiveModel(nextActive);
      notify(
        true,
        `当前模型已停用，已自动切换至同厂商模型: ${nextActive.modelId}`
      );
    } else {
      notify(false, `当前服务商已无可用模型，请手动选择`);
    }
  }, [
    catalogVersion,
    activeProfileId,
    globalActiveModelId,
    notify,
    applyActiveModel,
  ]);

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
    {
      id: 'default',
      label: '系统默认程序打开',
      onClick: () => void handleOpenDefault(),
    },
    {
      id: 'reveal',
      label: '在文件资源管理器中定位',
      onClick: () => void handleReveal(),
    },
    { id: 'copy-path', label: '复制绝对路径', onClick: handleCopyPath },
  ];

  // ── 顶栏操作区：模型配置文件 (models.yaml) 组合按钮 + 添加服务商 ──────────────────
  const headerMeta = (
    <div className={yamlStyles.headerActionGroup}>
      {/* 模型配置文件 (models.yaml) 组合 Split Button */}
      <div className={yamlStyles.configButtonCombo}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={
            <AppIcon
              name="file-code"
              size={13}
              className={styles.yamlConfigIcon}
              aria-hidden
            />
          }
          onClick={() => setYamlEditorOpen(true)}
          aria-label="在内置编辑器中编辑模型配置文件 (models.yaml)"
        >
          模型配置文件 (models.yaml)
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
          <div role="menu" aria-label="模型配置文件直达选项">
            <div className={yamlStyles.menuSectionTitle}>
              模型配置文件 (models.yaml)
            </div>
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
              <span>内置编辑器打开</span>
            </Button>

            <div className={yamlStyles.menuDivider} />
            <div className={yamlStyles.menuSectionTitle}>外部编辑器</div>

            {availableOpeners.map((op) => (
              <Button
                bare
                key={op.id}
                type="button"
                role="menuitem"
                className={yamlStyles.menuItemBtn}
                onClick={() => void handleOpenExternal(op.id)}
              >
                {getOpenerIcon(op, 14)}
                <span className={yamlStyles.openerName}>
                  {op.displayName || op.label || op.id}
                </span>
              </Button>
            ))}

            <Button
              bare
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => void handleOpenDefault()}
            >
              <AppIcon name="app-window" size={13} aria-hidden />
              <span>系统默认程序打开</span>
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
              {systemFileManagerOpener?.iconDataUrl ? (
                <img
                  src={systemFileManagerOpener.iconDataUrl}
                  width={14}
                  height={14}
                  alt=""
                  className={styles.openerIcon}
                />
              ) : (
                <AppIcon name="folder-open" size={13} aria-hidden />
              )}
              <span>在文件资源管理器中定位</span>
            </Button>

            <Button
              bare
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={handleCopyPath}
            >
              <AppIcon name="copy" size={13} aria-hidden />
              <span>复制绝对路径</span>
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
      <div className={styles.mrdDefaultSection}>
        <SettingsSection title="默认模型">
          <SettingsCard>
            <SettingsRow
              title="全局默认模型"
              desc="可选。不指定时，在对话里选择模型即可"
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

      {/* 内置轻量 YAML 编辑器弹窗 */}
      <YamlConfigEditorModal
        open={yamlEditorOpen}
        onClose={() => setYamlEditorOpen(false)}
        onSaved={refresh}
      />
    </SettingsPage>
  );
};
