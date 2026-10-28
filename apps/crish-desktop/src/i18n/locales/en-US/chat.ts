import type { ChatTranslations } from '../../types';

export const chat: ChatTranslations = {
  // ── Baseline 14 keys (Strict backward compatibility) ──
  newSession: 'New Session',
  emptyStateTitle: 'Start a new conversation',
  emptyStateSubtitle: 'Select a model or enter a message to begin',
  placeholder: 'Type a message...',
  send: 'Send',
  stop: 'Stop',
  attach: 'Attach',
  systemPrompt: 'System Prompt',
  clearHistory: 'Clear History',
  prompts: 'Prompts',
  welcome: 'Welcome',
  quickActions: 'Quick Actions',
  importChat: 'Import Chat',
  newProject: 'New Project',

  // ── 1. Composer and Input Experience (composer.*) ──
  'composer.placeholder': 'Type a message...',
  'composer.placeholderDense': 'Type a message...',
  'composer.placeholderProcessing':
    'Generating response, type to append or queue...',
  'composer.shortcutHintEnter': 'Press Enter to send, Shift+Enter for new line',
  'composer.shortcutHintCmdEnter':
    'Press Cmd/Ctrl+Enter to send, Enter for new line',
  'composer.newlineHint': 'New Line',
  'composer.send': 'Send',
  'composer.sendAria': 'Send message',
  'composer.queue': 'Queue',
  'composer.stop': 'Stop',
  'composer.stop.tooltip':
    'Stop generation (graceful). Shift+click or long press: force cancel',
  'composer.stop.ariaLabel':
    'Stop generation (graceful). Shift+click or long press to force cancel',
  'composer.stop.forceConfirmTitle': 'Force Cancel',
  'composer.stop.forceConfirmDesc':
    'Force cancel will immediately abort model and tool execution. Incomplete progress may be lost. Are you sure you want to force cancel?',
  'composer.stop.forceConfirmBtn': 'Confirm Force Cancel',
  'composer.thinkingStatus': 'Thinking...',
  'composer.dropOverlayTitle': 'Drop files here',
  'composer.dropOverlaySubtitle':
    'Supports images, code files, and text documents',
  'composer.attachFiles': 'Add Attachments',
  'composer.removeAttachment': 'Remove attachment',
  'composer.undoDraft': 'Undo Draft',
  'composer.undoDraftHint': 'Restored previous input draft',
  'composer.editingMessage': 'Editing previous message',
  'composer.cancelEdit': 'Cancel edit (Esc)',
  'composer.attachmentCountAria': 'Attachments, {count} total',
  'composer.dropToAttach': 'Drop here to add attachments',
  'composer.notice.viewDetail': 'View Details',
  'composer.notice.dismiss': 'Dismiss Notice',
  'composer.sendDisabledProcessing': 'Please enter a message to queue',
  'composer.sendDisabledNormal': 'Please enter a message or add attachments',
  'composer.queueTooltip':
    'Queue message, send after current response completes',
  'composer.appendTooltip': 'Send supplementary instruction',
  'composer.sendTooltip': 'Send (Enter)',
  'composer.cannotQueue': 'Cannot queue: please enter content first',
  'composer.cannotSend':
    'Cannot send: please enter a message or add attachments',
  'composer.appliedTemplateSnapshot':
    'Template applied, draft snapshot preserved',
  'composer.undoRestore': 'Undo Restore',

  // ── 2. Plus Menu and Quick Actions (plusMenu.*) ──
  'plusMenu.title': 'Add Content and Extensions',
  'plusMenu.addFiles': 'Add Files or Attachments',
  'plusMenu.addFilesDesc': 'Images, code, or documents',
  'plusMenu.systemPrompt': 'System Prompt',
  'plusMenu.systemPromptDesc': 'Set custom role and persona for this session',
  'plusMenu.quickActions': 'Quick Actions',
  'plusMenu.quickActionsDesc':
    'Common engineering workflows and prompt presets',
  'plusMenu.importChat': 'Import Chat',
  'plusMenu.importChatDesc':
    'Import chat history from JSON, Markdown, or exports',
  'plusMenu.newFromTemplate': 'New from Template',
  'plusMenu.newFromTemplateDesc':
    'Start with an architecture, debugging, or review template',
  'plusMenu.useSkill': 'Use Skill',
  'plusMenu.useSkillDesc': 'Select or enter a skill slash command',
  'plusMenu.noSkills': 'No enabled skills available',
  'plusMenu.manageSkills': 'Manage skills...',

  // ── 3. Permission Mode Switcher (chat.permission.*) ──
  'permission.tooltip': 'Current permission mode: {mode} · {hint}',
  'permission.ariaLabel': 'Current permission mode: {mode}',

  // ── 3.1 Approval Card (chat.approval.*) ──
  'approval.confirmRequired': 'Confirmation required',
  'approval.autoAllowLabel': 'Auto-Allow: approved after countdown',
  'approval.autoAllowHint':
    'Unattended mode: non-destructive operations are approved automatically after the countdown to keep the run going',
  'approval.manualLabel': 'Manual-Only: human approval required',
  'approval.manualHint':
    'Human approval only: key or restricted operations wait for a manual decision',
  'approval.autoDenyLabel': 'Auto-Deny: denied after countdown',
  'approval.autoDenyHint':
    'Timeout safety: automatically denied after the countdown',
  'approval.countdownExpired': 'Countdown finished',
  'approval.countdownExpiredDecision':
    'Countdown finished, waiting for the system policy decision…',
  'approval.countdownPaused': 'Countdown paused, waiting for human input',
  'approval.countdownAutoAllow':
    'Without input, approved automatically in {seconds}s',
  'approval.countdownAutoDeny':
    'Without approval, denied automatically in {seconds}s',
  'approval.reasonPrefix': 'Reason: ',

  // ── 3.2 Goal Mode Ribbon (chat.goal.*) ──
  'goal.modeLabel': 'Goal Mode',
  'goal.stop': 'Stop goal',

  // ── 4. Slash Commands and Quick Hints (slash.*) ──
  'slash.menuTitle': 'Quick Slash Commands',
  'slash.noCommandsFound': 'No matching commands found',
  'slash.searchPlaceholder': 'Search commands or skills...',
  'slash.clear.desc': 'Clear current session context and reset state',
  'slash.clear.usage': '/clear',
  'slash.compact.desc': 'Compact conversation context and free up tokens',
  'slash.compact.usage': '/compact [target tokens]',
  'slash.model.desc': 'Inspect or temporarily switch reasoning model',
  'slash.model.usage': '/model [model-id]',
  'slash.search.desc': 'Search across workspace and message history',
  'slash.search.usage': '/search <query>',
  'slash.goal.desc': 'Enable autonomous goal-driven execution until completed',
  'slash.goal.usage': '/goal <objective>',
  'slash.schedule.desc': 'Schedule recurring or one-shot workflow tasks',
  'slash.schedule.usage': '/schedule <cron-or-timer>',
  'slash.browser.desc': 'Launch built-in managed preview browser',
  'slash.browser.usage': '/browser [url]',
  'slash.teamwork.desc': 'Multi-agent parallel team coordination board',
  'slash.teamwork.usage': '/teamwork',
  'slash.learn.desc': 'Extract and persist long-term rules from session',
  'slash.learn.usage': '/learn <rule-content>',
  'slash.grillMe.desc':
    'Interactive deep stress-testing and architectural inquiry',
  'slash.grillMe.usage': '/grill-me <topic>',
  'slash.stop.desc': 'Stop current response generation or running task',
  'slash.stop.usage': '/stop',
  'slash.settings.desc': 'Open workbench settings center',
  'slash.settings.usage': '/settings',
  'slash.simulate.desc': 'Run demo pipeline simulation task',
  'slash.simulate.usage': '/simulate',
  'slash.help.desc': 'Show all available slash commands and shortcuts guide',
  'slash.help.usage': '/help',

  // ── 5. Reasoning, Duration Timing, and Metrics (thinking.*, reasoning.*, metrics.*) ──
  'thinking.label': 'Thinking',
  'thinking.process': 'Thinking Process',
  'thinking.completed': 'Thought',
  'thinking.durationMs': 'Thought for {duration}ms',
  'thinking.durationSec': 'Thought for {duration}s',
  'thinking.durationMin': 'Thought for {duration}m',
  'thinking.durationShort': 'Thought {duration}s',
  'thinking.expand': 'Expand thinking process',
  'thinking.collapse': 'Collapse thinking process',
  'thinking.copyChain': 'Copy thinking process',
  'thinking.chainCopied': 'Thinking process copied',
  'reasoning.thinking': 'Thinking',
  'reasoning.thoughtSec': 'Thought for {sec}s',
  'reasoning.thoughtDone': 'Thought',
  'reasoning.toggleProcess': 'Toggle thinking process',
  'metrics.title': 'Performance and Token Metrics',
  'metrics.inputTokens': 'Prompt Input',
  'metrics.outputTokens': 'Model Output',
  'metrics.totalTokens': 'Total Tokens',
  'metrics.contextUsage': 'Context Usage',
  'metrics.contextUsagePercent': '{percent}% used ({used}/{total})',
  'metrics.cacheHit': 'Cache Hit',
  'metrics.cacheHitRate': 'Cache Hit Rate',
  'metrics.cacheHitSummary': 'Cache hit {percent} - Read {read}',
  'metrics.cacheWriteSummary': ' - Write {write}',
  'metrics.cacheWritePill': 'Cache write {write}',
  'metrics.cacheRead': 'Cache Read',
  'metrics.cacheWrite': 'Cache Write',
  'metrics.cacheMiss': 'Cache Miss',
  'metrics.cacheTotalPrompt': 'Total Prompt Tokens',
  'metrics.cacheEstablishedTitle': 'Prompt Cache Established',
  'metrics.cacheEstablishedDesc':
    'Subsequent turns will reuse this prefix, significantly reducing latency and token cost',
  'metrics.tokensUnit': 'tokens',

  // ── 6. History Operations, Message Actions, and Empty States (history.*, message.*, emptyState.*) ──
  'history.clear': 'Clear History',
  'history.clearConfirmTitle': 'Clear Conversation History',
  'history.clearConfirmDesc':
    'Are you sure you want to clear all message history in this session? This action cannot be undone.',
  'history.clearConfirmBtn': 'Confirm Clear',
  'history.clearSuccess': 'History cleared successfully',
  'history.exportMarkdown': 'Export Markdown',
  'history.exportSuccess': 'Session exported successfully',
  'history.exportFailed': 'Export failed',
  'history.share': 'Share Session',
  'history.shareCopied': 'Markdown Copied',
  'history.copySession': 'Copy Full Session',
  'history.pinSession': 'Pin Session',
  'history.unpinSession': 'Unpin Session',
  'history.moveToProject': 'Move to Project...',
  'history.moreOptions': 'More Options',
  'message.copy': 'Copy Message',
  'message.copyBody': 'Copy text',
  'message.copied': 'Copied',
  'message.copyFailed': 'Copy failed',
  'message.regenerate': 'Regenerate',
  'message.regenerateTooltip': 'Regenerate response (Shortcut: R)',
  'message.retract': 'Retract',
  'message.retractTooltip':
    'Retract previous message (restore files, truncate, and refill input)',
  'message.edit': 'Edit',
  'message.editLast': 'Edit previous message',
  'message.editLastTooltip':
    'Edit previous message (refill into composer for re-editing)',
  'message.pin': 'Pin message',
  'message.unpin': 'Unpin message',
  'message.sendToNote': 'Send to Note',
  'message.sentToNote': 'Sent to Note',
  'emptyState.noSessionTitle': 'No Active Session',
  'emptyState.noSessionSubtitle':
    'Select a session from the sidebar or click New Session to begin',
  'emptyState.filterEmptyTitle': 'No Matching Messages',
  'emptyState.filterEmptySubtitle':
    'No messages match the current search filter',
  'emptyState.sessionEmptyTitle': 'Start Conversation',
  'emptyState.sessionEmptySubtitle':
    'Select a model or enter a message to begin',
  'emptyState.createSessionBtn': 'New Session',
  'emptyState.clearFilterBtn': 'Clear Filter',
  // ── Subagent browse / detail (AgentBrowsePad / AgentCardHeader) ──
  'agentBrowse.modeValue': 'Mode {mode}',
  'agentBrowse.readOnly': 'Read-only',
  'agentBrowse.modelValue': 'Model {model}',
  'agentBrowse.resumable': 'Resumable',
  'agentBrowse.pendingCount': '{count} pending',
  'agentBrowse.pendingBadge': 'Pending',
  'agentBrowse.resumeHint':
    'Interrupted by app restart; resumable or re-dispatch from the list',
  'agentCard.readOnlyHint': 'Read-only subagent: read and search tools only',
  'agentCard.readOnly': 'Read-only',
  'agentCard.modelBound': 'Bound model: {model}',
  'agentCard.resumeHint':
    'Interrupted by app restart; resume or re-dispatch from the subagent list',
  'agentCard.resumable': 'Resumable',
  'agentCard.failureReason': 'Failure reason: {reason}',
  'agentCard.unknown': 'Unknown',
  'agentCard.retries': ' · {count} retries',
  'agentCard.pendingTools': '{count} tools awaiting approval',
  'agentCard.pendingBadge': 'Pending',
  untitledSession: 'New chat',
  browserTabTitle: 'Browser',
  goalChipLabel: 'goal',
  inlineTagRemove: 'Remove {name}',
};

export default chat;
