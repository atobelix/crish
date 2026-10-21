/**
 * 扩展卡片上唯一的动作决议。
 * 发现/精选：安装 ↔ 卸载。导入：导入 ↔ 卸载。文件插件：删除。
 * 模型层只产 verb（行为决议）；展示文案由 extensionVerbLabelKey 映射
 * i18n key，在视图层经 t() 解析（文案不进模型）。
 */

export type ExtensionPlacement = 'catalog' | 'import' | 'custom';

export type ExtensionVerbName = 'install' | 'import' | 'uninstall' | 'delete';

export interface ExtensionVerb {
  verb: ExtensionVerbName;
}

const VERB_LABEL_KEY: Record<ExtensionVerbName, string> = {
  install: 'extensions.verb.install',
  import: 'extensions.verb.import',
  uninstall: 'extensions.verb.uninstall',
  delete: 'extensions.verb.delete',
};

export function extensionVerbLabelKey(verb: ExtensionVerbName): string {
  return VERB_LABEL_KEY[verb];
}

export function resolveExtensionVerb(input: {
  placement: ExtensionPlacement;
  installed: boolean;
}): ExtensionVerb {
  if (input.placement === 'custom') {
    return { verb: 'delete' };
  }
  if (input.installed) {
    return { verb: 'uninstall' };
  }
  if (input.placement === 'import') {
    return { verb: 'import' };
  }
  return { verb: 'install' };
}
