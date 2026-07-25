import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import styles from '../ChatCard.module.css';
import { Tooltip } from '../settings/SettingsUI';
import {
  getActiveModelId,
  getActiveProfile,
  getActiveProfileId,
  resolveDisplayModelId,
  resolvePreferredModelSelection,
} from '../../api/providerProfiles';
import { fetchEngineStatus, type EngineStatus } from '../../api/engineConfig';
import { onUiEvent } from '../../api/uiEvents';
import type { AppSettings } from '../../store/layoutStore';

import { ModelBadgePickerMenu } from '../ModelBadgePickerMenu';

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

export function useModelSelection(appSettings: AppSettings | undefined, projectTick: number) {
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
}

export const ModelBadgePicker: React.FC<ModelBadgePickerProps> = ({
  engineModel,
  needsModelSetup,
  activeProfileId,
}) => {
  const [showModelDropdown, setShowModelDropdown] = useState(false);

  const getModelDisplayName = (modelId: string) => {
    if (!modelId) return '选择模型';
    const profile = getActiveProfile();
    if (profile && activeProfileId === profile.id) {
      return modelId;
    }
    return modelId;
  };

  return (
    <Popover.Root open={showModelDropdown} onOpenChange={setShowModelDropdown}>
      <Tooltip
        content={
          getActiveProfile()
            ? `${getActiveProfile()!.name} · ${resolveDisplayModelId(engineModel) || engineModel || '未选模型'}`
            : '服务商与模型（可在设置中更改）'
        }
      >
        <Popover.Trigger asChild>
          <div
            className={`${styles.modelBadge} ${showModelDropdown ? styles.active : ''}`}
            data-testid="model-selector-button"
            style={{ cursor: 'pointer', position: 'relative' }}
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
            <ChevronDown
              size={14}
              style={{ opacity: 0.6, marginLeft: 6, flexShrink: 0 }}
            />
          </div>
        </Popover.Trigger>
      </Tooltip>
      {showModelDropdown && (
        <Suspense fallback={null}>
          <ModelBadgePickerMenu
            activeModel={engineModel}
            onClose={() => setShowModelDropdown(false)}
          />
        </Suspense>
      )}
    </Popover.Root>
  );
};
