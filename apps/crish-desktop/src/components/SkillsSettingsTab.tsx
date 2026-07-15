/**
 * 设置 · 技能：SKILL.md 发现 / 列表 / 预览 / 启用 / 创建 / 斜杠命令
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  skillsToSlashCommands,
  syncSkillsToDaemon,
  type DesktopSkill,
  type SkillActivation,
} from '../api/skillsApi';
import { skillStableId } from '../api/skillId';
import { getWorkspacePath } from '../api/projectStore';
import { parseMarkdownToHtml } from '../api/markdownRender';
import { clientApi } from '../api/clientApi';

type Props = {
  onShowToast?: (msg: string) => void;
};

const ACTIVATION_OPTIONS: { id: SkillActivation; label: string }[] = [
  { id: 'enabled', label: '启用' },
  { id: 'recommended', label: '推荐' },
  { id: 'disabled', label: '禁用' },
];

const SCOPE_LABEL: Record<string, string> = {
  project: '项目',
  workspace: '工作区',
  global: '全局',
};

type ScopeFilter = 'all' | 'project' | 'global';
type ActFilter = 'all' | SkillActivation;

export const SkillsSettingsTab: React.FC<Props> = ({ onShowToast }) => {
  const [skills, setSkills] = useState<DesktopSkill[]>([]);
  const [roots, setRoots] = useState<
    { path: string; scope: string; ok: boolean; count: number; error?: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [actFilter, setActFilter] = useState<ActFilter>('all');
  const [extraDir, setExtraDir] = useState('');
  const [extraDirs, setExtraDirs] = useState<string[]>(() => getExtraSkillDirs());
  const [fsOk, setFsOk] = useState(true);
  const [enableCommands, setEnableCommands] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  /** 自发现：尚未确认导入的技能（需用户同意） */
  const [discoverCandidates, setDiscoverCandidates] = useState<DesktopSkill[] | null>(null);
  const [discoverPick, setDiscoverPick] = useState<Record<string, boolean>>({});

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
    localStorage.setItem(knownIdsKey, JSON.stringify([...ids]));
  };

  const refresh = useCallback(async (opts?: { promptNew?: boolean }) => {
    setLoading(true);
    try {
      setFsOk(await skillsFsAvailable());
      const res = await discoverSkills({ workspacePath: getWorkspacePath() });
      setSkills(res.skills);
      setRoots(res.roots);
      setExtraDirs(getExtraSkillDirs());
      invalidateSkillSlashCache();
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
        } else {
          onShowToast?.('未发现新技能（已扫描的路径均已登记）');
        }
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
      onShowToast?.(`扫描技能失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [onShowToast]);

  const applyDiscoverImport = async (mode: 'selected' | 'all' | 'skip') => {
    if (!discoverCandidates) {
      setDiscoverCandidates(null);
      return;
    }
    if (mode === 'skip') {
      setDiscoverCandidates(null);
      onShowToast?.('已跳过导入；技能仍可在列表中单独启用');
      return;
    }
    const targets =
      mode === 'all'
        ? discoverCandidates
        : discoverCandidates.filter((s) => discoverPick[s.id]);
    let n = 0;
    for (const s of targets) {
      await setSkillActivation(s, 'enabled');
      n += 1;
    }
    setDiscoverCandidates(null);
    await refresh();
    onShowToast?.(n > 0 ? `已启用 ${n} 个新技能` : '未选择任何技能');
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stats = useMemo(() => {
    const enabled = skills.filter((s) => s.activation === 'enabled').length;
    const recommended = skills.filter((s) => s.activation === 'recommended').length;
    const disabled = skills.filter((s) => s.activation === 'disabled').length;
    return { total: skills.length, enabled, recommended, disabled };
  }, [skills]);

  const slashPreview = useMemo(() => skillsToSlashCommands(skills).slice(0, 6), [skills]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return skills.filter((s) => {
      if (scopeFilter === 'project' && s.scope !== 'project' && s.scope !== 'workspace') return false;
      if (scopeFilter === 'global' && s.scope !== 'global') return false;
      if (actFilter !== 'all' && s.activation !== actFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q)) ||
        s.filePath.toLowerCase().includes(q)
      );
    });
  }, [skills, filter, scopeFilter, actFilter]);

  const grouped = useMemo(() => {
    const order: Array<'project' | 'workspace' | 'global'> = ['project', 'workspace', 'global'];
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

  const setActivation = async (skill: DesktopSkill, activation: SkillActivation) => {
    setBusyId(skill.id);
    try {
      const r = await setSkillActivation(skill, activation);
      setSkills((list) => list.map((s) => (s.id === skill.id ? { ...s, activation } : s)));
      invalidateSkillSlashCache();
      const base =
        activation === 'enabled'
          ? `已启用 ${skill.name}`
          : activation === 'disabled'
            ? `已禁用 ${skill.name}`
            : `已设为推荐 ${skill.name}`;
      if (!r.daemonSynced) {
        onShowToast?.(
          `${base}（仅本机，引擎未同步${r.error ? `：${r.error}` : ''}）`,
        );
      } else {
        onShowToast?.(base);
      }
    } catch (e) {
      onShowToast?.(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleSyncAll = async () => {
    setSyncBusy(true);
    try {
      const r = await syncSkillsToDaemon(skills);
      onShowToast?.(
        r.fail === 0
          ? `已同步 ${r.ok} 个技能到引擎`
          : `同步完成：成功 ${r.ok}，失败 ${r.fail}`,
      );
    } finally {
      setSyncBusy(false);
    }
  };

  const handlePickExtra = async () => {
    const dir = await pickSkillDirectory();
    if (!dir) return;
    addExtraSkillDir(dir);
    setExtraDirs(getExtraSkillDirs());
    void refresh();
    onShowToast?.(`已添加目录`);
  };

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreateBusy(true);
    try {
      const r = await createProjectSkill({
        name: createName.trim(),
        description: createDesc.trim() || undefined,
        workspacePath: getWorkspacePath(),
      });
      if (r.ok === false) {
        onShowToast?.(r.error);
        return;
      }
      // createProjectSkill writes frontmatter name as normalizeSlashName(opts.name)
      const slug = createName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const selectId = skillStableId(slug || createName.trim(), r.skillPath);
      onShowToast?.(`已创建 ${r.skillPath}`);
      setCreateOpen(false);
      setCreateName('');
      setCreateDesc('');
      await refresh();
      setSelectedId(selectId);
    } finally {
      setCreateBusy(false);
    }
  };

  const previewHtml = useMemo(() => {
    if (!selected) return '';
    if (showRaw) return '';
    const md = `# ${selected.name}\n\n> ${selected.description}\n\n${selected.content || '_（无正文）_'}`;
    return parseMarkdownToHtml(md);
  }, [selected, showRaw]);

  return (
    <div className="skills-tab">
      <div className="skills-tab-head">
        <div>
          <h4 className="skills-tab-title">技能</h4>
          <p className="skills-tab-sub">
            扫描项目与全局 SKILL.md；预览正文、设置启用，并可注册为 /skill:name
          </p>
        </div>
        <div className="skills-tab-actions">
          <button
            type="button"
            className="models-btn ghost"
            onClick={() => void handleSyncAll()}
            disabled={syncBusy || skills.length === 0}
            title="将启用/推荐技能同步到引擎上下文"
          >
            <Lucide.CloudUpload size={14} />
            {syncBusy ? '同步中…' : '同步引擎'}
          </button>
          <button
            type="button"
            className="models-btn ghost"
            onClick={() => setCreateOpen((v) => !v)}
            title="在项目 .conex/skills 创建模板"
          >
            <Lucide.Plus size={14} />
            新建
          </button>
          <button
            type="button"
            className="models-btn ghost"
            onClick={() => void refresh({ promptNew: true })}
            disabled={loading}
            title="扫描路径并提示导入新发现的技能（需你确认）"
          >
            <Lucide.Search size={14} />
            发现新技能
          </button>
          <button
            type="button"
            className="models-btn ghost"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <Lucide.RefreshCw size={14} className={loading ? 'spin' : undefined} />
            {loading ? '扫描中…' : '刷新'}
          </button>
        </div>
      </div>

      {discoverCandidates && discoverCandidates.length > 0 ? (
        <div className="skills-discover-panel" role="dialog" aria-label="导入新技能">
          <div className="skills-discover-title">
            发现 {discoverCandidates.length} 个新技能
          </div>
          <p className="skills-discover-hint">
            自发现不会自动启用。请选择要导入的技能（启用后可被模型 / 斜杠命令使用）。
          </p>
          <div className="skills-discover-list">
            {discoverCandidates.map((s) => (
              <label key={s.id} className="skills-discover-item">
                <input
                  type="checkbox"
                  checked={discoverPick[s.id] !== false}
                  onChange={(e) =>
                    setDiscoverPick((p) => ({ ...p, [s.id]: e.target.checked }))
                  }
                />
                <span>
                  <span className="skills-discover-name">{s.name}</span>
                  <span className="skills-discover-desc">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="skills-discover-actions">
            <button type="button" className="models-btn ghost" onClick={() => void applyDiscoverImport('skip')}>
              暂不导入
            </button>
            <button type="button" className="models-btn ghost" onClick={() => void applyDiscoverImport('all')}>
              全部启用
            </button>
            <button type="button" className="models-btn" onClick={() => void applyDiscoverImport('selected')}>
              启用所选
            </button>
          </div>
        </div>
      ) : null}

      {createOpen ? (
        <div className="skills-create-box">
          <div className="skills-create-title">新建项目技能</div>
          <p className="skills-create-hint">
            写入当前工作区 <code>.conex/skills/&lt;name&gt;/SKILL.md</code>
          </p>
          <div className="skills-create-row">
            <input
              className="settings-field-input"
              placeholder="名称，如 code-review"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
            />
            <input
              className="settings-field-input"
              placeholder="简短描述（可选）"
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
            />
            <button
              type="button"
              className="models-btn"
              disabled={!createName.trim() || createBusy}
              onClick={() => void handleCreate()}
            >
              {createBusy ? '创建中…' : '创建'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="skills-stats">
        <span>
          共 <strong>{stats.total}</strong>
        </span>
        <span className="skills-stat-sep">·</span>
        <span className="act-enabled">启用 {stats.enabled}</span>
        <span className="skills-stat-sep">·</span>
        <span className="act-recommended">推荐 {stats.recommended}</span>
        <span className="skills-stat-sep">·</span>
        <span className="act-disabled">禁用 {stats.disabled}</span>
      </div>

      <div className="skills-toolbar">
        <label className="skills-enable-cmd">
          <input
            type="checkbox"
            className="settings-switch"
            checked={enableCommands}
            onChange={(e) => {
              const v = e.target.checked;
              setEnableCommands(v);
              void clientApi.saveSettingsEx(getWorkspacePath() || '', 'global', {
                enableSkillCommands: v,
              });
            }}
          />
          <span>
            <span className="skills-enable-title">注册为快捷命令</span>
            <span className="skills-enable-desc">输入框可用 /skill:name</span>
          </span>
        </label>
        <div className="skills-filters">
          <div className="ui-segment ui-segment--inline">
            {(
              [
                { id: 'all' as const, label: '全部' },
                { id: 'project' as const, label: '项目' },
                { id: 'global' as const, label: '全局' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`ui-segment-item ${scopeFilter === opt.id ? 'active' : ''}`}
                onClick={() => setScopeFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="ui-segment ui-segment--inline">
            {(
              [
                { id: 'all' as const, label: '状态' },
                { id: 'enabled' as const, label: '启用' },
                { id: 'recommended' as const, label: '推荐' },
                { id: 'disabled' as const, label: '禁用' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`ui-segment-item ${actFilter === opt.id ? 'active' : ''}`}
                onClick={() => setActFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            className="settings-field-input skills-search"
            placeholder="搜索技能…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {!fsOk ? (
        <div className="skills-banner">
          当前环境无法读取本机技能目录（需桌面壳）。请在 Tauri 工作台中打开以扫描全局与项目技能。
        </div>
      ) : null}

      {enableCommands && slashPreview.length > 0 ? (
        <div className="skills-slash-preview">
          <span className="skills-slash-label">快捷命令示例</span>
          {slashPreview.map((c) => (
            <code key={c.cmd} className="skills-slash-chip" title={c.desc}>
              {c.cmd}
            </code>
          ))}
          {skillsToSlashCommands(skills).length > slashPreview.length ? (
            <span className="skills-slash-more">
              +{skillsToSlashCommands(skills).length - slashPreview.length}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="skills-split">
        <aside className="skills-rail">
          <div className="skills-rail-list">
            {loading && filtered.length === 0 ? (
              <div className="skills-empty-inline">正在扫描…</div>
            ) : null}
            {!loading && filtered.length === 0 ? (
              <div className="skills-empty-inline">
                未发现 SKILL.md
                <div className="skills-empty-hint">
                  可放在项目 <code>.conex/skills/</code> 或用户{' '}
                  <code>~/.codex/skills/</code>、<code>~/.claude/skills/</code>
                </div>
              </div>
            ) : null}
            {grouped.map((g) => (
              <div key={g.scope} className="skills-rail-group">
                <div className="skills-rail-group-label">
                  {SCOPE_LABEL[g.scope] || g.scope}
                  <span>{g.items.length}</span>
                </div>
                {g.items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`skills-rail-item ${selectedId === s.id ? 'is-active' : ''} act-${s.activation}`}
                    onClick={() => setSelectedId(s.id)}
                  >
                    <span className="skills-rail-icon">
                      {s.system ? <Lucide.Package size={16} /> : <Lucide.Sparkles size={16} />}
                    </span>
                    <span className="skills-rail-text">
                      <span className="skills-rail-name">
                        {s.name}
                        {s.system ? <em className="skills-sys-badge">系统</em> : null}
                      </span>
                      <span className="skills-rail-desc">{s.description}</span>
                    </span>
                    <span className={`skills-act-dot act-${s.activation}`} title={s.activation} />
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="skills-extra">
            <div className="skills-extra-label">额外目录</div>
            {extraDirs.map((d) => (
              <div key={d} className="skills-extra-row">
                <span title={d}>{d}</span>
                <button
                  type="button"
                  className="models-icon-btn danger"
                  title="移除"
                  onClick={() => {
                    removeExtraSkillDir(d);
                    setExtraDirs(getExtraSkillDirs());
                    void refresh();
                  }}
                >
                  <Lucide.X size={14} />
                </button>
              </div>
            ))}
            <div className="skills-extra-add">
              <input
                className="settings-field-input"
                placeholder="技能目录绝对路径"
                value={extraDir}
                onChange={(e) => setExtraDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && extraDir.trim()) {
                    addExtraSkillDir(extraDir.trim());
                    setExtraDir('');
                    setExtraDirs(getExtraSkillDirs());
                    void refresh();
                  }
                }}
              />
              <button
                type="button"
                className="models-btn ghost"
                title="浏览文件夹"
                onClick={() => void handlePickExtra()}
              >
                <Lucide.FolderOpen size={14} />
              </button>
              <button
                type="button"
                className="models-btn"
                disabled={!extraDir.trim()}
                onClick={() => {
                  addExtraSkillDir(extraDir.trim());
                  setExtraDir('');
                  setExtraDirs(getExtraSkillDirs());
                  void refresh();
                }}
              >
                添加
              </button>
            </div>
          </div>
        </aside>

        <section className="skills-detail">
          {!selected ? (
            <div className="skills-detail-empty">选择左侧技能以预览 SKILL.md</div>
          ) : (
            <>
              <div className="skills-detail-top">
                <div>
                  <div className="skills-detail-name">{selected.name}</div>
                  <div className="skills-detail-meta">
                    <span className="skills-scope">{SCOPE_LABEL[selected.scope] || selected.scope}</span>
                    {selected.system ? <span className="skills-tag">系统</span> : null}
                    {selected.disableModelInvocation ? (
                      <span className="skills-tag">禁止模型自动调用</span>
                    ) : null}
                    {selected.tags.map((t) => (
                      <span key={t} className="skills-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="skills-detail-path skills-path-btn"
                    title="在资源管理器中打开"
                    onClick={() => {
                      void revealSkillPath(selected.filePath).then((ok) => {
                        if (!ok) onShowToast?.('无法打开路径（需桌面壳）');
                      });
                    }}
                  >
                    <Lucide.ExternalLink size={12} />
                    {selected.filePath}
                  </button>
                </div>
                <div className="skills-detail-controls">
                  <div className="skills-activation">
                    <div className="ui-segment ui-segment--inline">
                      {ACTIVATION_OPTIONS.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ui-segment-item ${selected.activation === opt.id ? 'active' : ''}`}
                          disabled={busyId === selected.id}
                          onClick={() => void setActivation(selected, opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`models-btn ghost ${showRaw ? 'is-active' : ''}`}
                    onClick={() => setShowRaw((v) => !v)}
                  >
                    {showRaw ? '渲染预览' : '原文'}
                  </button>
                </div>
              </div>

              {showRaw ? (
                <pre className="skills-raw">{selected.raw}</pre>
              ) : (
                <div
                  className="skills-preview md-rendered msg-assistant-text"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              )}
            </>
          )}
        </section>
      </div>

      {roots.length > 0 ? (
        <details className="skills-roots">
          <summary>
            扫描路径（{roots.filter((r) => r.ok && r.count > 0).length}/{roots.length} 有结果，共{' '}
            {roots.reduce((n, r) => n + (r.count || 0), 0)} 个文件命中）
          </summary>
          <ul>
            {roots.map((r) => (
              <li key={r.path} className={r.ok ? (r.count > 0 ? 'ok' : 'empty') : 'fail'}>
                <code>{r.path}</code>
                <span>
                  {SCOPE_LABEL[r.scope] || r.scope}
                  {r.ok ? ` · ${r.count} 个` : ` · ${r.error || '不可读'}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
};
