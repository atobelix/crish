import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import styles from './ChatCard.module.css';
import { Button, Tooltip } from '../ui';
import { toggleExclusiveMenu } from '../ui/Menu';
import {
  getActiveModelId,
  getActiveProfile,
  getActiveProfileId,
} from '../../api/providerProfiles';
import {
  getLiveModel,
  getLiveProvider,
  listLivePickerEntries,
} from '../../api/modelsCatalogLive';
import { fetchEngineStatus, type EngineStatus } from '../../api/engineConfig';
import { onUiEvent } from '../../api/uiEvents';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import type { AppSettings } from '../../store/types';
import { abbreviateModel } from '../../api/modelAbbreviation';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

import { ModelBadgePickerMenu } from '../provider/ModelBadgePickerMenu';

export interface ChatHeaderControlsProps {
  appSettings: AppSettings | undefined;
  projectTick: number;
  engineModel: string;
  setEngineModel: React.Dispatch<React.SetStateAction<string>>;
  activeProfileId: string | null;
  setActiveProfileId: React.Dispatch<React.SetStateAction<string | null>>;
  showModelDropdown: boolean;
  setShowModelDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  engineHint: EngineStatus | null;
  setEngineHint: React.Dispatch<React.SetStateAction<EngineStatus | null>>;
  showModelPicker: boolean;
  needsModelSetup: boolean;
}

export interface HeaderModelLabel {
  profileId: string | null;
  model: string;
}

/**
 * 按 yaml 镜像解析顶栏当前标签。删除/改名后同厂商自愈或置空，禁止跨厂商同名跳转。
 * 未加载或空树 → 空标签，不得回落 LS 种子模型。
 */
export function resolveHeaderModelFromCatalog(opts: {
  profileId?: string | null;
  storedModel?: string | null;
  engineModel?: string | null;
  settingsDefault?: string | null;
}): HeaderModelLabel {
  const profileId = (opts.profileId || '').trim() || null;
  const candidate =
    (opts.storedModel || '').trim() ||
    (opts.engineModel || '').trim() ||
    (opts.settingsDefault || '').trim();

  if (profileId && candidate) {
    const spec = getLiveModel(profileId, candidate);
    const provider = getLiveProvider(profileId);
    if (
      spec &&
      spec.enabled !== false &&
      provider &&
      provider.enabled !== false &&
      (spec.id || '').trim()
    ) {
      return { profileId, model: spec.id };
    }
  }

  if (profileId) {
    const norm = profileId.toLowerCase();
    const firstSameVendor = listLivePickerEntries().find(
      (entry) => entry.providerId.trim().toLowerCase() === norm
    );
    if (firstSameVendor) {
      return { profileId, model: firstSameVendor.model.id };
    }
    return { profileId, model: '' };
  }

  return { profileId: null, model: '' };
}

