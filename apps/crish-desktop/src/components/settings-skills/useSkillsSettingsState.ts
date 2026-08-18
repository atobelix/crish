import { useRef } from 'react';
import type {
  SharedSkillApi,
  ScopeFilter,
  SkillScope,
  CreateMode,
  BatchConfirm,
  DiscoverPick,
} from './skillsSettingsTypes';

// 类型与常量、纯函数 re-export（消费方 import 路径不变）
export {
  ACTIVATION_OPTIONS,
  ACTIVATION_LABEL,
  EMPTY_INSTALL_HINT,
  EMPTY_FILTER_HINT,
  SCOPE_ALL,
  SCOPE_GLOBAL,
  errText,
  scopeGroupLabel,
  skillSlashCmd,
} from './skillsSettingsTypes';
export type {
  ScopeFilter,
  SkillScope,
  CreateMode,
  BatchConfirm,
  DiscoverPick,
} from './skillsSettingsTypes';

import { useSkillList } from './useSkillList';
import { useSkillDirectories } from './useSkillDirectories';
import { useSkillEditor } from './useSkillEditor';

// 跨子 hook 共享 API：用 ref 容器在 render 阶段由各子 hook 写入最新 setter，
// 斩断 list ↔ directories ↔ editor 的循环依赖。
type SkillApiRef = SharedSkillApi & {
  setBusyId: (val: string | null | ((prev: string | null) => string | null)) => void;
};

function useSkillApiRef(): SkillApiRef {
  const ref = useRef<SkillApiRef>(null);
  if (ref.current === null) {
    ref.current = {
      setExtraDirs: () => {},
      setDiscoverCandidates: () => {},
      setDiscoverPick: () => {},
      setCreateMode: () => {},
      setExtraOpen: () => {},
      setSkills: () => {},
      setSelectedId: () => {},
      setBusyId: () => {},
      refresh: () => Promise.resolve(),
    };
  }
  return ref.current;
}

export function useSkillsSettingsState() {
  const api = useSkillApiRef();

  const list = useSkillList(api);
  const dirs = useSkillDirectories(api);
  const editor = useSkillEditor({ selected: list.selected }, api);

  return {
    // useSkillList
    skills: list.skills,
    loading: list.loading,
    loadError: list.loadError,
    selectedId: list.selectedId,
    setSelectedId: list.setSelectedId,
    selected: list.selected,
    filter: list.filter,
    setFilter: list.setFilter,
    scopeFilter: list.scopeFilter,
    setScopeFilter: list.setScopeFilter,
    scopeProjects: list.scopeProjects,
    fsOk: list.fsOk,
    enableCommands: list.enableCommands,
    setEnableCommands: list.setEnableCommands,
    busyId: list.busyId,
    batchBusy: list.batchBusy,
    batchConfirm: list.batchConfirm,
    syncBusy: list.syncBusy,
    activeScopeProjectName: list.activeScopeProjectName,
    scopeSelectOptions: list.scopeSelectOptions,
    filtered: list.filtered,
    grouped: list.grouped,
    batchEnableCount: list.batchEnableCount,
    batchDisableCount: list.batchDisableCount,
    refresh: list.refresh,
    handleScopeFilterChange: list.handleScopeFilterChange,
    clearFilters: list.clearFilters,
    setActivation: list.setActivation,
    runBatchActivation: list.runBatchActivation,
    handleSyncAll: list.handleSyncAll,
    // useSkillDirectories
    extraDir: dirs.extraDir,
    setExtraDir: dirs.setExtraDir,
    extraDirs: dirs.extraDirs,
    commitExtraDir: dirs.commitExtraDir,
    handlePickExtra: dirs.handlePickExtra,
    handleRemoveExtra: dirs.handleRemoveExtra,
    discoverCandidates: dirs.discoverCandidates,
    discoverPick: dirs.discoverPick,
    setDiscoverPick: dirs.setDiscoverPick,
    discoverBusy: dirs.discoverBusy,
    applyDiscoverImport: dirs.applyDiscoverImport,
    handleImportBrowse: dirs.handleImportBrowse,
    // useSkillEditor
    createMode: editor.createMode,
    setCreateMode: editor.setCreateMode,
    createName: editor.createName,
    setCreateName: editor.setCreateName,
    createDesc: editor.createDesc,
    setCreateDesc: editor.setCreateDesc,
    createBusy: editor.createBusy,
    handleCreate: editor.handleCreate,
    handleAiCreateSkill: editor.handleAiCreateSkill,
    showRaw: editor.showRaw,
    setShowRaw: editor.setShowRaw,
    previewHtml: editor.previewHtml,
    selectedSlash: editor.selectedSlash,
    copySlashCommand: editor.copySlashCommand,
    moreOpen: editor.moreOpen,
    setMoreOpen: editor.setMoreOpen,
    extraOpen: editor.extraOpen,
    setExtraOpen: editor.setExtraOpen,
  };
}
