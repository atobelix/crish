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
  'badge.official': '官方',
  'badge.local': '本地',
};

export default extensions;
