import React, {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './ChatCard.module.css';
import { Tooltip } from '../ui';
import { toggleExclusiveMenu } from '../ui/Menu';
import {
  getActiveModelId,
  getActiveProfile,
  getActiveProfileId,
  resolveDisplayModelId,
  resolvePreferredModelSelection,
} from '../../api/providerProfiles';
import { fetchEngineStatus, type EngineStatus } from '../../api/engineConfig';
import { onUiEvent } from '../../api/uiEvents';
import type { AppSettings } from '../../store/types';

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

export function useModelSelection(
  appSettings: AppSettings | undefined,
  projectTick: number
) {
  const [engineModel, setEngineModel] = useState('');
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [engineHint, setEngineHint] = useState<EngineStatus | null>(null);

  const applyResolvedModelLabel = (engineHintModel?: string | null) => {
    const resolved = resolvePreferredModelSelection(
      engineHintModel !== undefined ? { engineModel: engineHintModel } : {}
    );
    if (resolved) {
      setEngineModel(resolved.model);
      setActiveProfileId(resolved.profileId);
      return;
    }
    const settingsDefault = (appSettings?.defaultModel || '').trim();
    const localActive = (getActiveModelId() || '').trim();
    const display =
      resolveDisplayModelId(engineHintModel) ||
      localActive ||
      settingsDefault ||
      '';
    setEngineModel(display);
    setActiveProfileId(getActiveProfileId());
  };

  useEffect(() => {
    void fetchEngineStatus().then((s) => {
      setEngineHint(s);
      applyResolvedModelLabel(s.model);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectTick, appSettings?.defaultModel]);

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

interface ModelBadgePickerProps {
  engineModel: string;
  needsModelSetup: boolean;
  activeProfileId?: string | null;
  showModelDropdown?: boolean;
  setShowModelDropdown?: React.Dispatch<React.SetStateAction<boolean>>;
}

export const ModelBadgePicker: React.FC<ModelBadgePickerProps> = ({
  engineModel,
  needsModelSetup,
  activeProfileId,
  showModelDropdown: showModelDropdownProp,
  setShowModelDropdown: setShowModelDropdownProp,
}) => {
  const [internalShow, setInternalShow] = useState(false);
  const showModelDropdown = showModelDropdownProp ?? internalShow;
  const setShowModelDropdown = setShowModelDropdownProp ?? setInternalShow;
  const badgeRef = useRef<HTMLButtonElement>(null);

  const handleBadgeClick = useCallback(() => {
    toggleExclusiveMenu(
      showModelDropdown,
      setShowModelDropdown,
      badgeRef.current
    );
  }, [showModelDropdown, setShowModelDropdown]);

  const getModelDisplayName = (modelId: string) => {
    if (!modelId) return '选择模型';
    const profile = getActiveProfile();
    if (profile && activeProfileId === profile.id) {
      return modelId;
    }
    return modelId;
  };

  return (
    <Suspense fallback={null}>
      <Tooltip
        content={
          getActiveProfile()
            ? `${getActiveProfile()!.name} · ${resolveDisplayModelId(engineModel) || engineModel || '未选模型'}`
            : '服务商与模型（可在设置中更改）'
        }
        disabled={showModelDropdown}
      >
        <button
          ref={badgeRef}
          type="button"
          className={`${styles.modelBadge} ${showModelDropdown ? styles.active : ''}`}
          data-testid="model-selector-button"
          aria-haspopup="menu"
          aria-expanded={showModelDropdown}
          aria-label="选择模型"
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
            }}
          >
            {getModelDisplayName(
              resolveDisplayModelId(engineModel) ||
                engineModel ||
                (needsModelSetup ? '填写模型' : '无可用模型')
            )}
          </span>
        </button>
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
