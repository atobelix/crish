// Settings dictionary part: sections 13-26, moved out of settings.ts for the RL-03 line budget.
// Keys and values are byte-identical to the original settings.ts; the key set must stay in
// sync with zh-CN/settingsParts.ts. The main settings.ts spreads this object.
import { settingsPartExtensions } from './settingsPartExtensions';

export const settingsPartRest = {
  ...settingsPartExtensions,

  // ── 14. About & Compliance (about.*) ──
  'about.title': 'About Crish Desktop',
  'about.desc':
    'Open source license disclosures, kernel version, and third-party notices',
  'about.appName': 'Crish Desktop',
  'about.appSubtitle': 'Local-First Autonomous Agent Desktop Workbench',
  'about.appVersion': 'App Version',
  'about.kernelVersion': 'Conex Kernel Version',
  'about.runtimeVersion': 'Runtime Version',
  'about.osArch': 'System Architecture',
  'about.licenseName': 'The MIT License',
  'about.licenseNotice':
    'Distributed under permissive open source terms with commercial and academic freedom',
  'about.copyrightHolder': 'Copyright (c) 2026 atobelix',
  'about.thirdPartyNotices':
    'Third-Party Open Source Notices & Legal Compliance',
  'about.viewFullLicense': 'View Full License',
  'about.copySysInfo': 'Copy System Diagnostic Info',
  'about.copySysInfoSuccess': 'System information copied to clipboard',
  'about.githubRepo': 'GitHub Source Repository',
  'about.securityReport': 'Report Security Vulnerability',

  // ── 15. Experimental Labs (experimental.*) ──
  'experimental.title': 'Experimental Features (Labs)',
  'experimental.desc':
    'Preview in-development experimental features (may be unstable)',
  'experimental.warning':
    'Experimental features may change or be removed in future releases. Use caution in production.',
  'experimental.workerPool': 'Web Worker Multi-Window Parsing Offload',
  'experimental.workerPoolDesc':
    'Use background WorkerPool to parse massive Markdown documents and keep main thread smooth',
  'experimental.voiceInput': 'Voice Input & Real-Time Transcription',
  'experimental.voiceInputDesc':
    'Enable speech-to-text composer input using local lightweight Whisper models',
  'experimental.backgroundWatcher': 'Intelligent Workspace File Watcher',
  'experimental.backgroundWatcherDesc':
    'Automatically notify active agent when workspace file tree changes',

  // ── 16. General Preferences Panel (personalize.*) ──
  'personalize.title': 'General',
  'personalize.loadFailed': 'Failed to read settings: {error}',
  'personalize.saveFailed': 'Failed to save settings: {error}',
  'personalize.conversationPrefs': 'Conversation Preferences',
  'personalize.responseStyleTitle': 'Response Style',
  'personalize.responseStyleDesc':
    'Length, detail level, and step-by-step guidance of responses',
  'personalize.styleMinimal': 'Concise',
  'personalize.styleMinimalHint': 'Short and direct to conclusions',
  'personalize.styleStandard': 'Standard',
  'personalize.styleStandardHint': 'Balanced with clear points',
  'personalize.styleDetailed': 'Detailed',
  'personalize.styleDetailedHint': 'Step-by-step with complete details',
  'personalize.styleDeep': 'In-depth',
  'personalize.styleDeepHint': 'Expanded with comprehensive analysis',
  'personalize.sendShortcutTitle': 'Send Message Shortcut',
  'personalize.sendShortcutDesc':
    'Enter to send (Shift+Enter for newline), or Ctrl+Enter to send (Enter for newline)',
  'personalize.sendShortcutEnter': 'Enter to send',
  'personalize.sendShortcutCmdEnter': 'Ctrl+Enter to send',
  'personalize.maxRetryTitle': 'Max Retry Attempts',
  'personalize.maxRetryDesc':
    'Maximum retry attempts (default 10, with exponential backoff; changes save immediately)',
  'personalize.timesUnit': 'times',
  'personalize.hideThinkingTitle': 'Collapse Thinking Process by Default',
  'personalize.hideThinkingDesc':
    'Hide or collapse reasoning chains of deep thinking models by default',
  'personalize.uiPrefs': 'Interface Preferences',
  'personalize.tabModeTitle': 'Merge Right Panels',
  'personalize.tabModeDesc':
    'Combine overview, file tree, and side panels into a unified right tab bar',
  'personalize.collapseChangelogTitle': 'Collapse Changelog by Default',
  'personalize.collapseChangelogDesc':
    'Automatically collapse the version changelog drawer when entering the workbench',
  'personalize.systemTelemetry': 'System & Telemetry',
  'personalize.enableSkillCommandsTitle': 'Enable Inline Slash Commands',
  'personalize.enableSkillCommandsDesc':
    'Allow typing / in composer to trigger quick commands and skills menu',
  'personalize.quietStartupTitle': 'Quiet Startup Logs',
  'personalize.quietStartupDesc':
    'Automatically hide verbose environment loading and initialization logs on launch',
  'personalize.enableAnalyticsTitle': 'Share Anonymous Product Analytics',
  'personalize.enableAnalyticsDesc':
    'Transmit sanitized telemetry containing zero code or private data to improve the software',
  'personalize.enableCrashTelemetryTitle': 'Automatically Collect Error Logs',
  'personalize.enableCrashTelemetryDesc':
    'Automatically collect diagnostic logs on unexpected termination for stability troubleshooting',
  'personalize.onboardingSection': 'First-Run & Onboarding',
  'personalize.showOnboardingTitle': 'Show onboarding wizard on startup',
  'personalize.showOnboardingDesc':
    'When enabled, the onboarding wizard is shown every time the app opens; when disabled, the main workspace opens directly',
  'personalize.openWizardTitle': 'First-run onboarding wizard',
  'personalize.openWizardDesc':
    'View the initial setup wizard anytime, with step-by-step preview or jump directly to a step',
  'personalize.openWizardBtn': 'Open Wizard Now',
  'personalize.previewStepsTitle': 'Preview wizard steps directly',
  'personalize.previewStepsAria': 'First-run wizard steps list',
  'personalize.wizardStep0': 'Configure Provider',
  'personalize.wizardStep1': 'Enable Model',
  'personalize.wizardStep2': 'Select Workspace',
  'personalize.wizardStep3': 'Get Started',

  // ── 17. Sidebar & Panel Category Tabs (tabs.* / groups.*) ──
  'tabs.profile': 'Account',
  'tabs.appearance': 'Appearance',
  'tabs.personalize': 'General',
  'tabs.archive': 'Archived',
  'tabs.models': 'Models',
  'tabs.plugins': 'Extensions',
  'tabs.usage': 'Usage',
  'tabs.devices': 'Devices',
  'tabs.schedule': 'Schedule',
  'tabs.rules': 'Rules',
  'tabs.shortcuts': 'Shortcuts',
  'tabs.browser': 'Browser',
  'tabs.security': 'Security',
  'tabs.diagnostics': 'Diagnostics',
  'tabs.about': 'About',
  'groups.personal': 'Personal',
  'groups.intelligence': 'Intelligence',
  'groups.workspace': 'Workspace',
  'groups.security': 'Security',
  'groups.about': 'About',

  // ── 18. Account Settings Panel (profile.*) ──
  'profile.title': 'Account',
  'profile.dataLocation': 'Local SQLite Database',
  'profile.connecting': 'Connecting...',
  'profile.connected': 'Connected',
  'profile.notConnected': 'Not connected',
  'profile.connectionFailed': 'Connection failed: {error}',
  'profile.exportFailed': 'Export failed: {error}',
  'profile.invalidJson': 'Import failed: Not a valid JSON file',
  'profile.rootMustBeObject': 'Import failed: Root must be an object',
  'profile.importFailed': 'Import failed: {error}',
  'profile.serviceDisconnected': 'Service disconnected',
  'profile.connAbnormal': 'Connection Issue',
  'profile.flowbitSection': 'Flowbit Account & Multi-Device Sync',
  'profile.currentEnvSection': 'Current Environment',
  'profile.currentProject': 'Current Project',
  'profile.localWorkspace': 'Local workspace',
  'profile.noProjectOpen': 'No project open',
  'profile.dataSection': 'Data Storage & Backup',
  'profile.sessionData': 'Session Data',
  'profile.savedLocallyOnly': 'Stored locally only',
  'profile.noCloudUpload': 'Not uploaded to cloud',
  'profile.localDevice': 'Local',
  'profile.storageLocation': 'Storage Location',
  'profile.appDataDir': 'App data directory',
  'profile.settingsBackup': 'Settings Backup',
  'profile.exportImportConfig': 'Export or import configuration',
  'profile.exporting': 'Exporting...',
  'profile.exportBackup': 'Export Backup',
  'profile.exportingShort': 'Exporting...',
  'profile.exportBtn': 'Export',
  'profile.importing': 'Importing...',
  'profile.importBackup': 'Import from Backup',
  'profile.importingShort': 'Importing...',
  'profile.importBtn': 'Import',
  'profile.advancedSection': 'Advanced',
  'profile.coreConn': 'Core Connection',
  'profile.coreConnDesc':
    'Tauri IPC in-process core (no WS host); tests core readiness',
  'profile.testing': 'Testing...',
  'profile.testBtn': 'Test Connection',

  // ── 19. Archived Sessions Management (archive.*) ──
  'archive.pageTitle': 'Archived',
  'archive.restoredSession': 'Restored session: {title}',
  'archive.restoredAllCount': 'Restored {count} sessions',
  'archive.deletedSession': 'Deleted session: {title}',
  'archive.clearedAllCount': 'Cleared {count} archived sessions',
  'archive.resultsCount': '{count} results',
  'archive.itemsCount': '{count} items',
  'archive.searchPlaceholder': 'Search...',
  'archive.searchAria': 'Search archived sessions',
  'archive.clearFilterAria': 'Clear filter',
  'archive.clearFilterBtnText': 'Clear',
  'archive.clearFilterBtn': 'Clear filter',
  'archive.restoreAll': 'Restore All',
  'archive.clearAllBtnText': 'Clear',
  'archive.noMatchForQuery': 'No matches for "{query}"',
  'archive.noArchivedSessions': 'No archived sessions',
  'archive.msgCount': '{count} messages',
  'archive.restoreAndOpen': 'Restore and open conversation',
  'archive.restoreToSidebar': 'Restore to sidebar list',
  'archive.deletePermanently': 'Delete permanently',
  'archive.deletePermanentlyAria': 'Delete {title} permanently',
  'archive.clearConfirmTitle': 'Clear Archived Sessions',
  'archive.deleteConfirmTitle': 'Delete Session',
  'archive.clearConfirmDesc':
    'Are you sure you want to permanently delete all {count} archived sessions? This cannot be undone.',
  'archive.deleteSingleConfirmDesc':
    'Are you sure you want to permanently delete session "{title}"? This cannot be undone.',
  'archive.deleteAllConfirmBtn': 'Delete All',

  // ── 20. Multi-Device & Pairing (devices.*) ──
  'devices.pageTitle': 'Devices',
  'devices.deviceRevoked':
    'Device revoked (token invalidated and disconnected)',
  'devices.revokeFailed':
    'Revocation failed: Device not found or already revoked',
  'devices.pairingModeSection': 'Pairing Mode',
  'devices.serviceTitle': 'Multi-Device Service',
  'devices.serviceRunningDesc':
    'Service running - Stopping service will disconnect all paired devices',
  'devices.stopService': 'Stop Service',
  'devices.enableLanPairing': 'Enable LAN Pairing',
  'devices.enableLanPairingDesc':
    'Generate a one-time pairing code for mobile devices to scan and connect',
  'devices.pairingSwitchAria': 'Pairing mode toggle',
  'devices.pairCodeExpiredHint':
    'Pairing enabled but pairing code expired. Toggle the switch above to generate a new code.',
  'devices.serviceOffTitle': 'Multi-Device Service Not Running',
  'devices.serviceOffDesc':
    'When enabled, this device can be discovered and connected by local network devices',
  'devices.startService': 'Start Service',
  'devices.scanQrSection': 'Scan QR Code to Pair',
  'devices.qrCodeAria': 'Pairing QR code',
  'devices.copyPairCode': 'Copy Pairing Code',
  'devices.remainingTime': 'Remaining time:',
  'devices.closePairing': 'Close Pairing',
  'devices.revokeConfirmTitle': 'Revoke Device',
  'devices.revokeConfirmDesc':
    'The device will be disconnected immediately and its token invalidated. Re-pairing will be required. Confirm revocation?',
  'devices.revokeConfirmBtn': 'Revoke',
  'devices.closePairingConfirmTitle': 'Close Pairing',
  'devices.closePairingConfirmDesc':
    'Closing pairing will revoke all paired devices and disconnect them (tokens invalidated, connected devices disconnected immediately). Confirm closing pairing?',
  'devices.closePairingConfirmBtn': 'Close Pairing',

  // ── 21. Custom Rules (rules.*) ──
  'rules.pageTitle': 'Rules',
  'rules.selectProjectFirst': 'Please select a project first',
  'rules.reloadRulesAria': 'Reload rules',
  'rules.scopeLabel': 'Rule Scope',
  'rules.editFullTextTooltip': 'Edit {scope} full text',
  'rules.editFullTextAria': 'Edit {scope} full text',
  'rules.editFullText': 'Edit Full Text',
  'rules.currentRulesSection': 'Current Rules ({scope})',
  'rules.noRulesYet': 'No rules yet',
  'rules.noRulesDesc': 'Click common presets below or enter your own',
  'rules.deleteRuleTooltip': 'Delete this rule',
  'rules.deleteRuleAria': 'Delete rule: {rule}',
  'rules.quickAddSection': 'Quick Add',
  'rules.presetsTitle': 'Common',
  'rules.presetsDesc': 'One-click add',
  'rules.presetAlreadyAdded': 'Already added',
  'rules.addPresetTooltip': 'Add: {preset}',
  'rules.presetAlreadyAddedAria': 'Already added: {preset}',
  'rules.addPresetAria': 'Add preset: {preset}',
  'rules.customTitle': 'Custom',
  'rules.customDesc': 'Enter to add',
  'rules.customRulePlaceholder': 'Write a rule...',
  'rules.customRuleAria': 'Custom rule',
  'rules.addShortRuleTooltip': 'Add short rule to {scope}',
  'rules.addRuleAria': 'Add rule',

  // ── 22. Scheduled Tasks (schedule.*) ──
  'schedule.pageTitle': 'Scheduled Tasks',
  'schedule.taskListSection': 'Task List',
  'schedule.createAi': 'Create with AI (Recommended)',
  'schedule.createManual': 'Create Manually',
  'schedule.defaultTaskName': 'Scheduled Task',
  'schedule.defaultPrompt': 'Execute scheduled task on plan',
  'schedule.tag': 'Schedule',
  'schedule.aiCreateTitle': 'Create Scheduled Task via Chat',
  'schedule.injectSuccessToast':
    'Scheduled task creation prompt inserted into chat. Return to chat to complete.',
  'schedule.noActiveSessionToast':
    'No active session. Unable to insert task creation prompt.',
  'schedule.toolbarAria': 'Filter and new task',
  'schedule.filterAria': 'Task filter',
  'schedule.collapse': 'Collapse',
  'schedule.new': 'New',
  'schedule.createModeAria': 'Creation mode',
  'schedule.runHistorySection': 'Execution History',
  'schedule.runCount': '{count} runs total',

  // ── 23. Security & Approvals (security.*) ──
  'security.invalidCommand': 'Invalid command',
  'security.addFailed': 'Failed to add: {error}',
  'security.removeFailed': 'Failed to remove: {error}',
  'security.clearFailed': 'Failed to clear: {error}',
  'security.permChangeFailed': 'Failed to change permission mode: {error}',
  'security.whitelistMatchHint':
    'Matches the full command; arguments may follow without matching unintended similar names',
  'security.whitelistRememberHint':
    'High-risk commands (e.g. rm, format) are not auto-approved - whitelist is approval memory only, execution is determined by the engine permission mode',
  'security.pressEnterToAdd': 'Press Enter to add',
  'security.permissionSection': 'Permissions',
  'security.morePaths': '+{count} more',
  'security.noOpenProjects': 'No open projects',
  'security.noOpenProjectsDesc': 'Projects will be displayed here once opened',
  'security.trustedCommandsSection': 'Trusted Commands',
  'security.addCommandTitle': 'Add Command',
  'security.addCommandDesc':
    'Add to approval memory (execution determined by engine)',
  'security.cmdInputPlaceholder': 'e.g. git status',
  'security.cmdInputAria': 'Command to trust',
  'security.addToWhitelistTooltip': 'Add to whitelist (approval memory)',
  'security.enterCmdTooltip': 'Please enter a command',
  'security.addCommandAria': 'Add command',
  'security.clearAllTooltip':
    'Clear all {count} commands (requires confirmation)',
  'security.clearAllAria': 'Clear all {count} whitelisted commands',
  'security.confirmClearPrompt':
    'Are you sure you want to clear all whitelisted commands? This action cannot be undone.',
  'security.presetsTitle': 'Common Presets',
  'security.presetsDesc': 'Click to add to trusted commands',
  'security.cmdAlreadyAdded': 'Already added',
  'security.addCmdPrompt': 'Add {cmd}',
  'security.cmdAlreadyAddedAria': '{cmd} already added',
  'security.addCmdAria': 'Add {cmd}',
  'security.trustedCommandsCount': 'Trusted Commands ({count})',
  'security.noTrustedCommands': 'No trusted commands yet',
  'security.noTrustedCommandsDesc':
    'Enter a command above and add it, or click common presets',
  'security.trustedCmdNote':
    'Approval memory: Matches still subject to engine verdict per current permission mode',
  'security.removeCmdTooltip': 'Remove {cmd}',
  'security.removeCmdAria': 'Remove {cmd}',

  // ── 24. Shortcuts Recording & Filtering (shortcuts.*) ──
  'shortcuts.saveFailed': 'Failed to save: Unable to write shortcuts',
  'shortcuts.customized': 'Customized',
  'shortcuts.noMatch': 'No matches for "{query}"',
  'shortcuts.empty': 'No shortcuts available',
  'shortcuts.noMatchDesc': 'Try shorter keywords or clear filter',
  'shortcuts.clearFilterAria': 'Clear filter and show all shortcuts',
  'shortcuts.clearFilter': 'Clear filter',
  'shortcuts.restoreDefaultTooltip': 'Restore default: {default}',
  'shortcuts.restoreDefaultAria': 'Restore "{label}" to default {default}',
  'shortcuts.recordingTooltip': 'Recording keybinding, Esc to cancel',
  'shortcuts.currentKeyTooltip': 'Current: {key}, click to re-record',
  'shortcuts.recordingAria':
    'Recording "{label}", press keys to set, Esc to cancel',
  'shortcuts.currentKeyAria': '"{label}" current {key}, click to re-record',

  // ── 25. Usage & History (usage.*) ──
  'usage.range24h': 'Past 24 Hours',
  'usage.range7d': 'Past 7 Days',
  'usage.range30d': 'Past 30 Days',
  'usage.migratedPrices':
    'Migrated {count} legacy pricing entries to model configuration',
  'usage.migrateFailed': 'Failed to migrate legacy pricing: {error}',
  'usage.fetchFailed': 'Failed to fetch usage data',
  'usage.clearHistoryTitle': 'Clear Usage History',
  'usage.clearHistoryDesc':
    'Are you sure you want to clear all local usage history? This action cannot be undone.',
  'usage.clearHistoryConfirm': 'Confirm Clear',
  'usage.clearSuccess': 'Usage history cleared',
  'usage.clearFailed': 'Failed to clear history',
  'usage.configurePricingTooltip':
    'Configure model token input, output, and request pricing',
  'usage.configurePricing': 'Configure Pricing',
  'usage.title': 'Usage',
  'usage.refreshTooltip': 'Refresh usage throughput and cost statistics',
  'usage.refreshData': 'Refresh Data',
  'usage.clearHistoryTooltip':
    'Clear all historical usage metrics stored locally',
  'usage.clearHistory': 'Clear History',

  // ── 26. Navigation & About Actions (nav.* / about.*) ──
  'nav.categories': 'Settings Categories',
  'about.collapseThirdPartyLicenses': 'Collapse Third-Party Licenses',
  'about.viewThirdPartyLicenses': 'View Third-Party Licenses',
};
