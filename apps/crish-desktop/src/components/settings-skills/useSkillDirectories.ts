import { useState } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { t } from '../../i18n';
import {
  addExtraSkillDir,
  getExtraSkillDirs,
  pickSkillDirectory,
  removeExtraSkillDir,
  setSkillActivation,
  type DesktopSkill,
} from '../../api/skillsApi';
import { errText, type ScopeFilter, type Setter } from './skillsSettingsTypes';

export interface UseSkillDirectoriesApi {
  setExtraDirs: Setter<string[]>;
  setDiscoverCandidates: Setter<DesktopSkill[] | null>;
  setDiscoverPick: Setter<Record<string, boolean>>;
  setCreateMode: Setter<'none' | 'paths' | 'manual'>;
  setExtraOpen: Setter<boolean>;
  refresh: (opts?: {
    promptNew?: boolean;
    scope?: ScopeFilter;
  }) => Promise<void>;
}

export function useSkillDirectories(api: UseSkillDirectoriesApi) {
  const [extraDir, setExtraDir] = useState('');
  const [extraDirs, setExtraDirsInternal] = useState<string[]>(() => {
    try {
      return getExtraSkillDirs();
    } catch {
      return [];
    }
  });
  const [discoverCandidates, setDiscoverCandidatesInternal] = useState<
    DesktopSkill[] | null
  >(null);
  const [discoverPick, setDiscoverPickInternal] = useState<
    Record<string, boolean>
  >({});
  const [discoverBusy, setDiscoverBusy] = useState(false);

  // 同步到共享 API：让 useSkillList.refresh 能读取最新状态。
  // 在 render 阶段写入 ref，符合 React 安全模型（render 必须纯，写 ref 是允许的）。
  api.setExtraDirs = setExtraDirsInternal;
  api.setDiscoverCandidates = setDiscoverCandidatesInternal;
  api.setDiscoverPick = setDiscoverPickInternal;

  const commitExtraDir = (raw: string) => {
    const dir = raw.trim();
    if (!dir) return;
    try {
      addExtraSkillDir(dir);
      setExtraDir('');
      setExtraDirsInternal(getExtraSkillDirs());
      void api.refresh();
    } catch (e) {
      toast.show(t('settings.skills.addDirFailed', { detail: errText(e) }));
    }
  };

  const handlePickExtra = async () => {
    try {
      const dir = await pickSkillDirectory();
      if (!dir) return;
      commitExtraDir(dir);
    } catch (e) {
      toast.show(t('settings.skills.pickDirFailed', { detail: errText(e) }));
    }
  };

  const handleRemoveExtra = (d: string) => {
    try {
      removeExtraSkillDir(d);
      setExtraDirsInternal(getExtraSkillDirs());
      void api.refresh();
    } catch (e) {
      toast.show(t('settings.skills.removeDirFailed', { detail: errText(e) }));
    }
  };

  const applyDiscoverImport = async (mode: 'selected' | 'all' | 'skip') => {
    if (!discoverCandidates) {
      setDiscoverCandidatesInternal(null);
      return;
    }
    if (mode === 'skip') {
      setDiscoverCandidatesInternal(null);
      return;
    }
    const targets =
      mode === 'all'
        ? discoverCandidates
        : discoverCandidates.filter((s) => discoverPick[s.id]);
    if (targets.length === 0) {
      setDiscoverCandidatesInternal(null);
      return;
    }
    setDiscoverBusy(true);
    let fail = 0;
    try {
      for (const s of targets) {
        try {
          await setSkillActivation(s, 'enabled');
        } catch {
          fail += 1;
        }
      }
      setDiscoverCandidatesInternal(null);
      await api.refresh();
      if (fail > 0) {
        toast.show(
          fail === targets.length
            ? t('settings.skills.importFailedAll', { count: fail })
            : t('settings.skills.importFailedPartial', {
                fail,
                total: targets.length,
              })
        );
      }
    } finally {
      setDiscoverBusy(false);
    }
  };

  const handleImportBrowse = async () => {
    try {
      const dir = await pickSkillDirectory();
      if (!dir) return;
      commitExtraDir(dir);
      api.setCreateMode('none');
      api.setExtraOpen(true);
      await api.refresh();
    } catch (e) {
      toast.show(t('settings.skills.importFailed', { detail: errText(e) }));
    }
  };

  return {
    extraDir,
    setExtraDir,
    extraDirs,
    commitExtraDir,
    handlePickExtra,
    handleRemoveExtra,
    discoverCandidates,
    discoverPick,
    setDiscoverPick: setDiscoverPickInternal,
    discoverBusy,
    applyDiscoverImport,
    handleImportBrowse,
  };
}

export type UseSkillDirectoriesReturn = ReturnType<typeof useSkillDirectories>;
