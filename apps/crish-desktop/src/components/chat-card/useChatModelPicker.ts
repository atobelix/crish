import { useState, useEffect, useMemo } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { useSettingsField, selectAppSettings } from '../../store/storeAccess';
import { getProviderSetupStatus } from '../../api/providerProfiles';
import { listLivePickerEntries } from '../../api/modelsCatalogLive';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { useModelSelection } from './ChatHeaderControls';
import type { EngineStatus } from '../../api/engineConfig';
import type { AppSettings } from '../../store/types';

export interface UseChatModelPickerOptions {
  projectTick: number;
}

export interface UseChatModelPickerResult {
  engineModel: string;
  activeProfileId: string | null;
  showModelDropdown: boolean;
  setShowModelDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  engineHint: EngineStatus | null;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  showModelPicker: boolean;
  pickerInlineError: string;
  setPickerInlineError: React.Dispatch<React.SetStateAction<string>>;
}

export function useChatModelPicker({
  projectTick,
}: UseChatModelPickerOptions): UseChatModelPickerResult {
  const appSettings: AppSettings | null = useSettingsField(selectAppSettings);
  const catalogVersion = useModelsCatalogVersion();
  const [pickerInlineError, setPickerInlineError] = useState('');

  const {
    engineModel,
    activeProfileId,
    showModelDropdown,
    setShowModelDropdown,
    engineHint,
  } = useModelSelection(appSettings ?? undefined, projectTick);

  const liveHasEnabledModel = useMemo(
    () => listLivePickerEntries().length > 0,
    [catalogVersion]
  );

  const setupStatus = getProviderSetupStatus({
    ...(engineHint?.ok !== undefined ? { engineOk: engineHint.ok } : {}),
    ...(engineHint?.hasApiKey !== undefined
      ? { engineHasApiKey: engineHint.hasApiKey }
      : {}),
    engineModel: engineHint?.model ?? engineModel,
  });

  const needsKeySetup = setupStatus.needsKeySetup;
  // yaml 空树 / 未加载 → 需要填模型；禁止用 LS 种子列表把 needsModelSetup 打成 false
  const needsModelSetup = setupStatus.hasKey && !liveHasEnabledModel;
  const showModelPicker = setupStatus.showModelPicker;

  // pickerInlineError toast 展示
  useEffect(() => {
    if (pickerInlineError) {
      toast.show(pickerInlineError);
      setPickerInlineError('');
    }
  }, [pickerInlineError]);

  return {
    engineModel,
    activeProfileId,
    showModelDropdown,
    setShowModelDropdown,
    engineHint,
    needsKeySetup,
    needsModelSetup,
    showModelPicker,
    pickerInlineError,
    setPickerInlineError,
  };
}
