/**
 * 设置 · 规则：短规则、预设与全文编辑；成功静默，仅失败提示。
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  clientApi,
  normalizeCustomRules,
  normalizeSettingsText,
  type Settings,
} from '../api/clientApi';
import {
  getWorkspacePath,
  listSettingsScopeProjects,
  projectFolderLabel,
} from '../api/projectStore';
import {
  rulesLinesToText,
  syncRulesToDaemon,
  textToRuleLines,
} from '../api/rulesApi';
import { formatEngineDegradeToast } from '../hooks/useToastQueue';
import { useLayoutStore } from '../store/layoutStore';
import { SettingsSelect } from './SettingsSelect';
import styles from './SettingsRulesTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './settings/SettingsUI';
import { Tooltip } from './Tooltip';

type Props = {
  onShowToast: (msg: string) => void;
  /** 二级弹层打开时通知父级，避免 Esc 直接关掉整个设置页 */
  onBlockingOverlayChange?: (blocking: boolean) => void;
};

/** 作用域：global 或项目路径 */
type ScopeKey = string;
const SCOPE_GLOBAL = 'global';

/** 常用规则预设 */
const RULE_PRESETS: string[] = [
  '修改前先说明方案并等待确认',
  '保持既有代码风格，不随意重构无关代码',
  '提交前确保通过 lint / 测试',
  '不要提交密钥、token 或本地环境文件',
  '优先最小改动，避免大范围无关修改',
];

/** 空全文模板 */
const EMPTY_GLOBAL_TEMPLATE = '# 全局规则\n\n';
const EMPTY_PROJECT_TEMPLATE = '# 项目规则\n\n';

/** 规范化单条规则 */
function normalizeRuleLine(raw: string): string {
  return normalizeSettingsText(raw);
}

