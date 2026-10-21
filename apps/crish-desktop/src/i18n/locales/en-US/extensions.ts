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
  'dialog.closeAriaLabel': 'Close dialog',
  'badge.official': 'Official',
  'badge.local': 'Local',
  'badge.machine': 'This computer',
  'badge.thirdParty': 'Third-party',

  'skill.import.truncatedBody':
    'Skill "{name}" is longer than the read limit, so an incomplete copy was not written',
  'skill.import.emptyBody': 'Skill "{name}" is empty and cannot be imported',
  'skill.import.writeFailed': 'Failed to write the skill copy',
  'skill.import.globalWriteUnavailable':
    'This desktop shell cannot write the global skill library yet',
  'skill.import.noDirectory': 'No directory was selected',
  'skill.import.directoryUnreadable':
    'The selected directory could not be read, so it was not registered as an installed skill',
  'skill.import.directoryEmpty':
    'The selected directory has no skill to import',
  'skill.import.allTruncated':
    'The skill text exceeds the read limit, so no incomplete copy was written',
  'skill.import.noneWritten': 'No skill copy was written',
  'skill.import.partial':
    'Imported {imported} skills. {truncated} were skipped because they exceed the read limit',
  'skill.import.importedCount': 'Imported {imported} skills',
  'skill.import.disallowed':
    'Skill "{name}" is disallowed or not adapted, so it was not imported',
  'skill.import.failed': 'Failed to import the skill: {detail}',
  'skill.import.projectEnabled':
    'Imported skill "{name}" into the current workspace and enabled it',
  'skill.import.globalEnabled':
    'Imported skill "{name}" into the global skill library and enabled it',
  'skill.defaultDescription': '{name} skill',
};

export default extensions;
