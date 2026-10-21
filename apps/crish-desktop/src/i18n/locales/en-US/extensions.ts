/**
 * Extensions surface (plugins / skills / MCP servers) dictionary.
 * Action resolution (verb) is separated from display copy: the model
 * layer yields verbs only; copy resolves via extensionVerbLabelKey.
 */
const extensions = {
  'tab.plugins': 'Plugins',
  'tab.skills': 'Skills',
  'tab.mcp': 'MCP Servers',

  'card.installing': 'Working…',
  'verb.install': 'Install',
  'verb.import': 'Import',
  'verb.uninstall': 'Uninstall',
  'verb.delete': 'Delete',

  'toast.mcpEnabled': 'MCP server {name} enabled',
  'toast.mcpDisabled': 'MCP server {name} disabled',
  'toast.pluginInstalled': 'Plugin "{name}" installed',
  'toast.gotoImport': '"{name}" — finish installation on the import page',
  'toast.pluginMakerStarted':
    'Plugin maker session started — the assistant will guide you through designing and building the plugin',

  'session.pluginMakerTitle': 'Make a Plugin',
  'session.pluginMakerPrompt':
    '/skill:plugin I want to build a new Crish plugin. Guide me through choosing its direction and features.',

  'mcp.importNoWrite':
    'Importing MCP server "{name}" did not persist to settings',
  'mcp.imported': 'MCP server "{name}" imported',
  'mcp.importFailed': 'MCP import failed: {detail}',
  'mcp.notFound': 'No uninstallable MCP server "{name}" found',
  'mcp.uninstalled': 'MCP server "{name}" uninstalled',
  'mcp.uninstallFailed': 'MCP uninstall failed: {detail}',

  'skill.nameEmpty': 'Skill name is empty; cannot uninstall',
  'skill.uninstalledDeleted': 'Skill "{name}" uninstalled and deleted',
  'skill.uninstalled': 'Skill "{name}" uninstalled',

  'plugin.uninstalled': 'Plugin "{name}" uninstalled',
  'plugin.deleted': 'Plugin "{name}" deleted',
  'plugin.fromFileDescription': 'Plugin imported from file',

  'generic.uninstalled': '"{name}" uninstalled',
  'generic.noInstallRecord': '"{name}" has no installation record to uninstall',

  'officialPlugin.name': 'External history import',
  'officialPlugin.description':
    'Detect and resume local Claude and Codex session histories; import and migrate in one click',
  'panel.title': 'Plugin Install & Uninstall',
  'panel.description':
    'Install or uninstall local plugins. Plugins imported from files can be deleted anytime.',
  'panel.fromFileLabel': 'From file...',
  'badge.official': 'Official',
  'badge.local': 'Local',
};

export default extensions;
