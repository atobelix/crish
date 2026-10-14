import type { SettingsTranslations } from '../../types';

export const settings: SettingsTranslations = {
  // ── Existing 11 keys (Strict backwards compatibility) ──
  title: 'Settings',
  general: 'General',
  language: 'Language',
  theme: 'Theme',
  dark: 'Dark',
  light: 'Light',
  system: 'System',
  fontSize: 'Font Size',
  aboutTitle: 'About',
  license: 'License',
  version: 'Version',

  // ── Settings Frame & Global Actions (frame.*) ──
  'frame.title': 'Settings',
  'frame.searchPlaceholder': 'Search settings...',
  'frame.searchAria': 'Search settings',
  'sidebar.searchCategoriesAria': 'Search settings categories',
  'frame.clearSearch': 'Clear search',
  'frame.emptyResult': 'No matching settings found',
  'frame.close': 'Close settings',
  'frame.closeWithEsc': 'Close (Esc)',
  'frame.closeAria': 'Close settings panel',
  'frame.save': 'Save Changes',
  'frame.saving': 'Saving...',
  'frame.saved': 'Settings saved',
  'frame.saveFailed': 'Failed to save settings',
  'frame.reset': 'Reset to Defaults',
  'frame.resetConfirm':
    'Are you sure you want to restore all default settings? This action cannot be undone.',
  'frame.unsavedChanges':
    'You have unsaved changes. Are you sure you want to exit?',

  // ── 1. General Preferences (general.*) ──
  'general.title': 'General Settings',
  'general.desc':
    'Manage language, startup behavior, and basic interaction preferences',
  'general.language': 'Interface Language',
  'general.languageDesc':
    'Select the display language for the application (takes effect immediately)',
  'general.startupGroup': 'Startup & Exit',
  'general.launchAtLogin': 'Launch at startup',
  'general.launchAtLoginDesc':
    'Start the application in background on system login',
  'general.minimizeToTray': 'Minimize to system tray on close',
  'general.minimizeToTrayDesc':
    'Keep running in the background to avoid interrupting ongoing tasks',
  'general.restoreLastSession': 'Restore last session on startup',
  'general.restoreLastSessionDesc':
    'Automatically reopen active conversations from the previous session',
  'general.sendShortcut': 'Send Message Shortcut',
  'general.sendShortcutDesc':
    'Choose the key combination to send messages in the composer',
  'general.sendShortcutEnter': 'Enter to Send (Shift+Enter for new line)',
  'general.sendShortcutCmdEnter': 'Cmd/Ctrl+Enter to Send (Enter for new line)',
  'general.autoUpdate': 'Automatically check for updates',
  'general.autoUpdateDesc':
    'Check for new releases in the background and notify when available',
  'general.soundEffects': 'Sound Effects',
  'general.soundEffectsDesc':
    'Play audio alerts when tasks finish or require approval',

  // ── 2. Appearance & Typography (appearance.*) ──
  'appearance.title': 'Appearance & Styles',
  'appearance.desc':
    'Customize theme colors, font size, editor indentation, and window styles',
  'appearance.groupTheme': 'Theme Mode',
  'appearance.themeTitle': 'Color Theme',
  'appearance.themeDesc':
    'Choose dark, light, or match your operating system theme',
  'appearance.themeLight': 'Light Mode',
  'appearance.themeDark': 'Dark Mode',
  'appearance.themeSystem': 'System Default',
  'appearance.groupDensity': 'UI Density',
  'appearance.uiDensityTitle': 'Element Density',
  'appearance.uiDensityDesc':
    'Adjust spacing and padding across interface components',
  'appearance.uiDensityCompact': 'Compact',
  'appearance.uiDensityDefault': 'Default',
  'appearance.uiDensitySpacious': 'Spacious',
  'appearance.groupWindow': 'Window Chrome',
  'appearance.windowStyleTitle': 'Window Frame Style',
  'appearance.windowStyleDesc':
    'Select modern inset chromeless or classic title bar style',
  'appearance.windowStyleClassic': 'Classic Title Bar',
  'appearance.windowStyleInset': 'Modern Inset',
  'appearance.groupTypography': 'Typography',
  'appearance.fontSansTitle': 'Interface Font',
  'appearance.fontSansDesc':
    'Sans-serif font used for sidebar, settings, and conversation bubbles',
  'appearance.fontMonoTitle': 'Monospace Font',
  'appearance.fontMonoDesc':
    'High-legibility monospace font used for code blocks, logs, and shell output',
  'appearance.fontSizeTitle': 'Base Font Size',
  'appearance.fontSizeDesc':
    'Adjust overall text scale baseline for the application ({size}px)',
  'appearance.groupCode': 'Code Editor',
  'appearance.codeIndentTitle': 'Code Indentation Width',
  'appearance.codeIndentDesc':
    'Number of spaces used for code block indentation',
  'appearance.codeIndentTwo': '2 Spaces',
  'appearance.codeIndentFour': '4 Spaces',
  'appearance.groupSkin': 'Accent & Skin',
  'appearance.skinPresetTitle': 'Accent Color Preset',
  'appearance.skinPresetDesc':
    'Customize primary brand color and button highlight states',
  'appearance.groupAdvanced': 'Advanced Visual Effects',
  'appearance.nativeWindowFrameTitle': 'Native Window Controls',
  'appearance.nativeWindowFrameDesc':
    'Use operating system native window control buttons',
  'appearance.glowEffectsTitle': 'Glow & Ambient Effects',
  'appearance.glowEffectsDesc':
    'Enable subtle ambient glow on card borders and active focus states',

  // ── 3. Keyboard Shortcuts (shortcuts.*) ──
  'shortcuts.title': 'Keyboard Shortcuts',
  'shortcuts.desc':
    'View and customize keybindings for rapid developer workflows',
  'shortcuts.searchPlaceholder': 'Search shortcuts...',
  'shortcuts.recordTitle': 'Record Keybinding',
  'shortcuts.recordPrompt': 'Press desired key combination...',
  'shortcuts.recording': 'Recording...',
  'shortcuts.resetDefault': 'Reset to default',
  'shortcuts.conflictWarning': 'Shortcut conflicts with "{action}"',
  'shortcuts.groupGlobal': 'Global Shortcuts',
  'shortcuts.groupChat': 'Chat & Composer',
  'shortcuts.groupNavigation': 'Navigation',
  'shortcuts.newChat': 'New Conversation',
  'shortcuts.focusComposer': 'Focus Composer',
  'shortcuts.toggleSidebar': 'Toggle Sidebar',
  'shortcuts.openSettings': 'Open Settings',
  'shortcuts.quickSearch': 'Quick Search',
  'shortcuts.stopGeneration': 'Stop Generation',
  'shortcuts.forceAbort': 'Force Abort All Tasks',
  'shortcuts.clearMessages': 'Clear Screen Messages',
  'shortcuts.zoomIn': 'Zoom In',
  'shortcuts.zoomOut': 'Zoom Out',
  'shortcuts.zoomReset': 'Reset Zoom',

  // ── 4. Models & Inference (models.*) ──
  'models.title': 'Models & Providers',
  'models.desc':
    'Configure large language models, API credentials, and default inference parameters',
  'models.defaultModel': 'Default Model',
  'models.defaultModelDesc':
    'Default base model selected when creating new sessions',
  'models.fastModel': 'Fast Small Model',
  'models.fastModelDesc':
    'Lightweight model used for summaries, classification, and quick code lookups',
  'models.deepThinkingModel': 'Deep Reasoning Model',
  'models.deepThinkingModelDesc':
    'High-capability reasoning model for complex refactoring and architectural planning',
  'models.temperature': 'Temperature',
  'models.temperatureDesc':
    'Controls output randomness (lower is more deterministic, higher is more creative)',
  'models.maxTokens': 'Max Output Tokens',
  'models.maxTokensDesc':
    'Maximum number of tokens permitted in a single model completion',
  'models.topP': 'Top P',
  'models.topPDesc': 'Nucleus sampling threshold for candidate tokens',
  'models.streamResponse': 'Streaming Response',
  'models.streamResponseDesc':
    'Render model completion incrementally as tokens arrive',
  'models.contextWindow': 'Context Window Limit',
  'models.contextWindowDesc':
    'Maximum context tokens retained in active session memory',
  'models.pricingConfig': 'Custom Model Pricing',
  'models.pricingConfigDesc':
    'Configure input and output token rates to calculate development costs',

  // ── 5. Service Providers (provider.*) ──
  'provider.title': 'Service Providers',
  'provider.desc':
    'Manage connections for OpenAI, Anthropic, Gemini, DeepSeek, and local Ollama',
  'provider.addProvider': 'Add Custom Provider',
  'provider.providerName': 'Provider Name',
  'provider.providerType': 'API Protocol Type',
  'provider.apiKey': 'API Key',
  'provider.apiKeyPlaceholder': 'Enter sk-... API key',
  'provider.apiEndpoint': 'API Base Endpoint',
  'provider.apiEndpointPlaceholder': 'https://api.openai.com/v1',
  'provider.testConnection': 'Test Connection',
  'provider.testing': 'Testing connection...',
  'provider.testSuccess': 'Connection successful ({latency}ms latency)',
  'provider.testFailed': 'Connection failed: {reason}',
  'provider.customHeaders': 'Custom Headers',
  'provider.timeoutSeconds': 'Request Timeout (seconds)',
  'provider.statusEnabled': 'Enabled',
  'provider.statusDisabled': 'Disabled',
  'provider.deleteProvider': 'Delete Provider',
  'provider.deleteConfirm':
    'Are you sure you want to delete this provider configuration?',

  // ── 6. Security & Permissions (security.*) ──
  'security.title': 'Security & Permissions',
  'security.desc':
    'Manage shell command approvals, file access whitelists, and security audit rules',
  'security.permissionMode': 'Default Permission Mode',
  'security.permissionModeDesc':
    'Determines agent autonomy level when reading, writing, and executing shell commands',
  'security.modeAsk': 'Ask Mode (Strict Approval)',
  'security.modeDeep': 'Deep Analysis Mode (Read-Only)',
  'security.modePlan': 'Plan Mode (Planning Only)',
  'security.modeFull': 'Full Auto Mode (Autonomous)',
  'security.shellApprovalGroup': 'Command Approval Rules',
  'security.requireApprovalOnHazard':
    'Require approval on dangerous shell commands',
  'security.requireApprovalOnHazardDesc':
    'Enforce secondary confirmation for deletion, formatting, or elevation commands',
  'security.approvalTimeout': 'Approval Timeout (seconds)',
  'security.approvalTimeoutDesc':
    'Automatically reject execution if unhandled within timeout to prevent hanging',
  'security.shellWhitelist': 'Command Whitelist',
  'security.shellWhitelistDesc':
    'List of read-only commands allowed to run without manual approval',
  'security.pathScopeGroup': 'Workspace File Protection',
  'security.preventEscape':
    'Strictly prevent filesystem escape outside workspace',
  'security.preventEscapeDesc':
    'Block any attempt to read sensitive system directories or ancestor paths',
  'security.auditLog': 'Security Audit Log',
  'security.auditLogDesc':
    'Record all tool invocations and authorization decision trails',
  'security.exportAuditLog': 'Export Audit Log',

  // ── 7. Network & Proxy (network.*) ──
  'network.title': 'Network & Proxy',
  'network.desc':
    'Configure HTTP/SOCKS proxy servers and network retry policies',
  'network.proxyMode': 'Proxy Mode',
  'network.proxyModeDesc': 'Select network traffic routing method',
  'network.proxyNone': 'Direct Connection (No Proxy)',
  'network.proxySystem': 'Use System Proxy',
  'network.proxyManual': 'Manual Proxy Configuration',
  'network.proxyHost': 'Proxy Host',
  'network.proxyPort': 'Port',
  'network.proxyAuth': 'Proxy Requires Authentication',
  'network.proxyUsername': 'Username',
  'network.proxyPassword': 'Password',
  'network.testProxy': 'Test Proxy',
  'network.testProxySuccess': 'Proxy connection successful',
  'network.testProxyFailed': 'Proxy connection failed: {error}',
  'network.tlsVerify': 'Verify TLS/SSL Certificates',
  'network.tlsVerifyDesc':
    'Do not disable certificate verification in production environments',
  'network.timeout': 'Connection Timeout (seconds)',
  'network.maxRetries': 'Max Retry Attempts on Failure',

  // ── 8. Notifications & Alerts (notification.*) ──
  'notification.title': 'Notifications & Alerts',
  'notification.desc':
    'Configure desktop banners, mobile push notifications, and quiet hours',
  'notification.desktopGroup': 'Desktop Banners',
  'notification.enableDesktop': 'Enable System Desktop Notifications',
  'notification.enableDesktopDesc':
    'Show notifications when background tasks complete or fail',
  'notification.notifyOnTaskDone': 'Task Completion Alerts',
  'notification.notifyOnApproval': 'Urgent Alerts for Pending Approvals',
  'notification.soundAlert': 'Notification Chime',
  'notification.quietHoursGroup': 'Quiet Hours',
  'notification.enableQuietHours': 'Enable Quiet Hours Mode',
  'notification.enableQuietHoursDesc':
    'Silence notifications during specified hours and summarize in morning digest',
  'notification.quietStart': 'Quiet Hours Start',
  'notification.quietEnd': 'Quiet Hours End',
  'notification.devicesGroup': 'Paired Push Devices',
  'notification.registeredCount': '{count} paired mobile devices',
  'notification.deviceUnregister': 'Unpair Device',

  // ── 9. Privacy & Telemetry (privacy.*) ──
  'privacy.title': 'Privacy & Telemetry',
  'privacy.desc':
    'Manage crash reports, local data retention, and history cleanup',
  'privacy.telemetryGroup': 'Diagnostics & Telemetry',
  'privacy.enableCrashTelemetry':
    'Automatically send crash and exception reports',
  'privacy.enableCrashTelemetryDesc':
    'Only collects anonymized stack traces and error codes; never collects code or conversation content',
  'privacy.enableAnonymousMetrics':
    'Help improve product experience (anonymized metrics)',
  'privacy.localStorageGroup': 'Local Storage & Data',
  'privacy.clearHistoryOnExit': 'Clear temporary sessions on application exit',
  'privacy.clearHistoryOnExitDesc':
    'Permanently remove temporary scratchpads and unsaved conversations',
  'privacy.exportUserData': 'Export All User Data',
  'privacy.exportUserDataDesc':
    'Archive and export all chat history, settings, and custom rules as JSON',
  'privacy.purgeUserData': 'Purge All User Data',
  'privacy.purgeConfirm':
    'This action permanently erases local storage and resets the app. Type DELETE to confirm.',

  // ── 10. Memory & Context (memory.*) ──
  'memory.title': 'Memory & Context',
  'memory.desc':
    'Manage conversation history compression, long-term memory vector store, and context pruning',
  'memory.autoSummarize': 'Automatic Context Compression',
  'memory.autoSummarizeDesc':
    'Automatically summarize older turns when token budget is exceeded',
  'memory.compressionThreshold': 'Compression Trigger Threshold (% of budget)',
  'memory.maxMemoryTurns': 'Retain Recent Uncompressed Turns',
  'memory.longTermMemory': 'Cross-Session Long-Term Memory',
  'memory.longTermMemoryDesc':
    'Allows agent to recall established design rules and preferences from past projects',
  'memory.clearMemoryCache': 'Clear Memory Cache',
  'memory.reindexMemory': 'Rebuild Memory Index',

  // ── 11. Storage & Backups (storage.*) ──
  'storage.title': 'Storage & Backups',
  'storage.desc':
    'Manage database file locations, automatic session backups, and trash retention policies',
  'storage.databaseGroup': 'Local Database',
  'storage.dbPath': 'SQLite Database Path',
  'storage.openDbDir': 'Open in File Explorer',
  'storage.backupGroup': 'Automatic Backups',
  'storage.autoBackupInterval': 'Backup Rotation Frequency',
  'storage.backupDaily': 'Daily',
  'storage.backupWeekly': 'Weekly',
  'storage.backupManualOnly': 'Manual Only',
  'storage.createBackupNow': 'Create Backup Now',
  'storage.trashGroup': 'Trash & Retention',
  'storage.trashRetentionDays': 'Trash Retention Period (Days)',
  'storage.trashRetentionDesc':
    'Deleted sessions older than this duration will be permanently purged',
  'storage.emptyTrash': 'Empty Trash Now',

  // ── 12. Developer Diagnostics (devtools.*) ──
  'devtools.title': 'Developer Diagnostics',
  'devtools.desc':
    'Inspect debug port status, IPC communication logs, and system health checks',
  'devtools.devMode': 'Developer Debug Mode',
  'devtools.devModeDesc':
    'Output verbose logs to console and show debug annotations in UI',
  'devtools.mcpSocket': 'Tauri MCP Socket Channel',
  'devtools.mcpSocketStatus': 'Port 4000 Listening (Official UI Debug Channel)',
  'devtools.cdpNotice': 'Port 9222 / CDP Deprecated',
  'devtools.cdpNoticeDesc':
    'Per AGENTS.md rules, port 9222 is forbidden; always use 4000 Tauri MCP',
  'devtools.exportDiagnostics': 'Export Full Diagnostic Bundle',
  'devtools.dumpStateTree': 'Dump Memory State Tree',
  'devtools.probeStatus': 'Run Full Health Probe',

  // ── 13. Extensions & Plugins (extensions.*) ──
  'extensions.title': 'Extensions & Plugins',
  'extensions.desc':
    'Manage installed MCP tool servers, third-party extensions, and local skills',
  'extensions.installedTab': 'Installed Extensions',
  'extensions.marketTab': 'Extension Market',
  'extensions.mcpGroup': 'Model Context Protocol (MCP) Servers',
  'extensions.addMcpServer': 'Add MCP Server',
  'extensions.mcpServerName': 'Server Name',
  'extensions.mcpCommand': 'Executable Command',
  'extensions.mcpArgs': 'Command Arguments',
  'extensions.mcpEnv': 'Environment Variables',
  'extensions.installSuccess': 'Extension "{name}" installed successfully',
  'extensions.uninstallConfirm': 'Are you sure you want to uninstall "{name}"?',
  'extensions.noExtensions': 'No third-party extensions installed',

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

export default settings;
