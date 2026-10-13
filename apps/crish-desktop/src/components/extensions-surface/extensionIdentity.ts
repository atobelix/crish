/**
 * extensionIdentity.ts
 * 扩展身份识别与去重单一真理源 (SSOT)
 */

export const CANONICAL_IMPORT_PLUGIN_ID = '@crish/plugin-import-claude-codex';

/**
 * 无论 ID 带有 plugin: 前缀、包名 @crish/plugin-import-claude-codex 还是 manifest ID @crish/import-claude-codex，
 * 均收敛判定为同一个对话导入与接续插件。
 */
export function isImportClaudeCodexPlugin(
  itemOrId:
    | string
    | { id?: string; name?: string; pluginId?: string; installRef?: string }
    | null
    | undefined
): boolean {
  if (!itemOrId) return false;
  const id = typeof itemOrId === 'string' ? itemOrId : itemOrId.id || '';
  const pluginId = typeof itemOrId === 'object' ? itemOrId.pluginId : undefined;
  const installRef =
    typeof itemOrId === 'object' ? itemOrId.installRef : undefined;
  const name = typeof itemOrId === 'object' ? itemOrId.name : undefined;

  const normalize = (s?: string) =>
    (s || '').toLowerCase().replace(/^plugin:/, '');
  const candidates = [id, pluginId, installRef].map(normalize);

  if (
    candidates.some(
      (c) =>
        c === '@crish/import-claude-codex' ||
        c === '@crish/plugin-import-claude-codex' ||
        c.includes('import-claude-codex')
    )
  ) {
    return true;
  }

  if (name) {
    const n = name.toLowerCase();
    if (
      (n.includes('对话导入') ||
        n.includes('对话接续') ||
        n.includes('claude/codex')) &&
      !n.includes('文档')
    ) {
      return true;
    }
  }

  return false;
}
