/**
 * Hook for managing models settings state.
 */
import {
  useModelProfilesState,
  PRESETS,
  emptyAddDraft,
  type AddDraft,
  type CfgDraft,
} from '../../settings-models/useModelProfilesState';

export { useModelProfilesState as useModelsSettings, PRESETS, emptyAddDraft };
export type { AddDraft, CfgDraft };
