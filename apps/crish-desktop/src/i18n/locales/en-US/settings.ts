import type { SettingsTranslations } from '../../types';
import { settingsPartRest } from './settingsParts';
import { settingsPartModels } from './settingsModels';

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
  'appearance.micaTitle': 'Mica Backdrop Effect (Windows 11)',
  'appearance.micaDesc':
    'Enable system-level Mica backdrop translucency effect (disabled by default to preserve pure theme palette)',

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
  'models.sectionProviders': 'AI Providers',
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

  ...settingsPartRest,
  ...settingsPartModels,
};

export default settings;
