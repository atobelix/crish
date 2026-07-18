/**
 * 设置 · 技能：单行密度（发现 / 列表 / 预览 / 启用 / 创建）
 *
 * Toast 策略（与 useToastQueue 产品禁令一致）：
 * - 成功：列表状态 / 预览选中 / 表单收起即反馈，绝不 toast
 * - 扫描、启用、同步、创建、导入、复制、打开路径失败：toast
 * - 引擎未同步：formatEngineDegradeToast（先说问题）
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  addExtraSkillDir,
  createProjectSkill,
  discoverSkills,
  getExtraSkillDirs,
  invalidateSkillSlashCache,
  pickSkillDirectory,
  removeExtraSkillDir,
  revealSkillPath,
  setSkillActivation,
  skillsFsAvailable,
  syncSkillsToDaemon,
  type DesktopSkill,
  type SkillActivation,
} from '../api/skillsApi';
import { skillStableId } from '../api/skillId';
import {
  getWorkspacePath,
  listSettingsScopeProjects,
  projectFolderLabel,
} from '../api/projectStore';
import { parseMarkdownToHtml } from '../api/markdownRender';
import { clientApi } from '../api/clientApi';
import { setComposerSeed } from '../api/composerSeed';
import { emitUiEvent } from '../api/uiEvents';
import { formatEngineDegradeToast } from '../hooks/useToastQueue';
import { useLayoutStore } from '../store/layoutStore';
import { closeSettings } from '../store/settingsUiStore';
import { SettingsSelect } from './SettingsSelect';
import styles from './SkillsSettingsTab.module.css';
import { SettingsPage } from './settings/SettingsUI';

type Props = {
  onShowToast?: (msg: string) => void;
};

const ACTIVATION_OPTIONS: { id: SkillActivation; label: string }[] = [
  { id: 'enabled', label: '启用' },
  { id: 'recommended', label: '推荐' },
  { id: 'disabled', label: '禁用' },
];

const ACTIVATION_LABEL: Record<SkillActivation, string> = {
  enabled: '启用',
  recommended: '推荐',
  disabled: '禁用',
};

/** 列表分组标签：全局固定；项目用具体文件夹名 */
function scopeGroupLabel(scope: string, projectName: string): string {
  if (scope === 'global') return '全局';
  if (scope === 'workspace') return projectName || '工作区';
  if (scope === 'project') return projectName || '当前项目';
  return scope;
}

/** 真·空列表：安装路径提示（密度单行 + title 全文） */
const EMPTY_INSTALL_HINT =
  '可放在项目 .conex/skills/、~/.codex/skills/、~/.claude/skills/，或下方添加额外目录';
/** 筛选后无结果 */
const EMPTY_FILTER_HINT = '当前筛选无匹配技能，可清除筛选或调整条件';

/** 作用域：all | global | 具体项目绝对路径 */
type ScopeFilter = string;
const SCOPE_ALL = 'all';
const SCOPE_GLOBAL = 'global';