export function useModelSelection(
  appSettings: AppSettings | undefined,
  projectTick: number
) {
  const catalogVersion = useModelsCatalogVersion();
  const [engineModel, setEngineModel] = useState('');
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [engineHint, setEngineHint] = useState<EngineStatus | null>(null);

  const applyResolvedModelLabel = (engineHintModel?: string | null) => {
    const next = resolveHeaderModelFromCatalog({
      profileId: getActiveProfileId(),
      storedModel: getActiveModelId(),
      engineModel: engineHintModel,
      settingsDefault: appSettings?.defaultModel,
    });
    setEngineModel(next.model);
    setActiveProfileId(next.profileId);
  };

  useEffect(() => {
    void fetchEngineStatus().then((s) => {
      setEngineHint(s);
      applyResolvedModelLabel(s.model);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectTick, appSettings?.defaultModel]);

  useEffect(() => {
    applyResolvedModelLabel(engineHint?.model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogVersion]);

  // 引擎连接超时回退：15 秒后 engineHint 仍为 null → 标记离线
  useEffect(() => {
    if (engineHint !== null) return;
    const timer = setTimeout(() => {
      setEngineHint({ ok: false, connected: false, error: 'not_connected' });
    }, 15_000);
    return () => clearTimeout(timer);
  }, [engineHint]);

  useEffect(() => {
    const off = onUiEvent('model-changed', (detail) => {
      if (detail?.model) setEngineModel(detail.model);
      if (detail?.profileId) setActiveProfileId(detail.profileId);
      void fetchEngineStatus().then(setEngineHint);
    });
    return off;
  }, []);

  return {
    engineModel,
    setEngineModel,
    activeProfileId,
    setActiveProfileId,
    showModelDropdown,
    setShowModelDropdown,
    engineHint,
    setEngineHint,
  };
}

export interface ModelBadgePickerProps {
  engineModel: string;
  needsModelSetup: boolean;
  needsKeySetup?: boolean;
  showModelDropdown?: boolean;
  setShowModelDropdown?: React.Dispatch<React.SetStateAction<boolean>>;
}

export const ModelBadgePicker: React.FC<ModelBadgePickerProps> = ({
  engineModel,
  needsModelSetup,
  needsKeySetup = false,
  showModelDropdown: showModelDropdownProp,
  setShowModelDropdown: setShowModelDropdownProp,
}) => {
  const { t } = useI18n();
  const [internalShow, setInternalShow] = useState(false);
  const showModelDropdown = showModelDropdownProp ?? internalShow;
  const setShowModelDropdown = setShowModelDropdownProp ?? setInternalShow;
  const badgeRef = useRef<HTMLButtonElement>(null);
  const catalogVersion = useModelsCatalogVersion();
  const choiceCount = useMemo(
    () => listLivePickerEntries().length,
    [catalogVersion]
  );

  const handleBadgeClick = useCallback(() => {
    toggleExclusiveMenu(
      showModelDropdown,
      setShowModelDropdown,
      badgeRef.current
    );
  }, [showModelDropdown, setShowModelDropdown]);

  const renderBadgeLabel = () => {
    // 正常配置就绪态
    if (
      engineModel &&
      !needsKeySetup &&
      !needsModelSetup &&
      !engineModel.includes('\u586B\u5199') &&
      !engineModel.includes('\u65E0\u53EF\u7528')
    ) {
      const abbr = abbreviateModel(engineModel);
      return (
        <span className={styles.modelAdaptiveWrapper}>
          <span className={styles.modelStandard}>{abbr.standard}</span>
          <span className={styles.modelCompact}>{abbr.compact}</span>
          <span className={styles.modelMicro}>{abbr.micro}</span>
        </span>
      );
    }

    // 未配置密钥态或未选模型态：自适应三级阶梯文案
    const isUnconfigured = needsKeySetup || choiceCount === 0;
    const standardText = isUnconfigured
      ? t('models.unconfigured', '未配置模型')
      : t('models.selectModel', '选择模型');
    const compactText = isUnconfigured
      ? t('models.configModel', '配置模型')
      : t('models.selectModel', '选择模型');
    const microText = t('models.modelLabel', '模型');

    return (
      <span className={styles.modelAdaptiveWrapper}>
        <span className={styles.modelStandard}>{standardText}</span>
        <span className={styles.modelCompact}>{compactText}</span>
        <span className={styles.modelMicro}>{microText}</span>
      </span>
    );
  };

  const tooltipText = useMemo(() => {
    const activeProf = getActiveProfile();
    if (activeProf && engineModel && !needsKeySetup && !needsModelSetup) {
      return `${activeProf.name} · ${engineModel}`;
    }
    if (needsKeySetup) {
      return t(
        'models.unconfiguredTooltip',
        '尚未配置模型服务商 · 点击打开配置'
      );
    }
    if (needsModelSetup) {
      return t(
        'models.configuredChooseTooltip',
        '已配置服务商，请选择具体模型'
      );
    }
    return choiceCount > 0
      ? t('models.chooseModelTooltip', '在此选择模型 · 点击切换')
      : t('models.unconfiguredTooltip', '尚未配置模型服务商 · 点击打开配置');
  }, [engineModel, needsKeySetup, needsModelSetup, choiceCount, t]);

  return (
    <Suspense fallback={null}>
      <Tooltip content={tooltipText} disabled={showModelDropdown}>
        <Button
          ref={badgeRef}
          type="button"
          variant="ghost"
          className={`${styles.modelBadge} model-badge-btn ${showModelDropdown ? styles.active : ''}`}
          data-testid="model-selector-button"
          data-needs-model-setup={needsModelSetup ? 'true' : 'false'}
          data-needs-key-setup={needsKeySetup ? 'true' : 'false'}
          aria-haspopup="menu"
          aria-expanded={showModelDropdown}
          aria-label={
            needsKeySetup
              ? t('models.unconfiguredAria', '未配置模型，点击进行配置')
              : t('models.selectModel', '选择模型')
          }
          style={{ cursor: 'pointer', position: 'relative' }}
          onClick={handleBadgeClick}
        >
          <span
            className={styles.modelText}
            style={{
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              flex: 1,
              textAlign: 'left',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            {renderBadgeLabel()}
          </span>
          <AppIcon
            name="chevron-down"
            size={11}
            style={{
              color: 'var(--text-tertiary)',
              flexShrink: 0,
              marginLeft: 3,
              transition: 'transform var(--transition-micro, 100ms ease)',
              transform: showModelDropdown ? 'rotate(180deg)' : 'none',
            }}
          />
        </Button>
      </Tooltip>
      {showModelDropdown ? (
        <ModelBadgePickerMenu
          activeModel={engineModel}
          onClose={() => setShowModelDropdown(false)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setShowModelDropdown(false);
          }}
          open={showModelDropdown}
          side="top"
          anchor={badgeRef}
        />
      ) : null}
    </Suspense>
  );
};
