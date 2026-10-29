import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Select } from '@/components/ui';
import {
  upsertProfile,
  type ProviderProfile,
} from '../../api/providerProfiles';
import {
  modelsCatalogStore,
  selectProvider,
} from '../../api/modelsCatalogStore';
import type { ProviderSpec } from '../../api/modelsCatalogTypes';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import {
  YAML_PROTOCOL_SELECT_OPTIONS,
  defaultLocalMutation,
  ensureProviderShell,
  protocolForProviderWrite,
  toYamlProtocol,
} from './catalogWriteGate';
import styles from './ModelsSettingsTab.module.css';
import { AppIcon } from '@/components/ui/icons';
import { t } from '../../i18n';
import {
  DEFAULT_PROTOCOL,
  type ModelProtocol,
} from '../../api/modelsNormalize';

/** 凭据区：厂商名称/Base URL/API Key/协议。配置完成后支持优雅人机工程折叠。 */
export const ProviderProfileForm: React.FC<{
  selected: ProviderProfile;
  hasKeySelected: boolean;
  keyDraft: string;
  setKeyDraft: (val: string) => void;
  saveKey: () => Promise<void>;
  notify: (ok: boolean, text: string) => void;
  refresh: () => void;
  runAsLocalMutation?: <T>(fn: () => Promise<T> | T) => Promise<T>;
  defaultCollapsed?: boolean;
}> = ({
  selected,
  hasKeySelected,
  keyDraft,
  setKeyDraft,
  saveKey,
  notify,
  refresh: _refresh,
  runAsLocalMutation = defaultLocalMutation,
  defaultCollapsed,
}) => {
  const catalogVersion = useModelsCatalogVersion();
  const storeProvider = selectProvider(selected.id);
  const storeBaseUrl = storeProvider?.baseUrl ?? '';
  const effectiveProtocol =
    toYamlProtocol(storeProvider?.protocol ?? selected.protocol) ??
    DEFAULT_PROTOCOL;

  const [baseUrlDraft, setBaseUrlDraft] = useState(storeBaseUrl);
  const vendorName = storeProvider?.displayName || selected.name || '';
  const [vendorNameDraft, setVendorNameDraft] = useState(vendorName);
  const [protocolDraft, setProtocolDraft] =
    useState<ModelProtocol>(effectiveProtocol);

  // 判定连接与凭据是否已配置齐全
  const effectiveBaseUrl = storeBaseUrl || selected.baseUrl || '';
  const isConfigured = Boolean(effectiveBaseUrl && hasKeySelected);

  // 折叠状态控制：已配置服务商默认折叠释放视口空间，未配置或新服务商默认展开引导输入
  const [isCollapsed, setIsCollapsed] = useState<boolean>(
    defaultCollapsed !== undefined ? defaultCollapsed : isConfigured
  );
  const prevSelectedIdRef = useRef(selected.id);
  const isSavingBaseUrlRef = useRef(false);

  useEffect(() => {
    setBaseUrlDraft(storeBaseUrl);
  }, [selected.id, storeBaseUrl, catalogVersion]);

  useEffect(() => {
    setVendorNameDraft(vendorName);
  }, [selected.id, vendorName]);

  useEffect(() => {
    setProtocolDraft(effectiveProtocol);
  }, [selected.id, effectiveProtocol, catalogVersion]);

  useEffect(() => {
    if (prevSelectedIdRef.current !== selected.id) {
      prevSelectedIdRef.current = selected.id;
      setIsCollapsed(
        defaultCollapsed !== undefined ? defaultCollapsed : isConfigured
      );
    }
  }, [selected.id, isConfigured, defaultCollapsed]);

  const handleSaveVendorName = () => {
    const trimmed = vendorNameDraft.trim();
    if (!trimmed) {
      notify(false, t('settings.models.probe.vendorNameEmpty'));
      setVendorNameDraft(vendorName);
      return;
    }
    if (trimmed !== vendorName) {
      void runAsLocalMutation(async () => {
        try {
          const res = await modelsCatalogStore.updateProvider(selected.id, {
            displayName: trimmed,
          });
          if (!res.ok) {
            notify(
              false,
              res.error || t('settings.models.probe.vendorNameSaveFailed')
            );
          } else {
            upsertProfile({ ...selected, name: trimmed });
            _refresh();
          }
        } catch (e) {
          notify(false, e instanceof Error ? e.message : String(e));
        }
      });
    }
  };

  const persistProviderPatch = (patch: {
    baseUrl?: string;
    protocol?: ModelProtocol;
  }) => {
    void runAsLocalMutation(async () => {
      try {
        const cleanBaseUrl =
          patch.baseUrl !== undefined
            ? patch.baseUrl.trim() || undefined
            : storeBaseUrl || selected.baseUrl || undefined;
        const cleanProtocol =
          patch.protocol ?? storeProvider?.protocol ?? selected.protocol;

        const shell = await ensureProviderShell({
          providerId: selected.id,
          displayName: vendorName,
          baseUrl: cleanBaseUrl ?? '',
          protocol: cleanProtocol,
        });
        if (!shell.ok) {
          setProtocolDraft(effectiveProtocol);
          notify(false, shell.error || '写入服务商失败');
          return;
        }

        const updatePatch: Partial<ProviderSpec> = {};
        if (patch.baseUrl !== undefined) {
          updatePatch.baseUrl = patch.baseUrl.trim() || undefined;
        }
        if (patch.protocol !== undefined) {
          updatePatch.protocol = protocolForProviderWrite(patch.protocol);
        }

        const res = await modelsCatalogStore.updateProvider(
          selected.id,
          updatePatch
        );
        if (!res.ok) {
          setProtocolDraft(effectiveProtocol);
          notify(false, res.error || '保存失败');
        } else {
          _refresh();
        }
      } catch (e) {
        setProtocolDraft(effectiveProtocol);
        notify(false, e instanceof Error ? e.message : String(e));
      } finally {
        isSavingBaseUrlRef.current = false;
      }
    });
  };

  const handleSaveBaseUrl = () => {
    if (isSavingBaseUrlRef.current) return;
    const trimmed = baseUrlDraft.trim();
    const current = storeBaseUrl || selected.baseUrl || '';
    if (trimmed !== current) {
      isSavingBaseUrlRef.current = true;
      persistProviderPatch({ baseUrl: trimmed });
    }
  };

  return (
    <div className={styles.credentialsContainer}>
      <div
        className={styles.credentialsHeader}
        onClick={() => setIsCollapsed((prev) => !prev)}
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsCollapsed((prev) => !prev);
          }
        }}
      >
        <div className={styles.credentialsHeaderLeft}>
          {isCollapsed ? (
            <AppIcon
              name="chevron-right"
              size={13}
              className={styles.credentialsChevron}
              aria-hidden
            />
          ) : (
            <AppIcon
              name="chevron-down"
              size={13}
              className={styles.credentialsChevron}
              aria-hidden
            />
          )}
          <span className={styles.credentialsTitle}>连接与凭据</span>
        </div>
        <div className={styles.credentialsHeaderRight}>
          <span
            className={
              isConfigured
                ? styles.credentialsStatusConfigured
                : styles.credentialsStatusUnconfigured
            }
          >
            <span
              className={
                isConfigured
                  ? styles.credentialsStatusDotActive
                  : styles.credentialsStatusDotMuted
              }
              aria-hidden
            />
            {isConfigured ? '已配置' : '待配置'}
          </span>
        </div>
      </div>

      {!isCollapsed && (
        <div className={styles.credentialsBody}>
          {/* 服务商厂商名称输入（所有服务商均可改名——不与厂商 id 绑定） */}
          <div className={styles.mrdField}>
            <label className={styles.mrdFieldLabel}>
              厂商名称 <span className={styles.mrdRequiredStar}>*</span>
            </label>
            <Input
              size="sm"
              value={vendorNameDraft}
              placeholder="例如: senseNova、SiliconFlow、Ollama"
              spellCheck={false}
              onChange={(e) => setVendorNameDraft(e.target.value)}
              onBlur={handleSaveVendorName}
              onEnter={handleSaveVendorName}
            />
          </div>

          {/* Base URL */}
          <div className={styles.mrdField}>
            <label className={styles.mrdFieldLabel}>Base URL</label>
            <Input
              size="sm"
              value={baseUrlDraft}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              onChange={(e) => {
                setBaseUrlDraft(e.target.value);
              }}
              onBlur={handleSaveBaseUrl}
              onEnter={handleSaveBaseUrl}
            />
          </div>

          {/* API Key */}
          <div className={styles.mrdKeyRowContainer ?? styles.mrdField}>
            <label className={styles.mrdFieldLabel}>API Key</label>
            <div className={styles.mrdKeyRow}>
              <div className={styles.mrdKeyInputWrapper}>
                <Input
                  variant="password"
                  size="sm"
                  placeholder={
                    hasKeySelected ? '••••••••••••••••••••' : '粘贴 API Key'
                  }
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  onEnter={() => {
                    if (keyDraft.trim()) {
                      void saveKey();
                    }
                  }}
                />
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!keyDraft.trim()}
                onClick={() => void saveKey()}
                className={styles.mrdKeySaveBtn}
              >
                保存
              </Button>
            </div>
          </div>

          {/* 首要通信协议 */}
          <div className={styles.mrdField}>
            <label className={styles.mrdFieldLabel}>首要通信协议</label>
            <Select
              size="sm"
              value={protocolDraft}
              onChange={(val) => {
                const next = protocolForProviderWrite(val);
                setProtocolDraft(next);
                persistProviderPatch({
                  protocol: next,
                });
              }}
              options={[...YAML_PROTOCOL_SELECT_OPTIONS]}
            />
          </div>
        </div>
      )}
    </div>
  );
};