/** 与 skillsApi.normalizeSlashName 对齐（未导出） */
function skillSlashCmd(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `/skill:${slug || name.trim()}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const SkillsSettingsTab: React.FC<Props> = ({ onShowToast }) => {
  const [skills, setSkills] = useState<DesktopSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  /** all=当前工作区+全局；global=仅全局；其它=具体项目路径 */
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>(SCOPE_ALL);
  const [scopeProjects, setScopeProjects] = useState(() => listSettingsScopeProjects());
  const [extraDir, setExtraDir] = useState('');
  const [extraDirs, setExtraDirs] = useState<string[]>(() => {
    try {
      return getExtraSkillDirs();
    } catch {
      return [];
    }
  });
  const [fsOk, setFsOk] = useState(true);
  const [enableCommands, setEnableCommands] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  /** none | paths（双入口）| manual 手填（少用） */
  const [createMode, setCreateMode] = useState<'none' | 'paths' | 'manual'>('none');
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  /** 批量操作二次确认（无 browser alert；按钮 is-active 提示再点一次） */
  const [batchConfirm, setBatchConfirm] = useState<'enabled' | 'disabled' | null>(null);
  /** 自发现：尚未确认导入的技能（需用户同意） */
  const [discoverCandidates, setDiscoverCandidates] = useState<DesktopSkill[] | null>(null);
  const [discoverPick, setDiscoverPick] = useState<Record<string, boolean>>({});
  /** 低频操作（发现/刷新/全启/全禁）收进 ⋯ 菜单 */
  const [moreOpen, setMoreOpen] = useState(false);
  /** 额外目录默认折叠，避免空壳占满侧栏 */
  const [extraOpen, setExtraOpen] = useState(false);

  const titleId = useId();
  const listLabelId = useId();
  const createBoxId = useId();
  const createNameId = useId();
  const createDescId = useId();
  const extraDirId = useId();
  const discoverTitleId = useId();
  const searchId = useId();
  const moreMenuId = useId();

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

  /** 按作用域决定扫描哪个工作区：具体项目路径 or 当前 cwd */
  const resolveDiscoverWorkspace = useCallback((scope: ScopeFilter): string => {
    if (scope === SCOPE_ALL || scope === SCOPE_GLOBAL) {
      return getWorkspacePath() || '';
    }
    return scope;
  }, []);

  const refresh = useCallback(
    async (opts?: { promptNew?: boolean; scope?: ScopeFilter }) => {
      const scope = opts?.scope ?? scopeFilter;
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
        // 自发现：仅当明确请求时弹出，需用户同意才批量启用
        if (opts?.promptNew) {
          const known = loadKnownIds();
          const fresh = res.skills.filter((s) => !known.has(s.id));
          if (fresh.length > 0) {
            setDiscoverCandidates(fresh);
            const pick: Record<string, boolean> = {};
            for (const s of fresh) pick[s.id] = true;
            setDiscoverPick(pick);
          }
          // 无新项：列表不变即反馈，不 toast
        }
        // 登记当前全部 id（不含强制启用）
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
    [onShowToast, resolveDiscoverWorkspace, scopeFilter],
  );

  const applyDiscoverImport = async (mode: 'selected' | 'all' | 'skip') => {
    if (!discoverCandidates) {
      setDiscoverCandidates(null);
      return;
    }
    if (mode === 'skip') {
      setDiscoverCandidates(null);
      // 跳过成功：面板关闭即反馈
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
      // 成功：列表启用态即反馈
    } finally {
      setDiscoverBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 批量确认超时自动取消
  useEffect(() => {
    if (!batchConfirm) return;
    const t = window.setTimeout(() => setBatchConfirm(null), 4000);
    return () => window.clearTimeout(t);
  }, [batchConfirm]);

  /** 当前作用域对应的文件夹展示名 */
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
      // 具体项目：扫描已切到该路径，只保留项目/工作区技能
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

  // 项目列表与作用域切换时刷新
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
      if (!r.daemonSynced) {
        // 降级：先说问题；与规则页同源 formatEngineDegradeToast
        onShowToast?.(formatEngineDegradeToast(r.error));
      }
      // 成功：列表状态切换即反馈
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
    // 二次确认：首次仅标记 batchConfirm（按钮文案可反映），再次才执行
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
      // 成功：列表点态即反馈
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
      // 全成功：静默
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
      // 成功：目录出现在列表即反馈
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
        description: createDesc.trim() || undefined,
        workspacePath: getWorkspacePath(),
      });
      if (r.ok === false) {
        onShowToast?.(r.error || '创建技能失败');
        return;
      }
      // createProjectSkill writes frontmatter name as normalizeSlashName(opts.name)
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
      // 成功：表单收起 + 列表选中即反馈
    } catch (e) {
      onShowToast?.(`创建技能失败：${errText(e)}`);
    } finally {
      setCreateBusy(false);
    }
  };

  /** 浏览本机技能目录并加入额外目录（导入） */
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

  /** 关闭设置，在对话里用 AI 写 SKILL.md */
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
      // 成功静默
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
  const anyBusy = loading || syncBusy || batchBusy || createBusy || discoverBusy;
  const batchEnableCount = filtered.filter((s) => s.activation !== 'enabled').length;
  const batchDisableCount = filtered.filter((s) => s.activation !== 'disabled').length;

  const renderListEmpty = () => {
    if (loading && skills.length === 0) {
      return (
        <div
          className={`${styles.skillsEmptyInline} skills-empty-inline`}
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          加载中…
        </div>
      );
    }
    if (loading || filtered.length > 0) return null;

    if (skills.length === 0) {
      return (
        <div
          className={`${styles.skillsEmptyInline} skills-empty-inline ${styles.skillsEmptyInlineCta} skills-empty-inline--cta`}
          role="status"
          aria-live="polite"
          title={EMPTY_INSTALL_HINT}
        >
          <div>暂无技能</div>
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            onClick={() => setCreateMode('paths')}
            title="导入本机技能或用 AI 创建"
            aria-label="新建技能"
          >
            <Lucide.Plus size={14} aria-hidden />
            新建技能
          </button>
        </div>
      );
    }

    // 有技能 but filtered out
    return (
      <div
        className={`${styles.skillsEmptyInline} skills-empty-inline`}
        role="status"
        aria-live="polite"
        title={EMPTY_FILTER_HINT}
      >
        <div>无匹配 · 共 {skills.length} 个技能</div>
        <div className={`${styles.skillsDiscoverActions} skills-discover-actions`} style={{ justifyContent: 'flex-start' }}>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={clearFilters}
            title={EMPTY_FILTER_HINT}
            aria-label="清除筛选"
          >
            清除筛选
          </button>
        </div>
      </div>
    );
  };

  return (
    <SettingsPage
      title="技能"
      meta={
        <div className={`${styles.skillsTabActions} skills-tab-actions`} role="toolbar" aria-label="技能操作">
          <button
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            onClick={() =>
              setCreateMode((m) => (m === 'none' ? 'paths' : 'none'))
            }
            title="导入本机技能 or AI"
            aria-label={createMode !== 'none' ? '收起新建' : '新建技能'}
            aria-expanded={createMode !== 'none'}
            aria-controls={createBoxId}
          >
            <Lucide.Plus size={14} aria-hidden />
            {createMode !== 'none' ? '收起' : '新建'}
          </button>
          <div className={`${styles.skillsMoreWrap} skills-more-wrap`}>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-controls={moreMenuId}
              aria-haspopup="menu"
              title="更多操作"
              aria-label="更多操作"
            >
              <Lucide.MoreHorizontal size={16} aria-hidden />
            </button>
            {moreOpen ? (
              <div
                id={moreMenuId}
                className={`${styles.skillsMoreMenu} skills-more-menu`}
                role="menu"
                aria-label="更多技能操作"
              >
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.skillsMoreItem} skills-more-item`}
                  onClick={() => {
                    setMoreOpen(false);
                    void handleSyncAll();
                  }}
                  disabled={syncBusy || skills.length === 0}
                >
                  {syncBusy ? '同步中…' : '同步到引擎'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.skillsMoreItem} skills-more-item`}
                  onClick={() => {
                    setMoreOpen(false);
                    void refresh({ promptNew: true });
                  }}
                  disabled={loading || discoverBusy}
                >
                  发现新技能
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.skillsMoreItem} skills-more-item`}
                  onClick={() => {
                    setMoreOpen(false);
                    void refresh();
                  }}
                  disabled={loading}
                >
                  刷新列表
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.skillsMoreItem} skills-more-item`}
                  onClick={() => {
                    const next = !enableCommands;
                    const prev = enableCommands;
                    setEnableCommands(next);
                    setMoreOpen(false);
                    void clientApi
                      .saveSettingsEx(getWorkspacePath() || '', 'global', {
                        enableSkillCommands: next,
                      })
                      .then((merged) => {
                        useLayoutStore.getState().setAppSettings(merged);
                      })
                      .catch((err) => {
                        setEnableCommands(prev);
                        onShowToast?.(`快捷命令保存失败：${errText(err)}`);
                      })
                      .finally(() => {
                        window.dispatchEvent(new CustomEvent('crish-skills-changed'));
                      });
                  }}
                >
                  {enableCommands ? '关闭快捷命令' : '开启快捷命令'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.skillsMoreItem} skills-more-item ${batchConfirm === 'enabled' ? styles.isActive + ' is-active' : ''}`}
                  onClick={() => void runBatchActivation('enabled')}
                  disabled={batchBusy || filtered.length === 0}
                >
                  {batchConfirm === 'enabled'
                    ? `再点确认全启（${batchEnableCount}）`
                    : '全部启用'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.skillsMoreItem} skills-more-item ${batchConfirm === 'disabled' ? styles.isActive + ' is-active' : ''}`}
                  onClick={() => void runBatchActivation('disabled')}
                  disabled={batchBusy || filtered.length === 0}
                >
                  {batchConfirm === 'disabled'
                    ? `再点确认全禁（${batchDisableCount}）`
                    : '全部禁用'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      }
    >

      {loadError ? (
        <div className={`${styles.skillsFsWarn} skills-fs-warn`} role="alert">
          <span title={loadError}>{loadError}</span>{' '}
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="重试扫描技能"
          >
            重试
          </button>
        </div>
      ) : null}

      {discoverCandidates && discoverCandidates.length > 0 ? (
        <section
          className={`${styles.skillsDiscoverPanel} skills-discover-panel`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={discoverTitleId}
          aria-busy={discoverBusy || undefined}
        >
          <div className={`${styles.skillsDiscoverTitle} skills-discover-title`} id={discoverTitleId}>
            发现新技能 {discoverCandidates.length}
          </div>
          <div className={`${styles.skillsDiscoverList} skills-discover-list`} role="group" aria-label="待导入技能">
            {discoverCandidates.map((s) => {
              const checked = discoverPick[s.id] !== false;
              return (
                <label
                  key={s.id}
                  className={`${styles.skillsDiscoverItem} skills-discover-item`}
                  title={s.description || s.name}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={discoverBusy}
                    onChange={(e) =>
                      setDiscoverPick((p) => ({ ...p, [s.id]: e.target.checked }))
                    }
                    aria-label={`${checked ? '取消选择' : '选择'} ${s.name}`}
                  />
                  <span className={`${styles.skillsDiscoverName} skills-discover-name`}>{s.name}</span>
                </label>
              );
            })}
          </div>
          <div className={`${styles.skillsDiscoverActions} skills-discover-actions`}>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              disabled={discoverBusy}
              onClick={() => void applyDiscoverImport('skip')}
              aria-label="跳过导入"
            >
              跳过
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              disabled={discoverBusy}
              onClick={() => void applyDiscoverImport('all')}
              aria-label={`全部启用 ${discoverCandidates.length} 个新技能`}
            >
              全启
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={discoverBusy}
              aria-busy={discoverBusy || undefined}
              onClick={() => void applyDiscoverImport('selected')}
              aria-label="启用所选新技能"
            >
              {discoverBusy ? '…' : '启用所选'}
            </button>
          </div>
        </section>
      ) : null}

      {createMode === 'paths' ? (
        <section
          className={`${styles.skillsCreateBox} skills-create-box`}
          id={createBoxId}
          aria-label="新建技能"
        >
          <div className="settings-create-paths">
            <button
              type="button"
              className="settings-create-path"
              onClick={() => void handleImportBrowse()}
            >
              <span className="settings-create-path-title">浏览导入</span>
              <span className="settings-create-path-desc">
                选择本机已有技能目录（如 .codex/skills），导入后直接出现在列表
              </span>
            </button>
            <button
              type="button"
              className="settings-create-path"
              onClick={handleAiCreateSkill}
            >
              <span className="settings-create-path-title">AI 创建</span>
              <span className="settings-create-path-desc">
                打开对话，由 AI 写完整 SKILL.md（推荐，无需手写）
              </span>
            </button>
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-ghost ui-btn-sm"
            onClick={() => setCreateMode('manual')}
          >
            高级：手填空白技能…
          </button>
        </section>
      ) : null}

      {createMode === 'manual' ? (
        <section
          className={`${styles.skillsCreateBox} skills-create-box`}
          id={createBoxId}
          aria-label="手填项目技能"
        >
          <div className={`${styles.skillsCreateRow} skills-create-row`}>
            <input
              id={createNameId}
              className="settings-field-input settings-field-input--sm"
              placeholder="名称"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              title="写入 .conex/skills/<name>/SKILL.md"
              aria-label="技能名称"
              disabled={createBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && createName.trim()) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
            />
            <input
              id={createDescId}
              className="settings-field-input settings-field-input--sm"
              placeholder="描述（可选）"
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              aria-label="技能描述（可选）"
              disabled={createBusy}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && createName.trim()) {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
            />
            <button
              type="button"
              className="ui-btn ui-btn-secondary ui-btn-sm"
              disabled={!createName.trim() || createBusy}
              aria-busy={createBusy || undefined}
              onClick={() => void handleCreate()}
              aria-label={createBusy ? '创建中' : '创建技能'}
            >
              {createBusy ? '…' : '创建'}
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={() => setCreateMode('paths')}
            >
              返回
            </button>
          </div>
        </section>
      ) : null}

      {/* 单行筛选：作用域（全局+具体项目名）+ 搜索；状态筛选已撤，启停在列表本体 */}
      <div className={`${styles.skillsToolbar} skills-toolbar ${styles.skillsToolbarFocus} skills-toolbar--focus`} role="group" aria-label="筛选">
        <SettingsSelect
          className={`${styles.skillsScopeSelect} skills-scope-select`}
          value={scopeFilter}
          options={scopeSelectOptions}
          onChange={handleScopeFilterChange}
          disabled={loading}
          placeholder="作用域…"
        />
        <input
          id={searchId}
          className={`settings-field-input settings-field-input--sm ${styles.skillsSearch} skills-search`}
          placeholder="搜索技能…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="搜索技能"
        />
      </div>

      {!fsOk ? (
        <div
          className={`${styles.skillsFsWarn} skills-fs-warn`}
          role="status"
          title="需桌面壳以扫描本机技能目录"
        >
          当前环境无法读取本机技能目录
        </div>
      ) : null}

      <div className={`${styles.skillsSplit} skills-split`}>
        <aside className={`${styles.skillsRail} skills-rail`} aria-labelledby={listLabelId}>
          <div
            id={listLabelId}
            className="sr-only"
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: 'hidden',
              clip: 'rect(0,0,0,0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            技能列表
          </div>
          <div
            className={`${styles.skillsRailList} skills-rail-list`}
            role="listbox"
            aria-label="技能列表"
            aria-busy={loading || undefined}
            aria-activedescendant={selectedId ? `skill-opt-${selectedId}` : undefined}
          >
            {renderListEmpty()}
            {grouped.map((g) => {
              const groupLabel = scopeGroupLabel(g.scope, activeScopeProjectName);
              return (
              <div key={g.scope} className={`${styles.skillsRailGroup} skills-rail-group`} role="group" aria-label={groupLabel}>
                <div className={`${styles.skillsRailGroupLabel} skills-rail-group-label`}>
                  {groupLabel}
                  <span aria-label={`${g.items.length} 个`}>{g.items.length}</span>
                </div>
                {g.items.map((s) => {
                  const actLabel = ACTIVATION_LABEL[s.activation] || s.activation;
                  const isSel = selectedId === s.id;
                  return (
                    <button
                      key={s.id}
                      id={`skill-opt-${s.id}`}
                      type="button"
                      role="option"
                      aria-selected={isSel}
                      className={`${styles.skillsRailItem} skills-rail-item ${styles.skillsRailItemDense} skills-rail-item--dense ${isSel ? styles.isActive + ' is-active' : ''} act-${s.activation}`}
                      onClick={() => setSelectedId(s.id)}
                      title={s.description || s.name}
                      aria-label={`${s.name}，${groupLabel}，${actLabel}${s.system ? '，系统' : ''}`}
                    >
                      <span className={`${styles.skillsRailIcon} skills-rail-icon`} aria-hidden>
                        {s.system ? (
                          <Lucide.Package size={12} />
                        ) : (
                          <Lucide.Sparkles size={12} />
                        )}
                      </span>
                      <span className={`${styles.skillsRailName} skills-rail-name`}>
                        {s.name}
                        {s.system ? (
                          <em className={`${styles.skillsSysBadge} skills-sys-badge`}>系统</em>
                        ) : null}
                      </span>
                      <span
                        className={`${styles.skillsActDot} skills-act-dot act-${s.activation}`}
                        title={actLabel}
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
              );
            })}
          </div>

          <details
            className={`${styles.skillsExtraDetails} skills-extra-details`}
            open={extraOpen || extraDirs.length > 0}
            onToggle={(e) => setExtraOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className={`${styles.skillsExtraSummary} skills-extra-summary`}>
              高级 · 额外目录
              {extraDirs.length > 0 ? `（${extraDirs.length}）` : ''}
            </summary>
            <div className="settings-list" role="list" aria-label="已添加的额外技能目录">
              {extraDirs.map((d) => (
                <div key={d} className="settings-list-row" role="listitem">
                  <div className="settings-list-copy">
                    <div className="settings-list-title settings-path-ellipsis" title={d}>
                      {d}
                    </div>
                  </div>
                  <div className="settings-list-control">
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title="移除此目录"
                      aria-label={`移除目录 ${d}`}
                      onClick={() => handleRemoveExtra(d)}
                    >
                      <Lucide.X size={14} aria-hidden />
                    </button>
                  </div>
                </div>
              ))}
              <div className="settings-list-row">
                <div className={`${styles.skillsExtraAddRow} skills-extra-add-row`}>
                  <input
                    id={extraDirId}
                    className="settings-field-input settings-field-input--sm"
                    placeholder="绝对路径"
                    value={extraDir}
                    onChange={(e) => setExtraDir(e.target.value)}
                    title="技能目录绝对路径 · 回车添加"
                    aria-label="额外技能目录绝对路径"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && extraDir.trim()) {
                        e.preventDefault();
                        commitExtraDir(extraDir);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    title="浏览文件夹"
                    aria-label="浏览文件夹"
                    onClick={() => void handlePickExtra()}
                  >
                    <Lucide.FolderOpen size={14} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    disabled={!extraDir.trim()}
                    aria-label="添加额外目录"
                    onClick={() => commitExtraDir(extraDir)}
                  >
                    添加
                  </button>
                </div>
              </div>
            </div>
          </details>
        </aside>

        <section className={`${styles.skillsDetail} skills-detail`} aria-label="技能预览">
          {!selected ? (
            <div className={`${styles.skillsDetailEmpty} skills-detail-empty`} role="status">
              {skills.length === 0 ? '新建技能后在此预览' : '选择左侧技能'}
            </div>
          ) : (
            <>
              <div className={`${styles.skillsDetailTop} skills-detail-top`}>
                <div className={`${styles.skillsDetailMain} skills-detail-main`}>
                  <div className={`${styles.skillsDetailNameRow} skills-detail-name-row`}>
                    <div className={`${styles.skillsDetailName} skills-detail-name`} title={selected.name}>
                      {selected.name}
                    </div>
                    <div className={`${styles.skillsDetailMeta} skills-detail-meta`}>
                      <span className={`${styles.skillsScope} skills-scope`}>
                        {scopeGroupLabel(selected.scope, activeScopeProjectName)}
                      </span>
                      {selected.system ? (
                        <span className={`${styles.skillsTag} skills-tag`}>系统</span>
                      ) : null}
                      {selected.disableModelInvocation ? (
                        <span className={`${styles.skillsTag} skills-tag`} title="禁止模型自动调用">
                          禁自动
                        </span>
                      ) : null}
                      {selected.tags.slice(0, 2).map((t) => (
                        <span key={t} className={`${styles.skillsTag} skills-tag`}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className={`${styles.skillsDetailCmdRow} skills-detail-cmd-row`}>
                    <code className="settings-kbd" title={selectedSlash}>
                      {selectedSlash}
                    </code>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title="复制斜杠命令"
                      aria-label={`复制命令 ${selectedSlash}`}
                      onClick={() => void copySlashCommand(selected.name)}
                    >
                      <Lucide.Copy size={14} aria-hidden />
                    </button>
                    <span className={`${styles.skillsPathInline} skills-path-inline`} title={selected.filePath}>
                      {selected.filePath}
                    </span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      title="在文件管理器中打开位置"
                      aria-label="打开技能文件位置"
                      onClick={() => {
                        void revealSkillPath(selected.filePath).then((ok) => {
                          if (!ok) onShowToast?.('无法打开路径（需桌面壳）');
                        });
                      }}
                    >
                      <Lucide.ExternalLink size={14} aria-hidden />
                    </button>
                  </div>
                </div>
                <div className={`${styles.skillsDetailControls} skills-detail-controls`}>
                  <div
                    className="skills-activation"
                    role="group"
                    aria-label={`${selected.name} 启用状态`}
                  >
                    <div className="ui-segment ui-segment--inline settings-segment-pill">
                      {ACTIVATION_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ui-segment-item ${selected.activation === opt.id ? 'active' : ''}`}
                          disabled={busyId === selected.id || batchBusy}
                          aria-pressed={selected.activation === opt.id}
                          aria-label={`设为${opt.label}`}
                          aria-busy={busyId === selected.id || undefined}
                          onClick={() => void setActivation(selected, opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`ui-btn ui-btn-ghost ui-btn-sm ${showRaw ? 'is-active' : ''}`}
                    onClick={() => setShowRaw((v) => !v)}
                    aria-pressed={showRaw}
                    aria-label={showRaw ? '切换为预览' : '切换为原文'}
                  >
                    {showRaw ? '预览' : '原文'}
                  </button>
                </div>
              </div>

              {showRaw ? (
                <pre className={`${styles.skillsRaw} skills-raw`} tabIndex={0} aria-label="技能原文">
                  {selected.raw}
                </pre>
              ) : (
                <div
                  className={`${styles.skillsPreview} skills-preview md-rendered msg-assistant-text`}
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                  aria-label="技能预览"
                />
              )}
            </>
          )}
        </section>
      </div>
    </SettingsPage>
  );
};
