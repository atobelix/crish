import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { Button, Input, Select } from '../ui';
import {
  saveProfileBaseUrl,
  upsertProfile,
  type ProviderProfile,
} from '../../api/providerProfiles';
import {
  modelsCatalogStore,
  selectProvider,
} from '../../api/modelsCatalogStore';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import {
  YAML_PROTOCOL_SELECT_OPTIONS,
  defaultLocalMutation,
  ensureProviderShell,
  protocolForProviderWrite,
  toYamlProtocol,
} from './catalogWriteGate';
import styles from './ModelsSettingsTab.module.css';

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
  const protocolValue =
    toYamlProtocol(storeProvider?.protocol) ?? 'openai/chat';
  const [baseUrlDraft, setBaseUrlDraft] = useState(storeBaseUrl);
  const [vendorNameDraft, setVendorNameDraft] = useState(selected.name || '');

  // 判定连接与凭据是否已配置齐全
  const effectiveBaseUrl = storeBaseUrl || selected.baseUrl || '';
  const isConfigured = Boolean(effectiveBaseUrl && hasKeySelected);

  // 折叠状态控制：已配置服务商默认折叠释放视口空间，未配置或新服务商默认展开引导输入
  const [isCollapsed, setIsCollapsed] = useState<boolean>(
    defaultCollapsed !== undefined ? defaultCollapsed : isConfigured
  );
  const prevSelectedIdRef = useRef(selected.id);

  useEffect(() => {
    setBaseUrlDraft(storeBaseUrl);
  }, [selected.id, storeBaseUrl, catalogVersion]);

  useEffect(() => {
    setVendorNameDraft(selected.name || '');
  }, [selected.id, selected.name]);

  useEffect(() => {
    if (prevSelectedIdRef.current !== selected.id) {
      prevSelectedIdRef.current = selected.id;
      setIsCollapsed(defaultCollapsed !== undefined ? defaultCollapsed : isConfigured);
    }
  }, [selected.id, isConfigured, defaultCollapsed]);

  const handleSaveVendorName = () => {
    const trimmed = vendorNameDraft.trim();
    if (trimmed !== selected.name) {
      void runAsLocalMutation(async () => {
        upsertProfile({ ...selected, name: trimmed });
        await modelsCatalogStore.updateProvider(selected.id, {
          displayName: trimmed,
        });
        _refresh();
      });
    }
  };

  const persistProviderPatch = (patch: {
    baseUrl?: string;
    protocol?: ReturnType<typeof protocolForProviderWrite>;
  }) => {
    void runAsLocalMutation(async () => {
      try {
        const shell = await ensureProviderShell({
          providerId: selected.id,
          displayName: selected.name,
          baseUrl: patch.baseUrl ?? storeBaseUrl ?? selected.baseUrl,
          protocol: patch.protocol ?? storeProvider?.protocol ?? selected.protocol,
        });
        if (!shell.ok) {
          notify(false, shell.error || '写入服务商失败');
          return;
        }
        if (patch.baseUrl !== undefined) {
          await saveProfileBaseUrl(selected.id, patch.baseUrl);
        }
        const res = await modelsCatalogStore.updateProvider(selected.id, {
          ...patch,
          protocol: protocolForProviderWrite(
            patch.protocol ?? storeProvider?.protocol ?? selected.protocol
          ),
        });
        if (!res.ok) {
          notify(false, res.error || '保存失败');
        }
      } catch (e) {
        notify(false, e instanceof Error ? e.message : String(e));
      }
    });
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
            <Lucide.ChevronRight
              size={13}
              className={styles.credentialsChevron}
              aria-hidden
            />
          ) : (
            <Lucide.ChevronDown
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
          {/* 自定义服务商厂商名称输入 */}
          {selected.id.startsWith('custom-') && (
            <div className={styles.mrdField}>
              <label className={styles.mrdFieldLabel}>
                厂商名称 <span className={styles.mrdRequiredStar}>*</span>
              </label>
              <Input
                size="sm"
                value={vendorNameDraft}
                placeholder="例如: senseNova、SiliconFlow、Ollama（必填）"
                spellCheck={false}
                onChange={(e) => setVendorNameDraft(e.target.value)}
                onBlur={handleSaveVendorName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSaveVendorName();
                  }
                }}
              />
            </div>
          )}

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
              onBlur={() => {
                persistProviderPatch({ baseUrl: baseUrlDraft.trim() });
              }}
            />
          </div>

          {/* API Key */}
          <div className={styles.mrdField}>
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
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && keyDraft.trim()) {
                      e.preventDefault();
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
              value={protocolValue}
              onChange={(val) => {
                persistProviderPatch({
                  protocol: protocolForProviderWrite(val),
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
