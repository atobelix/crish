import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addExtraSkillDir,
  createProjectSkill,
  discoverSkills,
  getExtraSkillDirs,
  invalidateSkillSlashCache,
  pickSkillDirectory,
  removeExtraSkillDir,
  setSkillActivation,
  skillsFsAvailable,
  syncSkillsToDaemon,
  type DesktopSkill,
  type SkillActivation,
} from '../../api/skillsApi';
import { skillStableId } from '../../api/skillId';
import {
  getWorkspacePath,
  listSettingsScopeProjects,
  projectFolderLabel,
} from '../../api/projectStore';
import { parseMarkdownToHtml } from '../../api/markdownRender';
import { clientApi } from '../../api/clientApi';
import { setComposerSeed } from '../../api/composerSeed';
import { emitUiEvent } from '../../api/uiEvents';
import { formatEngineDegradeToast } from '../../hooks/useToastQueue';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import { closeSettings } from '../../api/store-access/componentAccess';

export const ACTIVATION_OPTIONS: { id: SkillActivation; label: string }[] = [
  { id: 'enabled', label: '启用' },
  { id: 'recommended', label: '推荐' },
  { id: 'disabled', label: '禁用' },
];

export const ACTIVATION_LABEL: Record<SkillActivation, string> = {
  enabled: '启用',
  recommended: '推荐',
  disabled: '禁用',
};

export const EMPTY_INSTALL_HINT =
  '可放在项目 .conex/skills/、~/.codex/skills/、~/.claude/skills/，或下方添加额外目录';
export const EMPTY_FILTER_HINT = '当前筛选无匹配技能，可清除筛选或调整条件';

export type ScopeFilter = string;
export type SkillScope = string;
export type CreateMode = 'global' | 'project';
export type BatchConfirm = { action: 'enable' | 'disable' | 'delete'; count: number } | null;
export type DiscoverPick = { dir: string; name: string } | null;
export { formatEngineDegradeToast } from '../../hooks/useToastQueue';
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
export const SCOPE_ALL = 'all';
export const SCOPE_GLOBAL = 'global';

export function scopeGroupLabel(scope: string, projectName: string): string {
  if (scope === 'global') return '全局';
  if (scope === 'workspace') return projectName || '工作区';
  if (scope === 'project') return projectName || '当前项目';
  return scope;
}

export function skillSlashCmd(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `/skill:${slug || name.trim()}`;
}


