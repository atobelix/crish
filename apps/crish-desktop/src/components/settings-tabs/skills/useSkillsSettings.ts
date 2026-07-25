/**
 * Hook for managing skills settings state.
 */
import {
  useSkillsSettingsState,
  errText,
  skillSlashCmd,
  scopeGroupLabel,
  formatEngineDegradeToast,
  type SkillScope,
  type CreateMode,
  type BatchConfirm,
  type DiscoverPick,
} from '../../settings-skills/useSkillsSettingsState';

export {
  useSkillsSettingsState as useSkillsSettings,
  errText,
  skillSlashCmd,
  scopeGroupLabel,
  formatEngineDegradeToast,
};
export type { SkillScope, CreateMode, BatchConfirm, DiscoverPick };