/** 去重 */
function dedupeRuleLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const t = normalizeRuleLine(line);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export const SettingsRulesTab: React.FC<Props> = ({
  onShowToast,
  onBlockingOverlayChange,
}) => {
  /** 已打开过的项目 + 当前 cwd（文件夹名） */
  const [scopeProjects, setScopeProjects] = useState(() => listSettingsScopeProjects());

  const [scopeKey, setScopeKey] = useState<ScopeKey>(() => {
    const projects = listSettingsScopeProjects();
    const cwd = getWorkspacePath() || '';
    if (cwd) {
      const hit = projects.find(
        (p) => p.path.replace(/\\/g, '/').toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase(),
      );
      return hit?.path || cwd || SCOPE_GLOBAL;
    }
    return SCOPE_GLOBAL;
  });
  const [customRules, setCustomRules] = useState<string[]>([]);
  const [editorText, setEditorText] = useState(EMPTY_GLOBAL_TEMPLATE);
  const [newRuleText, setNewRuleText] = useState('');
  const [editingOpen, setEditingOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const fullEditorBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const prevEditingOpen = useRef(false);

  const titleId = useId();
  const descId = useId();
  const addInputId = useId();
  const scopeSelectId = useId();

  const isGlobal = scopeKey === SCOPE_GLOBAL;
  const activeProject = useMemo(
    () =>
      !isGlobal
        ? scopeProjects.find(
            (p) =>
              p.path.replace(/\\/g, '/').toLowerCase() ===
              scopeKey.replace(/\\/g, '/').toLowerCase(),
          ) || null
        : null,
    [isGlobal, scopeKey, scopeProjects],
  );
  const scopeLabel = isGlobal
    ? '全局'
    : activeProject?.name || projectFolderLabel(scopeKey);
  const storagePath = isGlobal ? '全局设置' : scopeKey;

  const scopeOptions = useMemo(() => {
    const opts: { value: string; label: string; hint?: string }[] = [
      { value: SCOPE_GLOBAL, label: '全局', hint: '所有项目共用' },
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

  const ruleCount = customRules.length;

  // 项目列表随打开/关闭变化
  useEffect(() => {
    const sync = () => setScopeProjects(listSettingsScopeProjects());
    sync();
    window.addEventListener('crish-project-changed', sync);
    return () => window.removeEventListener('crish-project-changed', sync);
  }, []);

  /** 按作用域加载规则（全局 or 具体项目路径） */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let lines: string[] = [];
        if (isGlobal) {
          const sets = await clientApi.getSettingsEx('__global__');
          if (cancelled || !sets) return;
          lines = dedupeRuleLines(normalizeCustomRules(sets.customRules));
        } else {
          const partial = await clientApi.getProjectSettingsPartial(scopeKey);
          if (cancelled) return;
          lines = dedupeRuleLines(normalizeCustomRules(partial.customRules));
        }
        setCustomRules(lines);
        setEditorText(
          lines.length > 0
            ? rulesLinesToText(lines, isGlobal ? '# 全局规则' : `# ${scopeLabel} 规则`)
            : isGlobal
              ? EMPTY_GLOBAL_TEMPLATE
              : EMPTY_PROJECT_TEMPLATE,
        );
        setLoadError(null);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          const msg = '读取规则失败：' + String(err);
          setLoadError(msg);
          setLoaded(false);
          onShowToast(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeKey, isGlobal, scopeLabel, onShowToast, loadTick]);

  useEffect(() => {
    onBlockingOverlayChange?.(editingOpen);
    return () => onBlockingOverlayChange?.(false);
  }, [editingOpen, onBlockingOverlayChange]);

  useEffect(() => {
    if (!editingOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (saving) return;
      setEditingOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editingOpen, saving]);

  // 弹层开：聚焦正文；关：焦点回到「全文」按钮
  useEffect(() => {
    if (editingOpen && !prevEditingOpen.current) {
      const t = window.setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
      prevEditingOpen.current = true;
      return () => window.clearTimeout(t);
    }
    if (!editingOpen && prevEditingOpen.current) {
      prevEditingOpen.current = false;
      const t = window.setTimeout(() => {
        fullEditorBtnRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [editingOpen]);

  /**
   * 本机写入当前作用域 customRules；成功静默。
   * @returns 合并后的行；失败已 toast 并返回 null
   */
  const persistCustomRules = async (rules: string[]): Promise<string[] | null> => {
    const safe = dedupeRuleLines(normalizeCustomRules(rules));
    try {
      if (isGlobal) {
        const merged = await clientApi.saveSettingsEx('__global__', 'global', {
          customRules: safe,
        } as Partial<Settings>);
        const next = dedupeRuleLines(
          normalizeCustomRules(merged.customRules ?? safe),
        );
        setCustomRules(next);
        useLayoutStore.getState().setAppSettings(merged);
        setEditorText(
          next.length > 0
            ? rulesLinesToText(next, '# 全局规则')
            : EMPTY_GLOBAL_TEMPLATE,
        );
        return next;
      }
      await clientApi.saveSettingsEx(scopeKey, 'project', {
        customRules: safe,
      } as Partial<Settings>);
      setCustomRules(safe);
      setEditorText(
        safe.length > 0
          ? rulesLinesToText(safe, `# ${scopeLabel} 规则`)
          : EMPTY_PROJECT_TEMPLATE,
      );
      return safe;
    } catch (err) {
      onShowToast('更新设置失败：' + String(err));
      return null;
    }
  };

  /**
   * 引擎同步：全成功静默；未连接/失败用降级 toast；截断单独警告。
   */
  const syncEngineQuiet = async (opts: {
    globalText: string;
    projectText?: string;
  }) => {
    const sync = await syncRulesToDaemon(opts);
    if (!sync.daemonSynced) {
      onShowToast(formatEngineDegradeToast(sync.error));
    } else if (sync.truncated) {
      onShowToast('规则较长，引擎侧已截断');
    }
  };

  const handleSaveRules = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const lines = dedupeRuleLines(textToRuleLines(editorText));
      const saved = await persistCustomRules(lines);
      if (!saved) return;
      setEditingOpen(false);
      // 异步同步到引擎（独立步骤，不阻塞 UI）
      const syncResult = isGlobal
        ? await syncRulesToDaemon({
            globalText:
              saved.length > 0
                ? rulesLinesToText(saved, '# 全局规则')
                : EMPTY_GLOBAL_TEMPLATE,
          })
        : await (async () => {
            let globalText = EMPTY_GLOBAL_TEMPLATE;
            try {
              const g = await clientApi.getSettingsEx('__global__');
              const gl = dedupeRuleLines(normalizeCustomRules(g.customRules));
              globalText =
                gl.length > 0 ? rulesLinesToText(gl, '# 全局规则') : EMPTY_GLOBAL_TEMPLATE;
            } catch {
              /* keep empty template */
            }
            return syncRulesToDaemon({
              globalText,
              projectText: editorText,
            });
          })();
      if (!syncResult.daemonSynced) {
        onShowToast('规则已保存到本机，同步到引擎失败');
      } else if (syncResult.truncated) {
        onShowToast('规则较长，引擎侧已截断');
      }
    } finally {
      setSaving(false);
    }
  };

  const addRuleIfNew = async (text: string) => {
    if (saving) return false;
    const trimmed = normalizeRuleLine(text);
    if (!trimmed) {
      onShowToast('请输入规则内容');
      return false;
    }
    if (customRules.some((r) => normalizeRuleLine(r) === trimmed)) {
      onShowToast('该规则已存在');
      return false;
    }
    setSaving(true);
    try {
      const next = await persistCustomRules([...customRules, trimmed]);
      if (!next) return false;
      // 与 /learn 同路径：本机成功后推引擎；成功静默
      if (isGlobal) {
        void syncEngineQuiet({
          globalText: rulesLinesToText(next, '# 全局规则'),
        });
      } else {
        void syncEngineQuiet({
          globalText: EMPTY_GLOBAL_TEMPLATE,
          projectText: rulesLinesToText(next, `# ${scopeLabel} 规则`),
        });
      }
      return true;
    } finally {
      setSaving(false);
    }
  };

  const handleAddCustomRule = () => {
    void addRuleIfNew(newRuleText).then((ok) => {
      if (ok) {
        setNewRuleText('');
        // 成功静默：输入清空 + 列表增长
        addInputRef.current?.focus();
      }
    });
  };

  const handleAddPreset = (preset: string) => {
    void addRuleIfNew(preset);
  };

  const handleDeleteCustomRule = (index: number) => {
    if (saving) return;
    void (async () => {
      setSaving(true);
      try {
        const updated = customRules.filter((_, i) => i !== index);
        const next = await persistCustomRules(updated);
        if (!next) return;
        if (isGlobal) {
          void syncEngineQuiet({
            globalText:
              next.length > 0
                ? rulesLinesToText(next, '# 全局规则')
                : EMPTY_GLOBAL_TEMPLATE,
          });
        } else {
          void syncEngineQuiet({
            globalText: EMPTY_GLOBAL_TEMPLATE,
            projectText:
              next.length > 0
                ? rulesLinesToText(next, `# ${scopeLabel} 规则`)
                : EMPTY_PROJECT_TEMPLATE,
          });
        }
      } finally {
        setSaving(false);
      }
    })();
  };

  const openFullEditor = () => {
    if (!isGlobal && !scopeKey) {
      onShowToast('请先选择项目');
      return;
    }
    setEditingOpen(true);
  };

  const busy = saving;

  if (!loaded && loadError) {
    return (
      <div className="settings-pane settings-pane--modern settings-pane--rules">
        <header className="settings-page-head">
          <div className="settings-head-inline">
            <h2 className="settings-page-title">规则</h2>
          </div>
        </header>
        <section className="settings-group" aria-label="错误">
          <div className="settings-list">
            <div className="settings-list-row settings-list-row--rule">
              <div className="settings-list-copy">
                <div
                  className="settings-list-title settings-list-empty"
                  role="alert"
                >
                  {loadError}
                </div>
              </div>
              <div className="settings-list-control">
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  aria-label="重新加载规则"
                  onClick={() => {
                    setLoadError(null);
                    setLoadTick((n) => n + 1);
                  }}
                >
                  重试
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  if (!loaded) {
    return (
      <SettingsPage title="规则">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow title="加载中…" />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  const headerMeta = (
    <div className="settings-head-tools settings-head-tools--rules">
      <div className="settings-head-tools-row">
        <label htmlFor={scopeSelectId} className="sr-only">
          规则作用域
        </label>
        <SettingsSelect
          value={scopeKey}
          options={scopeOptions}
          onChange={setScopeKey}
          disabled={busy}
          className="settings-rules-scope-select"
        />
        <Tooltip content={`编辑${scopeLabel}全文`}>
          <button
            ref={fullEditorBtnRef}
            type="button"
            className="ui-btn ui-btn-secondary ui-btn-sm"
            onClick={openFullEditor}
            aria-label={`编辑${scopeLabel}全文`}
            disabled={busy}
          >
            编辑全文
          </button>
        </Tooltip>
      </div>
    </div>
  );

  return (
    <SettingsPage title="规则" meta={headerMeta}>
      <SettingsSection title={`当前规则 (${scopeLabel})`}>
        <SettingsCard>
          {ruleCount === 0 ? (
            <SettingsRow
              title={<span className="settings-list-empty">还没有规则</span>}
              desc="可点下方常用项，或自己输入"
            />
          ) : (
            customRules.map((rule, idx) => (
              <SettingsRow
                key={`${idx}-${rule.slice(0, 24)}`}
                title={
                  <Tooltip content={rule}>
                    <span className="settings-rule-item-text">{rule}</span>
                  </Tooltip>
                }
                control={
                  <Tooltip content="删除此规则">
                    <button
                      type="button"
                      onClick={() => handleDeleteCustomRule(idx)}
                      className="ui-btn ui-btn-ghost ui-btn-sm danger"
                      aria-label={`删除规则：${rule}`}
                      disabled={busy}
                    >
                      <Lucide.Trash2 size={14} aria-hidden />
                    </button>
                  </Tooltip>
                }
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="快速添加">
        <SettingsCard>
          <div className={styles.sectionRow}>
            <div className={styles.labelCol}>
              <span className={styles.labelTitle}>常用</span>
              <span className={styles.labelDesc}>一键加入</span>
            </div>
            <div className={styles.presetGroup}>
              {RULE_PRESETS.map((preset) => {
                const exists = customRules.some(
                  (r) => normalizeRuleLine(r) === normalizeRuleLine(preset),
                );
                return (
                  <Tooltip key={preset} content={exists ? '已添加' : `添加：${preset}`}>
                    <button
                      type="button"
                      className={`settings-rule-preset${exists ? ' is-disabled' : ''}`}
                      onClick={() => handleAddPreset(preset)}
                      disabled={exists || busy}
                      aria-label={
                        exists ? `已添加：${preset}` : `添加预设：${preset}`
                      }
                    >
                      {preset}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>

          <div className={styles.sectionRowNoBorder}>
            <div className={styles.labelCol}>
              <label htmlFor={addInputId} className={styles.labelTitle}>自定义</label>
              <span className={styles.labelDesc}>输入后添加</span>
            </div>
            <div className={styles.inputGroup}>
              <input
                ref={addInputRef}
                id={addInputId}
                type="text"
                placeholder="写一条规则…"
                value={newRuleText}
                onChange={(e) => setNewRuleText(e.target.value)}
                className={`settings-field-input settings-field-input--sm settings-field-input--grow ${styles.inputGrow}`}
                disabled={busy}
                aria-label="自定义规则"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCustomRule();
                  }
                }}
              />
              <Tooltip content={`加入${scopeLabel}短规则`}>
                <button
                  type="button"
                  onClick={handleAddCustomRule}
                  className={`ui-btn ui-btn-secondary ui-btn-sm ${styles.actionBtn}`}
                  disabled={busy || !normalizeRuleLine(newRuleText)}
                  aria-label="添加规则"
                >
                  添加
                </button>
              </Tooltip>
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      {editingOpen ? (
        <div
          className="settings-dialog-backdrop"
          role="presentation"
          onClick={(e) => {
            if (saving) return;
            if (e.target === e.currentTarget) setEditingOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            className="settings-dialog settings-dialog--rules"
          >
            <div className="settings-dialog-head">
              <div id={titleId} className="settings-dialog-title">
                编辑{scopeLabel}规则
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!saving) setEditingOpen(false);
                }}
                className="ui-btn ui-btn-ghost ui-btn-sm"
                aria-label="关闭全文编辑"
                disabled={saving}
              >
                <Lucide.X size={16} aria-hidden />
              </button>
            </div>

            <div className="settings-dialog-body">
              <p id={descId} className="settings-list-meta" hidden>
                {`保存后写入 ${storagePath} · 成功不提示`}
              </p>
              <textarea
                ref={textareaRef}
                className="settings-field-input settings-dialog-textarea"
                value={editorText}
                onChange={(e) => setEditorText(e.target.value)}
                rows={12}
                spellCheck={false}
                disabled={saving}
                aria-label={`${scopeLabel}规则正文`}
                placeholder="每行一条规则；# 开头为标题"
              />
            </div>

            <div className="settings-dialog-foot">
              <button
                type="button"
                onClick={() => {
                  if (!saving) setEditingOpen(false);
                }}
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={saving}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleSaveRules();
                }}
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={saving}
                aria-busy={saving || undefined}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsPage>
  );
};