export function useSkillsSettingsState(onShowToast?: (msg: string) => void) {
  const [listState, setListState] = useState<{
    skills: DesktopSkill[];
    loading: boolean;
    loadError: string | null;
    selectedId: string | null;
    fsOk: boolean;
    enableCommands: boolean;
  }>({
    skills: [],
    loading: true,
    loadError: null,
    selectedId: null,
    fsOk: true,
    enableCommands: true,
  });

  const skills = listState.skills;
  const loading = listState.loading;
  const loadError = listState.loadError;
  const selectedId = listState.selectedId;
  const fsOk = listState.fsOk;
  const enableCommands = listState.enableCommands;

  const setSkills = (val: React.SetStateAction<DesktopSkill[]>) =>
    setListState((prev) => ({ ...prev, skills: typeof val === 'function' ? val(prev.skills) : val }));
  const setLoading = (val: React.SetStateAction<boolean>) =>
    setListState((prev) => ({ ...prev, loading: typeof val === 'function' ? val(prev.loading) : val }));
  const setLoadError = (val: React.SetStateAction<string | null>) =>
    setListState((prev) => ({ ...prev, loadError: typeof val === 'function' ? val(prev.loadError) : val }));
  const setSelectedId = (val: React.SetStateAction<string | null>) =>
    setListState((prev) => ({ ...prev, selectedId: typeof val === 'function' ? val(prev.selectedId) : val }));
  const setFsOk = (val: React.SetStateAction<boolean>) =>
    setListState((prev) => ({ ...prev, fsOk: typeof val === 'function' ? val(prev.fsOk) : val }));
  const setEnableCommands = (val: React.SetStateAction<boolean>) =>
    setListState((prev) => ({ ...prev, enableCommands: typeof val === 'function' ? val(prev.enableCommands) : val }));

  const [filterState, setFilterState] = useState<{
    filter: string;
    scopeFilter: ScopeFilter;
    scopeProjects: ReturnType<typeof listSettingsScopeProjects>;
    extraDir: string;
    extraDirs: string[];
  }>(() => ({
    filter: '',
    scopeFilter: SCOPE_ALL,
    scopeProjects: listSettingsScopeProjects(),
    extraDir: '',
    extraDirs: (() => {
      try {
        return getExtraSkillDirs();
      } catch {
        return [];
      }
    })(),
  }));

  const filter = filterState.filter;
  const scopeFilter = filterState.scopeFilter;
  const scopeProjects = filterState.scopeProjects;
  const extraDir = filterState.extraDir;
  const extraDirs = filterState.extraDirs;

  const scopeFilterRef = useRef(scopeFilter);
  scopeFilterRef.current = scopeFilter;

  const setFilter = (val: React.SetStateAction<string>) =>
    setFilterState((prev) => ({ ...prev, filter: typeof val === 'function' ? val(prev.filter) : val }));
  const setScopeFilter = (val: React.SetStateAction<ScopeFilter>) =>
    setFilterState((prev) => ({ ...prev, scopeFilter: typeof val === 'function' ? val(prev.scopeFilter) : val }));
  const setScopeProjects = (val: React.SetStateAction<ReturnType<typeof listSettingsScopeProjects>>) =>
    setFilterState((prev) => ({ ...prev, scopeProjects: typeof val === 'function' ? val(prev.scopeProjects) : val }));
  const setExtraDir = (val: React.SetStateAction<string>) =>
    setFilterState((prev) => ({ ...prev, extraDir: typeof val === 'function' ? val(prev.extraDir) : val }));
  const setExtraDirs = (val: React.SetStateAction<string[]>) =>
    setFilterState((prev) => ({ ...prev, extraDirs: typeof val === 'function' ? val(prev.extraDirs) : val }));

  const [actionState, setActionState] = useState<{
    busyId: string | null;
    showRaw: boolean;
    createMode: 'none' | 'paths' | 'manual';
    createName: string;
    createDesc: string;
    createBusy: boolean;
    syncBusy: boolean;
    batchBusy: boolean;
    discoverBusy: boolean;
    batchConfirm: 'enabled' | 'disabled' | null;
    discoverCandidates: DesktopSkill[] | null;
    discoverPick: Record<string, boolean>;
    moreOpen: boolean;
    extraOpen: boolean;
  }>({
    busyId: null,
    showRaw: false,
    createMode: 'none',
    createName: '',
    createDesc: '',
    createBusy: false,
    syncBusy: false,
    batchBusy: false,
    discoverBusy: false,
    batchConfirm: null,
    discoverCandidates: null,
    discoverPick: {},
    moreOpen: false,
    extraOpen: false,
  });

  const busyId = actionState.busyId;
  const showRaw = actionState.showRaw;
  const createMode = actionState.createMode;
  const createName = actionState.createName;
  const createDesc = actionState.createDesc;
  const createBusy = actionState.createBusy;
  const syncBusy = actionState.syncBusy;
  const batchBusy = actionState.batchBusy;
  const discoverBusy = actionState.discoverBusy;
  const batchConfirm = actionState.batchConfirm;
  const discoverCandidates = actionState.discoverCandidates;
  const discoverPick = actionState.discoverPick;
  const moreOpen = actionState.moreOpen;
  const extraOpen = actionState.extraOpen;

  const setBusyId = (val: React.SetStateAction<string | null>) =>
    setActionState((prev) => ({ ...prev, busyId: typeof val === 'function' ? val(prev.busyId) : val }));
  const setShowRaw = (val: React.SetStateAction<boolean>) =>
    setActionState((prev) => ({ ...prev, showRaw: typeof val === 'function' ? val(prev.showRaw) : val }));
  const setCreateMode = (val: React.SetStateAction<'none' | 'paths' | 'manual'>) =>
    setActionState((prev) => ({ ...prev, createMode: typeof val === 'function' ? val(prev.createMode) : val }));
  const setCreateName = (val: React.SetStateAction<string>) =>
    setActionState((prev) => ({ ...prev, createName: typeof val === 'function' ? val(prev.createName) : val }));
  const setCreateDesc = (val: React.SetStateAction<string>) =>
    setActionState((prev) => ({ ...prev, createDesc: typeof val === 'function' ? val(prev.createDesc) : val }));
  const setCreateBusy = (val: React.SetStateAction<boolean>) =>
    setActionState((prev) => ({ ...prev, createBusy: typeof val === 'function' ? val(prev.createBusy) : val }));
  const setSyncBusy = (val: React.SetStateAction<boolean>) =>
    setActionState((prev) => ({ ...prev, syncBusy: typeof val === 'function' ? val(prev.syncBusy) : val }));
  const setBatchBusy = (val: React.SetStateAction<boolean>) =>
    setActionState((prev) => ({ ...prev, batchBusy: typeof val === 'function' ? val(prev.batchBusy) : val }));
  const setDiscoverBusy = (val: React.SetStateAction<boolean>) =>
    setActionState((prev) => ({ ...prev, discoverBusy: typeof val === 'function' ? val(prev.discoverBusy) : val }));
  const setBatchConfirm = (val: React.SetStateAction<'enabled' | 'disabled' | null>) =>
    setActionState((prev) => ({ ...prev, batchConfirm: typeof val === 'function' ? val(prev.batchConfirm) : val }));
  const setDiscoverCandidates = (val: React.SetStateAction<DesktopSkill[] | null>) =>
    setActionState((prev) => ({ ...prev, discoverCandidates: typeof val === 'function' ? val(prev.discoverCandidates) : val }));
  const setDiscoverPick = (val: React.SetStateAction<Record<string, boolean>>) =>
    setActionState((prev) => ({ ...prev, discoverPick: typeof val === 'function' ? val(prev.discoverPick) : val }));
  const setMoreOpen = (val: React.SetStateAction<boolean>) =>
    setActionState((prev) => ({ ...prev, moreOpen: typeof val === 'function' ? val(prev.moreOpen) : val }));
  const setExtraOpen = (val: React.SetStateAction<boolean>) =>
    setActionState((prev) => ({ ...prev, extraOpen: typeof val === 'function' ? val(prev.extraOpen) : val }));

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) || null,
    [skills, selectedId],
  );

  const knownIdsKey = 'crish_skill_known_ids_v1';
  const loadKnownIds = (): Set<string> => {
    try {
      const raw = localStorage.getItem(knownIdsKey);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.map(String) : []);
    } catch {
      return new Set();
    }
  };

  const saveKnownIds = (ids: Set<string>) => {
    try {
      localStorage.setItem(knownIdsKey, JSON.stringify([...ids]));
    } catch {
      /* quota / private mode */
    }
  };

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
        setExtraDirs(getExtraSkillDirs());
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
            setDiscoverCandidates(fresh);
            const pick: Record<string, boolean> = {};
            for (const s of fresh) pick[s.id] = true;
            setDiscoverPick(pick);
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
        onShowToast?.(msg);
      } finally {
        setLoading(false);
      }
    },
    [onShowToast, resolveDiscoverWorkspace],
  );

  const applyDiscoverImport = async (mode: 'selected' | 'all' | 'skip') => {
    if (!discoverCandidates) {
      setDiscoverCandidates(null);
      return;
    }
    if (mode === 'skip') {
      setDiscoverCandidates(null);
      return;
    }
    const targets =
      mode === 'all'
        ? discoverCandidates
        : discoverCandidates.filter((s) => discoverPick[s.id]);
    if (targets.length === 0) {
      setDiscoverCandidates(null);
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
      setDiscoverCandidates(null);
      await refresh();
      if (fail > 0) {
        onShowToast?.(
          fail === targets.length
            ? `导入失败：全部 ${fail} 个未能启用`
            : `导入部分失败：${fail}/${targets.length}`,
        );
      }
    } finally {
      setDiscoverBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const activeScopeProjectName = useMemo(() => {
    if (scopeFilter === SCOPE_ALL || scopeFilter === SCOPE_GLOBAL) {
      const cwd = getWorkspacePath();
      return cwd ? projectFolderLabel(cwd) : '';
    }
    const hit = scopeProjects.find(
      (p) =>
        p.path.replace(/\\/g, '/').toLowerCase() ===
        scopeFilter.replace(/\\/g, '/').toLowerCase(),
    );
    return hit?.name || projectFolderLabel(scopeFilter);
  }, [scopeFilter, scopeProjects]);

  const scopeSelectOptions = useMemo(() => {
    const opts: { value: string; label: string; hint?: string }[] = [
      { value: SCOPE_ALL, label: '全部', hint: '当前工作区 + 全局' },
      { value: SCOPE_GLOBAL, label: '全局', hint: '用户目录技能' },
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

  useEffect(() => {
    const sync = () => setScopeProjects(listSettingsScopeProjects());
    sync();
    window.addEventListener('crish-project-changed', sync);
    return () => window.removeEventListener('crish-project-changed', sync);
  }, []);

  const handleScopeFilterChange = (value: string) => {
    setScopeFilter(value);
    void refresh({ scope: value });
  };

  const setActivation = async (skill: DesktopSkill, activation: SkillActivation) => {
    if (skill.activation === activation) return;
    setBusyId(skill.id);
    try {
      const r = await setSkillActivation(skill, activation);
      setSkills((list) =>
        list.map((s) => (s.id === skill.id ? { ...s, activation } : s)),
      );
      invalidateSkillSlashCache();
      if (!r.engineSynced) {
        onShowToast?.(formatEngineDegradeToast(r.error));
      }
    } catch (e) {
      onShowToast?.(`更新失败：${errText(e)}`);
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
            list.map((x) => (x.id === s.id ? { ...x, activation } : x)),
          );
        } catch {
          fail += 1;
        }
      }
      invalidateSkillSlashCache();
      if (fail > 0) {
        onShowToast?.(
          fail === targets.length
            ? `${label}失败：全部 ${fail} 个`
            : `${label}部分失败：${fail}/${targets.length}`,
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
        onShowToast?.(
          r.ok === 0
            ? `同步失败：全部 ${r.fail} 个`
            : `同步部分失败：${r.fail}/${r.ok + r.fail}`,
        );
      }
    } catch (e) {
      onShowToast?.(`同步失败：${errText(e)}`);
    } finally {
      setSyncBusy(false);
    }
  };

  const commitExtraDir = (raw: string) => {
    const dir = raw.trim();
    if (!dir) return;
    try {
      addExtraSkillDir(dir);
      setExtraDir('');
      setExtraDirs(getExtraSkillDirs());
      void refresh();
    } catch (e) {
      onShowToast?.(`添加目录失败：${errText(e)}`);
    }
  };

  const handlePickExtra = async () => {
    try {
      const dir = await pickSkillDirectory();
      if (!dir) return;
      commitExtraDir(dir);
    } catch (e) {
      onShowToast?.(`选择目录失败：${errText(e)}`);
    }
  };

  const handleRemoveExtra = (d: string) => {
    try {
      removeExtraSkillDir(d);
      setExtraDirs(getExtraSkillDirs());
      void refresh();
    } catch (e) {
      onShowToast?.(`移除目录失败：${errText(e)}`);
    }
  };

  const handleCreate = async () => {
    if (!createName.trim() || createBusy) return;
    setCreateBusy(true);
    try {
      const r = await createProjectSkill({
        name: createName.trim(),
        ...(createDesc.trim() ? { description: createDesc.trim() } : {}),
        workspacePath: getWorkspacePath(),
      });
      if (r.ok === false) {
        onShowToast?.(r.error || '创建技能失败');
        return;
      }
      const slug = createName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const selectId = skillStableId(slug || createName.trim(), r.skillPath);
      setCreateMode('none');
      setCreateName('');
      setCreateDesc('');
      await refresh();
      setSelectedId(selectId);
    } catch (e) {
      onShowToast?.(`创建技能失败：${errText(e)}`);
    } finally {
      setCreateBusy(false);
    }
  };

  const handleImportBrowse = async () => {
    try {
      const dir = await pickSkillDirectory();
      if (!dir) return;
      commitExtraDir(dir);
      setCreateMode('none');
      setExtraOpen(true);
      await refresh();
    } catch (e) {
      onShowToast?.(`导入失败：${errText(e)}`);
    }
  };

  const handleAiCreateSkill = () => {
    setComposerSeed(
      [
        '请帮我创建一个 Crish 技能（正式 SKILL.md）。',
        '需要：用途说明、适用场景、主要步骤，以及可直接保存的完整 SKILL.md 内容（含 frontmatter）。',
        '我打算用它来：',
      ].join('\n'),
    );
    setCreateMode('none');
    closeSettings();
    emitUiEvent('open-chat');
  };

  const copySlashCommand = async (name: string) => {
    const cmd = skillSlashCmd(name);
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      onShowToast?.('复制失败');
    }
  };

  const previewHtml = useMemo(() => {
    if (!selected) return '';
    if (showRaw) return '';
    const md = `# ${selected.name}\n\n> ${selected.description}\n\n${selected.content || '_（无正文）_'}`;
    return parseMarkdownToHtml(md);
  }, [selected, showRaw]);

  const selectedSlash = selected ? skillSlashCmd(selected.name) : '';
  const batchEnableCount = filtered.filter((s) => s.activation !== 'enabled').length;
  const batchDisableCount = filtered.filter((s) => s.activation !== 'disabled').length;

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
    extraDir,
    setExtraDir,
    extraDirs,
    fsOk,
    enableCommands,
    setEnableCommands,
    busyId,
    showRaw,
    setShowRaw,
    createMode,
    setCreateMode,
    createName,
    setCreateName,
    createDesc,
    setCreateDesc,
    createBusy,
    syncBusy,
    batchBusy,
    discoverBusy,
    batchConfirm,
    discoverCandidates,
    discoverPick,
    setDiscoverPick,
    moreOpen,
    setMoreOpen,
    extraOpen,
    setExtraOpen,
    activeScopeProjectName,
    scopeSelectOptions,
    filtered,
    grouped,
    previewHtml,
    selectedSlash,
    batchEnableCount,
    batchDisableCount,
    refresh,
    applyDiscoverImport,
    handleScopeFilterChange,
    setActivation,
    runBatchActivation,
    handleSyncAll,
    commitExtraDir,
    handlePickExtra,
    handleRemoveExtra,
    handleCreate,
    handleImportBrowse,
    handleAiCreateSkill,
    copySlashCommand,
    clearFilters,
  };
}
