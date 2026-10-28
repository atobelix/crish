/**
 * 扩展面（插件 / 技能 / MCP 服务）文案词典。
 * 动作决议 verb 与展示文案分离：模型层只产 verb，文案经
 * extensionVerbLabelKey 映射到本词典。
 */
const extensions = {
  'tab.plugins': '插件',
  'tab.skills': '技能',
  'tab.mcp': 'MCP 服务',

  'card.installing': '处理中',
  'verb.install': '安装',
  'verb.import': '导入',
  'verb.uninstall': '卸载',
  'verb.delete': '删除',

  'toast.mcpEnabled': '已启用 MCP 服务 {name}',
  'toast.mcpDisabled': '已停用 MCP 服务 {name}',
  'toast.pluginInstalled': '已安装插件「{name}」',
  'toast.gotoImport': '「{name}」请到导入页完成安装',
  'toast.pluginMakerStarted':
    '已开启插件制作对话，正在由插件制作助手引导您设计与构建插件',

  'session.pluginMakerTitle': '制作新插件',
  'session.pluginMakerPrompt':
    '/skill:plugin 我想制作一个新的 Crish 插件，请引导我选择插件的方向与功能',

  'mcp.importNoWrite': '导入 MCP 服务「{name}」没有写入设置',
  'mcp.imported': '已导入 MCP 服务「{name}」',
  'mcp.importFailed': '导入 MCP 失败：{detail}',
  'mcp.notFound': '未找到可卸载的 MCP 服务「{name}」',
  'mcp.uninstalled': '已卸载 MCP 服务「{name}」',
  'mcp.uninstallFailed': '卸载 MCP 失败：{detail}',

  'skill.nameEmpty': '技能名称为空，无法卸载',
  'skill.uninstalledDeleted': '已卸载并删除技能「{name}」',
  'skill.uninstalled': '已卸载技能「{name}」',

  'plugin.uninstalled': '已卸载插件「{name}」',
  'plugin.deleted': '已删除插件「{name}」',
  'plugin.fromFileDescription': '从文件导入的插件',

  'generic.uninstalled': '已卸载「{name}」',
  'generic.noInstallRecord': '「{name}」没有可卸载的安装记录',

  'officialPlugin.name': '外部历史对话接续与导入',
  'officialPlugin.description':
    '探测并接续本机 Claude 与 Codex 会话记录，一键导入迁移',
  'panel.title': '插件安装与卸载',
  'panel.description': '安装或卸载本机插件。从文件导入的插件可以随时删除。',
  'panel.fromFileLabel': '从文件导入...',
  'dialog.closeAriaLabel': '关闭弹窗',
  'badge.official': '官方',
  'badge.local': '本地',
  'badge.machine': '本机',
  'badge.thirdParty': '三方',

  'skill.import.truncatedBody':
    '技能「{name}」正文超过读取上限，未写入不完整副本',
  'skill.import.emptyBody': '技能「{name}」正文为空，无法导入',
  'skill.preview.noBody': '_（无正文）_',
  'skill.preview.ariaLabel': '技能预览',
  'skill.preview.createHint': '新建技能后在此预览',
  'skill.preview.selectHint': '选择左侧技能',
  'skill.preview.system': '系统',
  'skill.preview.disableModelAria': '禁止模型自动调用',
  'skill.preview.disableModel': '禁自动',
  'skill.preview.copySlash': '复制斜杠命令',
  'skill.preview.copyCommandAria': '复制命令 {command}',
  'skill.preview.openLocation': '在文件管理器中打开位置',
  'skill.preview.openLocationAria': '打开技能文件位置',
  'skill.preview.openPathFailed': '无法打开路径（需桌面壳）',
  'skill.preview.activationAria': '{name} 启用状态',
  'skill.preview.setActivationAria': '设为{label}',
  'skill.preview.switchToPreview': '切换为预览',
  'skill.preview.switchToRaw': '切换为原文',
  'skill.preview.preview': '预览',
  'skill.preview.raw': '原文',
  'skill.preview.rawAria': '技能原文',
  'skill.preview.emptyPlaceholder': '暂无技能正文',
  'skill.import.writeFailed': '写入技能副本失败',
  'skill.import.globalWriteUnavailable': '桌面壳还不能写入全局技能库',
  'skill.import.noDirectory': '未选择目录',
  'skill.import.directoryUnreadable':
    '无法读取所选目录，未把它登记为已安装技能',
  'skill.import.directoryEmpty': '所选目录里没有可导入的技能',
  'skill.import.allTruncated': '技能正文超过读取上限，没有写入不完整副本',
  'skill.import.noneWritten': '没有写入任何技能副本',
  'skill.import.partial':
    '已导入 {imported} 个技能，另有 {truncated} 个因正文超过读取上限未写入',
  'skill.import.importedCount': '已导入 {imported} 个技能',
  'skill.import.disallowed': '技能「{name}」属于不合规或未适配脚本，已禁止导入',
  'skill.import.failed': '导入技能失败：{detail}',
  'skill.import.projectEnabled': '已成功将技能「{name}」导入当前工作区并启用',
  'skill.import.globalEnabled': '已成功将技能「{name}」导入全局技能库并启用',
  'skill.defaultDescription': '{name} 技能',
};

export default extensions;
