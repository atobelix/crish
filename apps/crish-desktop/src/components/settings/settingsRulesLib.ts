/**
 * 设置 · 规则纯函数层：预设文案 / 空模板 / 单行规范化 / 去重 / 作用域派生。
 * 从 SettingsRulesTab.tsx 抽出，零副作用，可独立单测。
 */
import { normalizeSettingsText } from '../../api/clientApi';
import { projectFolderLabel } from '../../api/projectStore';

/** 作用域：global 或项目路径 */
export type ScopeKey = string;
export const SCOPE_GLOBAL = 'global';

/** 常用规则预设 */
export const RULE_PRESETS: string[] = [
  '修改前先说明方案并等待确认',
  '保持既有代码风格，不随意重构无关代码',
  '提交前确保通过 lint / 测试',
  '不要提交密钥、token 或本地环境文件',
  '优先最小改动，避免大范围无关修改',
];

/** 空全文模板 */
export const EMPTY_GLOBAL_TEMPLATE = '# 全局规则\n\n';
export const EMPTY_PROJECT_TEMPLATE = '# 项目规则\n\n';

/** 规范化单条规则 */
export function normalizeRuleLine(raw: string): string {
  return normalizeSettingsText(raw);
}

/** 去重（保留首个出现顺序） */
export function dedupeRuleLines(lines: string[]): string[] {
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

/** 当前作用域中文标签（项目缺失时回落目录名） */
export function resolveScopeLabel(
  isGlobal: boolean,
  activeProject: { name?: string } | null,
  scopeKey: string,
): string {
  if (isGlobal) return '全局';
  return activeProject?.name || projectFolderLabel(scopeKey);
}

/** 作用域下拉选项（全局 + 已打开项目） */
export function buildScopeOptions(scopeProjects: { path: string; name?: string }[]): {
  value: string;
  label: string;
  hint?: string;
}[] {
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
}
