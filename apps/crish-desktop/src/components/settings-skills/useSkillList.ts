import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../services/toast/ToastContext';
import {
  discoverSkills,
  getExtraSkillDirs,
  invalidateSkillSlashCache,
  setSkillActivation,
  skillsFsAvailable,
  syncSkillsToDaemon,
  type DesktopSkill,
  type SkillActivation,
} from '../../api/skillsApi';
import {
  getWorkspacePath,
  listSettingsScopeProjects,
  projectFolderLabel,
} from '../../api/projectStore';
import { clientApi } from '../../api/clientApi';
import { formatEngineDegradeToast } from '../../hooks/useToastQueue';
import {
  ACTIVATION_LABEL,
  SCOPE_ALL,
  SCOPE_GLOBAL,
  errText,
  type ScopeFilter,
  type Setter,
} from './skillsSettingsTypes';
import type { SharedSkillApi } from './skillsSettingsTypes';

import {
  readSkillKnownIds,
  writeSkillKnownIds,
} from '../../api/cache/runtimeCache';

function loadKnownIds(): Set<string> {
  return readSkillKnownIds();
}

function saveKnownIds(ids: Set<string>): void {
  writeSkillKnownIds(ids);
}

export interface UseSkillListApi {
  setBusyId: Setter<string | null>;
}

