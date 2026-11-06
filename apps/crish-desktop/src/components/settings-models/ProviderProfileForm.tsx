import React, { useEffect, useRef, useState } from 'react';
import { Button, FieldError, Input, Select } from '@/components/ui';
import { isHttpUrlText } from './fieldValidation';
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
import { G2Surface } from '../ui/G2Surface';
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
  // 字段级错误（F7）：挂字段下、保留至该字段被修正，不走 toast
  const [vendorNameError, setVendorNameError] = useState<string | null>(null);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
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
      // 切换服务商：上一家的字段错误不带过来
      setVendorNameError(null);
      setBaseUrlError(null);
      setIsCollapsed(
        defaultCollapsed !== undefined ? defaultCollapsed : isConfigured
      );
    }
  }, [selected.id, isConfigured, defaultCollapsed]);

  const handleSaveVendorName = () => {
    const trimmed = vendorNameDraft.trim();
    if (!trimmed) {
      // 字段级错误（F7）：错误挂字段下并保留用户草稿，不再 toast + 静默还原旧值——
      // 用户应能看见自己输入了什么、错在哪，修正后错误自行消失
      setVendorNameError(t('settings.models.probe.vendorNameEmpty'));
      return;
    }
    setVendorNameError(null);
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
    if (!isHttpUrlText(trimmed)) {
      // 字段级错误（F7）：格式不对不落盘，错误挂字段下（旧行为是任意字符串直接保存）
      setBaseUrlError(t('settings.models.field.baseUrlInvalid'));
      return;
    }
    setBaseUrlError(null);
    const current = storeBaseUrl || selected.baseUrl || '';
    if (trimmed !== current) {
      isSavingBaseUrlRef.current = true;
      persistProviderPatch({ baseUrl: trimmed });
    }
  };

  return (
    // G² 形状接入（槽 C）：凭据卡以 G2Surface 为根（r16 档）——填充+同路径
    // 描边（描边色经 CSS --g2-stroke 通道随 hover 两态切换），内容经同路径
    // clip 承载（.credentialsContainer 的 overflow:hidden 由 [data-g2-mode]
    // 规则放行）。contentStyle 的 flex 纵列承接原卡根 flex 语义。
    <G2Surface
      radius="r16"
      fill="var(--cover-card-bg, var(--bg-card))"
      stroke="var(--g2-stroke)"
      clip
      className={styles.credentialsContainer}
      contentStyle={{
        display: 'flex',
        flexDirection: 'column',
        flex: '1 1 auto',
        minHeight: 0,
      }}
    >
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
              aria-invalid={vendorNameError != null || undefined}
              onChange={(e) => {
                setVendorNameDraft(e.target.value);
                // 修正即清：填入非空内容后字段错误自行消失
                if (e.target.value.trim()) setVendorNameError(null);
              }}
              onBlur={handleSaveVendorName}
              onEnter={handleSaveVendorName}
            />
            {vendorNameError ? (
              <FieldError>{vendorNameError}</FieldError>
            ) : null}
          </div>

          {/* Base URL */}
          <div className={styles.mrdField}>
            <label className={styles.mrdFieldLabel}>Base URL</label>
            <Input
              size="sm"
              value={baseUrlDraft}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              aria-invalid={baseUrlError != null || undefined}
              onChange={(e) => {
                setBaseUrlDraft(e.target.value);
                // 修正即清：改到合法（或清空为未设置）后字段错误自行消失
                if (isHttpUrlText(e.target.value)) setBaseUrlError(null);
              }}
              onBlur={handleSaveBaseUrl}
              onEnter={handleSaveBaseUrl}
            />
            {baseUrlError ? <FieldError>{baseUrlError}</FieldError> : null}
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
    </G2Surface>
  );
};
