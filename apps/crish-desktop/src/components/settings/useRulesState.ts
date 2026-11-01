/**
 * 设置 · 规则状态 hook：作用域加载 / 本机持久化 / 引擎同步链路 / 全文保存。
 * 渲染层是常驻全文编辑器（进页即可编辑、显式保存），不持有这些逻辑。
 * 成功静默（仅失败提示）；保存链路与原全文编辑弹层完全一致：
 * 解析行 → 本机写入 → 引擎同步，失败/降级才 toast。
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
import { getSettingsState } from '../../store/storeAccess';
import { toast } from '../../services/toast/ToastContext';
import {
  EMPTY_GLOBAL_TEMPLATE,
  EMPTY_PROJECT_TEMPLATE,
  SCOPE_GLOBAL,
  buildScopeOptions,
  dedupeRuleLines,
  resolveScopeLabel,
  type ScopeKey,
} from './settingsRulesLib';

export type UseRulesStateResult = {
  scopeKey: ScopeKey;
  setScopeKey: (v: ScopeKey) => void;
  editorText: string;
  setEditorText: (v: string) => void;
  /** 编辑器内容与上次加载/保存的基线不一致（保存按钮可用性） */
  dirty: boolean;
  saving: boolean;
  loadError: string | null;
  loaded: boolean;
  scopeLabel: string;
  storagePath: string;
  scopeOptions: { value: string; label: string; hint?: string }[];
  /** 重新加载（错误重试入口） */
  retryLoad: () => void;
  /** 全文保存：本机写入 + 引擎同步；成功静默 */
  handleSaveRules: () => Promise<void>;
};

export function useRulesState(): UseRulesStateResult {
  /** 已打开过的项目 + 当前 cwd（文件夹名） */
  const [scopeProjects, setScopeProjects] = useState(() =>
    listSettingsScopeProjects()
  );

  const [scopeKey, setScopeKey] = useState<ScopeKey>(() => {
    const projects = listSettingsScopeProjects();
    const cwd = getWorkspacePath() || '';
    if (cwd) {
      const hit = projects.find(
        (p) =>
          p.path.replace(/\\/g, '/').toLowerCase() ===
          cwd.replace(/\\/g, '/').toLowerCase()
      );
      return hit?.path || cwd || SCOPE_GLOBAL;
    }
    return SCOPE_GLOBAL;
  });
  const [editorText, setEditorText] = useState(EMPTY_GLOBAL_TEMPLATE);
  /** 已落盘基线文本：加载与每次保存成功后同步更新，dirty 与之比对 */
  const [savedText, setSavedText] = useState(EMPTY_GLOBAL_TEMPLATE);
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
              scopeKey.replace(/\\/g, '/').toLowerCase()
          ) || null
        : null,
    [isGlobal, scopeKey, scopeProjects]
  );
  const scopeLabel = resolveScopeLabel(isGlobal, activeProject, scopeKey);
  const storagePath = isGlobal ? '全局设置' : scopeKey;

  const scopeOptions = useMemo(
    () => buildScopeOptions(scopeProjects),
    [scopeProjects]
  );

  const dirty = editorText !== savedText;

  // 项目列表随打开/关闭变化
  useEffect(() => {
    const sync = () => setScopeProjects(listSettingsScopeProjects());
    sync();
    window.addEventListener('crish-project-changed', sync);
    return () => window.removeEventListener('crish-project-changed', sync);
  }, []);

  /** 按作用域加载规则（全局 or 具体项目路径）；切换作用域即换载该作用域全文 */
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
        const text =
          lines.length > 0
            ? rulesLinesToText(
                lines,
                isGlobal ? '# 全局规则' : `# ${scopeLabel} 规则`
              )
            : isGlobal
              ? EMPTY_GLOBAL_TEMPLATE
              : EMPTY_PROJECT_TEMPLATE;
        setEditorText(text);
        setSavedText(text);
        setLoadError(null);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          const msg = '读取规则失败：' + String(err);
          setLoadError(msg);
          setLoaded(false);
          toast.show(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scopeKey, isGlobal, scopeLabel, loadTick]);

  /**
   * 本机写入当前作用域 customRules；成功静默，并把编辑器文本规范化为
   * 落盘形态（行重组）且同步 dirty 基线。
   * @returns 合并后的行；失败已 toast 并返回 null
   */
  const persistCustomRules = async (
    rules: string[]
  ): Promise<string[] | null> => {
    const safe = dedupeRuleLines(normalizeCustomRules(rules));
    try {
      if (isGlobal) {
        const merged = await clientApi.saveSettingsEx('__global__', 'global', {
          customRules: safe,
        } as Partial<Settings>);
        const next = dedupeRuleLines(
          normalizeCustomRules(merged.customRules ?? safe)
        );
        getSettingsState().setAppSettings(merged);
        const text =
          next.length > 0
            ? rulesLinesToText(next, '# 全局规则')
            : EMPTY_GLOBAL_TEMPLATE;
        setEditorText(text);
        setSavedText(text);
        return next;
      }
      await clientApi.saveSettingsEx(scopeKey, 'project', {
        customRules: safe,
      } as Partial<Settings>);
      const text =
        safe.length > 0
          ? rulesLinesToText(safe, `# ${scopeLabel} 规则`)
          : EMPTY_PROJECT_TEMPLATE;
      setEditorText(text);
      setSavedText(text);
      return safe;
    } catch (err) {
      toast.show('更新设置失败：' + String(err));
      return null;
    }
  };

  const handleSaveRules = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const lines = dedupeRuleLines(textToRuleLines(editorText));
      const saved = await persistCustomRules(lines);
      if (!saved) return;
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
                gl.length > 0
                  ? rulesLinesToText(gl, '# 全局规则')
                  : EMPTY_GLOBAL_TEMPLATE;
            } catch {
              /* keep empty template */
            }
            return syncRulesToDaemon({
              globalText,
              projectText: editorText,
            });
          })();
      if (!syncResult.engineSynced) {
        toast.show('规则已保存到本机，同步到引擎失败');
      } else if (syncResult.truncated) {
        toast.show('规则较长，引擎侧已截断');
      }
    } finally {
      setSaving(false);
    }
  };

  const retryLoad = () => {
    setLoadError(null);
    setLoadTick((n) => n + 1);
  };

  return {
    scopeKey,
    setScopeKey,
    editorText,
    setEditorText,
    dirty,
    saving,
    loadError,
    loaded,
    scopeLabel,
    storagePath,
    scopeOptions,
    retryLoad,
    handleSaveRules,
  };
}