export function useSkillList(api: SharedSkillApi & UseSkillListApi) {
  const [skills, setSkills] = useState<DesktopSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fsOk, setFsOk] = useState(true);
  const [enableCommands, setEnableCommands] = useState(true);

  const [filter, setFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>(SCOPE_ALL);
  const [scopeProjects, setScopeProjects] = useState(() =>
    listSettingsScopeProjects()
  );

  const [batchBusy, setBatchBusy] = useState(false);
  const [batchConfirm, setBatchConfirm] = useState<
    'enabled' | 'disabled' | null
  >(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const scopeFilterRef = useRef(scopeFilter);
  scopeFilterRef.current = scopeFilter;

  // 共享 setter 给 hub，让 useSkillDirectories 能消费。
  api.setSkills = setSkills;
  api.setSelectedId = setSelectedId;
  api.setBusyId = setBusyId;

  const resolveDiscoverWorkspace = useCallback((scope: ScopeFilter): string => {
    if (scope === SCOPE_ALL || scope === SCOPE_GLOBAL) {
      return getWorkspacePath() || '';
    }
    return scope;
  }, []);

  const refresh = useCallback(
    async (opts?: { promptNew?: boolean; scope?: ScopeFilter }) => {
      const scope = opts?.scope ?? scopeFilterRef.current;
      setLoading(true);
      try {
        setFsOk(await skillsFsAvailable());
        const ws = resolveDiscoverWorkspace(scope);
        const res = await discoverSkills({ workspacePath: ws });
        setSkills(res.skills);
        api.setExtraDirs(
          (() => {
            try {
              return getExtraSkillDirs();
            } catch {
              return [];
            }
          })()
        );
        invalidateSkillSlashCache();
        setLoadError(null);
        setSelectedId((prev) => {
          if (prev && res.skills.some((s) => s.id === prev)) return prev;
          return res.skills[0]?.id ?? null;
        });
        if (opts?.promptNew) {
          const known = loadKnownIds();
          const fresh = res.skills.filter((s) => !known.has(s.id));
          if (fresh.length > 0) {
            api.setDiscoverCandidates(fresh);
            const pick: Record<string, boolean> = {};
            for (const s of fresh) pick[s.id] = true;
            api.setDiscoverPick(pick);
          }
        }
        const all = loadKnownIds();
        for (const s of res.skills) all.add(s.id);
        saveKnownIds(all);
        try {
          const settings = await clientApi.getSettings();
          setEnableCommands(settings?.enableSkillCommands !== false);
        } catch {
          /* ignore */
        }
      } catch (e) {
        const msg = `扫描技能失败：${errText(e)}`;
        setLoadError(msg);
        toast.show(msg);
      } finally {
        setLoading(false);
      }
    },
    [resolveDiscoverWorkspace, api]
  );

  api.refresh = refresh;

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) || null,
    [skills, selectedId]
  );

  const activeScopeProjectName = useMemo(() => {
    if (scopeFilter === SCOPE_ALL || scopeFilter === SCOPE_GLOBAL) {
      const cwd = getWorkspacePath();
      return cwd ? projectFolderLabel(cwd) : '';
    }
    const hit = scopeProjects.find(
      (p) =>
        p.path.replace(/\\/g, '/').toLowerCase() ===
        scopeFilter.replace(/\\/g, '/').toLowerCase()
    );
    return hit?.name || projectFolderLabel(scopeFilter);
  }, [scopeFilter, scopeProjects]);

  const scopeSelectOptions = useMemo(() => {
    const opts: { value: string; label: string; hint?: string }[] = [
      { value: SCOPE_ALL, label: '全部' },
      { value: SCOPE_GLOBAL, label: '全局' },
    ];
    for (const p of scopeProjects) {
      opts.push({
        value: p.path,
        label: p.name || projectFolderLabel(p.path),
        hint: p.path,
      });
    }
    return opts;
  }, [scopeProjects]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return skills.filter((s) => {
      if (scopeFilter === SCOPE_GLOBAL && s.scope !== 'global') return false;
      if (
        scopeFilter !== SCOPE_ALL &&
        scopeFilter !== SCOPE_GLOBAL &&
        s.scope === 'global'
      ) {
        return false;
      }
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)) ||
        s.filePath.toLowerCase().includes(q)
      );
    });
  }, [skills, filter, scopeFilter]);

  const grouped = useMemo(() => {
    const order: Array<'project' | 'workspace' | 'global'> = [
      'project',
      'workspace',
      'global',
    ];
    const map = new Map<string, DesktopSkill[]>();
    for (const s of filtered) {
      const list = map.get(s.scope) || [];
      list.push(s);
      map.set(s.scope, list);
    }
    return order
      .filter((k) => (map.get(k) || []).length > 0)
      .map((k) => ({ scope: k, items: map.get(k)! }));
  }, [filtered]);

  const clearFilters = () => {
    setFilter('');
    setScopeFilter(SCOPE_ALL);
    void refresh({ scope: SCOPE_ALL });
  };

  const handleScopeFilterChange = (value: string) => {
    setScopeFilter(value);
    void refresh({ scope: value });
  };

  const setActivation = async (
    skill: DesktopSkill,
    activation: SkillActivation
  ) => {
    if (skill.activation === activation) return;
    setBusyId(skill.id);
    try {
      const r = await setSkillActivation(skill, activation);
      setSkills((list) =>
        list.map((s) => (s.id === skill.id ? { ...s, activation } : s))
      );
      invalidateSkillSlashCache();
      if (!r.engineSynced) {
        toast.show(formatEngineDegradeToast(r.error));
      }
    } catch (e) {
      toast.show(`更新失败：${errText(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const runBatchActivation = async (activation: 'enabled' | 'disabled') => {
    const targets = filtered.filter((s) => s.activation !== activation);
    if (targets.length === 0) {
      setBatchConfirm(null);
      return;
    }
    if (batchConfirm !== activation) {
      setBatchConfirm(activation);
      return;
    }
    setBatchConfirm(null);
    setBatchBusy(true);
    let fail = 0;
    const label = ACTIVATION_LABEL[activation];
    try {
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i]!;
        try {
          await setSkillActivation(s, activation);
          setSkills((list) =>
            list.map((x) => (x.id === s.id ? { ...x, activation } : x))
          );
        } catch {
          fail += 1;
        }
      }
      invalidateSkillSlashCache();
      if (fail > 0) {
        toast.show(
          fail === targets.length
            ? `${label}失败：全部 ${fail} 个`
            : `${label}部分失败：${fail}/${targets.length}`
        );
      }
    } finally {
      setBatchBusy(false);
    }
  };

  const handleSyncAll = async () => {
    if (skills.length === 0) return;
    setSyncBusy(true);
    try {
      const r = await syncSkillsToDaemon(skills);
      if (r.fail > 0) {
        toast.show(
          r.ok === 0
            ? `同步失败：全部 ${r.fail} 个`
            : `同步部分失败：${r.fail}/${r.ok + r.fail}`
        );
      }
    } catch (e) {
      toast.show(`同步失败：${errText(e)}`);
    } finally {
      setSyncBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const sync = () => setScopeProjects(listSettingsScopeProjects());
    sync();
    window.addEventListener('crish-project-changed', sync);
    return () => window.removeEventListener('crish-project-changed', sync);
  }, []);

  const batchEnableCount = filtered.filter(
    (s) => s.activation !== 'enabled'
  ).length;
  const batchDisableCount = filtered.filter(
    (s) => s.activation !== 'disabled'
  ).length;

  return {
    skills,
    loading,
    loadError,
    selectedId,
    setSelectedId,
    selected,
    filter,
    setFilter,
    scopeFilter,
    setScopeFilter,
    scopeProjects,
    fsOk,
    enableCommands,
    setEnableCommands,
    busyId,
    batchBusy,
    batchConfirm,
    syncBusy,
    activeScopeProjectName,
    scopeSelectOptions,
    filtered,
    grouped,
    batchEnableCount,
    batchDisableCount,
    refresh,
    handleScopeFilterChange,
    clearFilters,
    setActivation,
    runBatchActivation,
    handleSyncAll,
  };
}

export type UseSkillListReturn = ReturnType<typeof useSkillList>;
