/**
 * 设置 · 规则状态 hook：作用域加载 / 本机持久化 / 引擎同步链路 /
 * 增删规则与全文保存。渲染层（列表 / 快速添加 / 全文编辑 Dialog）不持有这些逻辑。
 * 成功静默（仅失败提示）；引擎同步降级 toast 见 syncEngineQuiet。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  clientApi,
  normalizeCustomRules,
  type Settings,
} from '../../api/clientApi';
import {
  getWorkspacePath,
  listSettingsScopeProjects,
} from '../../api/projectStore';
import {
  rulesLinesToText,
  syncRulesToDaemon,
  textToRuleLines,
} from '../../api/rulesApi';
import { formatEngineDegradeToast } from '../../hooks/useToastQueue';
import { getSettingsState } from '../../store/storeAccess';
import {
  EMPTY_GLOBAL_TEMPLATE,
  EMPTY_PROJECT_TEMPLATE,
  SCOPE_GLOBAL,
  buildScopeOptions,
  dedupeRuleLines,
  normalizeRuleLine,
  resolveScopeLabel,
  type ScopeKey,
} from './settingsRulesLib';

export type UseRulesStateOptions = {
  onShowToast: (msg: string) => void;
  /** 二级弹层打开时通知父级，避免 Esc 直接关掉整个设置页 */
  onBlockingOverlayChange?: (blocking: boolean) => void;
};

export type UseRulesStateResult = {
  scopeProjects: { path: string; name?: string }[];
  scopeKey: ScopeKey;
  setScopeKey: (v: ScopeKey) => void;
  customRules: string[];
  editorText: string;
  setEditorText: (v: string) => void;
  editingOpen: boolean;
  setEditingOpen: (v: boolean) => void;
  saving: boolean;
  loadError: string | null;
  loaded: boolean;
  isGlobal: boolean;
  scopeLabel: string;
  storagePath: string;
  scopeOptions: { value: string; label: string; hint?: string }[];
  ruleCount: number;
  /** 重新加载（错误重试入口） */
  retryLoad: () => void;
  /** 全文保存：本机写入 + 引擎同步；成功关弹层 */
  handleSaveRules: () => Promise<void>;
  /** 短规则新增：重复/空提示；成功清输入由调用方处理 */
  addRuleIfNew: (text: string) => Promise<boolean>;
  /** 删除单条规则（含引擎同步） */
  handleDeleteCustomRule: (index: number) => void;
};

export function useRulesState(opts: UseRulesStateOptions): UseRulesStateResult {
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
  const [editingOpen, setEditingOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const [loaded, setLoaded] = useState(false);

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
  const scopeLabel = resolveScopeLabel(isGlobal, activeProject, scopeKey);
  const storagePath = isGlobal ? '全局设置' : scopeKey;

  const scopeOptions = useMemo(() => buildScopeOptions(scopeProjects), [scopeProjects]);

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
          opts.onShowToast(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeKey, isGlobal, scopeLabel, opts.onShowToast, loadTick]);

  useEffect(() => {
    opts.onBlockingOverlayChange?.(editingOpen);
    return () => opts.onBlockingOverlayChange?.(false);
  }, [editingOpen, opts.onBlockingOverlayChange]);

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
        getSettingsState().setAppSettings(merged);
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
      opts.onShowToast('更新设置失败：' + String(err));
      return null;
    }
  };

  /**
   * 引擎同步：全成功静默；未连接/失败用降级 toast；截断单独警告。
   */
  const syncEngineQuiet = async (opts2: {
    globalText: string;
    projectText?: string;
  }) => {
    const sync = await syncRulesToDaemon(opts2);
    if (!sync.engineSynced) {
      opts.onShowToast(formatEngineDegradeToast(sync.error));
    } else if (sync.truncated) {
      opts.onShowToast('规则较长，引擎侧已截断');
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
      if (!syncResult.engineSynced) {
        opts.onShowToast('规则已保存到本机，同步到引擎失败');
      } else if (syncResult.truncated) {
        opts.onShowToast('规则较长，引擎侧已截断');
      }
    } finally {
      setSaving(false);
    }
  };

  const addRuleIfNew = async (text: string): Promise<boolean> => {
    if (saving) return false;
    const trimmed = normalizeRuleLine(text);
    if (!trimmed) {
      opts.onShowToast('请输入规则内容');
      return false;
    }
    if (customRules.some((r) => normalizeRuleLine(r) === trimmed)) {
      opts.onShowToast('该规则已存在');
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

  const retryLoad = () => {
    setLoadError(null);
    setLoadTick((n) => n + 1);
  };

  return {
    scopeProjects,
    scopeKey,
    setScopeKey,
    customRules,
    editorText,
    setEditorText,
    editingOpen,
    setEditingOpen,
    saving,
    loadError,
    loaded,
    isGlobal,
    scopeLabel,
    storagePath,
    scopeOptions,
    ruleCount,
    retryLoad,
    handleSaveRules,
    addRuleIfNew,
    handleDeleteCustomRule,
  };
}
