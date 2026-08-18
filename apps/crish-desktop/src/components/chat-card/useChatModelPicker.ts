import { useState, useEffect } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { useSettingsField, selectAppSettings } from '../../store/storeAccess';
import { getProviderSetupStatus } from '../../api/providerProfiles';
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
  const appSettings: AppSettings | undefined = useSettingsField(selectAppSettings);
  const [pickerInlineError, setPickerInlineError] = useState('');

  const {
    engineModel,
    activeProfileId,
    showModelDropdown,
    setShowModelDropdown,
    engineHint,
  } = useModelSelection(appSettings ?? undefined, projectTick);

  const setupStatus = getProviderSetupStatus({
    ...(engineHint?.ok !== undefined ? { engineOk: engineHint.ok } : {}),
    ...(engineHint?.hasApiKey !== undefined
      ? { engineHasApiKey: engineHint.hasApiKey }
      : {}),
    engineModel: engineHint?.model ?? engineModel,
  });

  const needsKeySetup = setupStatus.needsKeySetup;
  const needsModelSetup = setupStatus.needsModelSetup;
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
