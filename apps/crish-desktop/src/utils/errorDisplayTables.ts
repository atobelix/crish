/**
 * apps/crish-desktop/src/utils/errorDisplayTables.ts
 *
 * 出厂错误码/动作码展示字典（SSOT 数据表）。
 * 拆分来源：utils/error-translation.ts（行数门禁收口，行为不变）；
 * 消费方 resolveDisplay / resolveActionText 经 import 使用。
 */

/**
 * 内置错误码 -> 英文 title/action 映射表。
 * 覆盖用户可见的高频码，未命中的码回退到 DEFAULT_DISPLAY 通用文案。
 */
export const BUILTIN_ERROR_DISPLAY: Readonly<
  Record<string, { readonly title: string; readonly action: string }>
> = {
  // ── common 域 ──
  'common.unknown': {
    title: 'Unknown error',
    action: 'Please try again or report the issue.',
  },
  'common.unsupported': {
    title: 'Unsupported operation',
    action: 'Please check the app version.',
  },
  'common.not_found': {
    title: 'Resource not found',
    action: 'Please check the resource reference.',
  },
  'common.invalid_input': {
    title: 'Invalid input',
    action: 'Please check the input and try again.',
  },
  'common.encoding': {
    title: 'Encoding error',
    action: 'Please use a supported text encoding.',
  },
  // ── store 域 ──
  'store.write_failed': {
    title: 'Storage write failed',
    action: 'Retrying automatically.',
  },
  'store.read_failed': {
    title: 'Storage read failed',
    action: 'Retrying automatically.',
  },
  'store.corrupted': {
    title: 'Storage corrupted',
    action: 'Please restore from backup.',
  },
  'store.capacity_exceeded': {
    title: 'Storage capacity exceeded',
    action: 'Please clean up or expand storage.',
  },
  'store.io': {
    title: 'Storage I/O error',
    action: 'Retrying automatically.',
  },
  // ── event_store 域 ──
  'event_store.append_failed': {
    title: 'Event append failed',
    action: 'Retrying automatically.',
  },
  'event_store.read_failed': {
    title: 'Event read failed',
    action: 'Retrying automatically.',
  },
  'event_store.consistency_violation': {
    title: 'Event consistency error',
    action: 'Please rebuild the index.',
  },
  'event_store.degraded': {
    title: 'Event storage degraded',
    action: 'Please check disk space.',
  },
  // ── agent 域 ──
  'agent.max_turns_reached': {
    title: 'Turn limit reached',
    action: 'Please start a new session or shorten the task.',
  },
  // ── context 域 ──
  'context.length_exceeded': {
    title: 'Context length exceeded',
    action: 'Please shorten the task or start a new session.',
  },
  // ── runtime 域 ──
  'runtime.unexpected_state': {
    title: 'Runtime state error',
    action: 'Please restart the session.',
  },
  'runtime.transition_failed': {
    title: 'State transition failed',
    action: 'Please report the issue.',
  },
  'runtime.aborted': {
    title: 'Aborted',
    action: '',
  },
  'runtime.timeout': {
    title: 'Runtime timeout',
    action: 'Please retry.',
  },
  // ── provider 域 ──
  'provider.network': {
    title: 'Network error',
    action: 'Service is temporarily unavailable. Please try again later.',
  },
  'provider.rate_limit': {
    title: 'Rate limited',
    action: 'Too many requests. Please wait and retry.',
  },
  'provider.server': {
    title: 'Server error',
    action: 'Service is temporarily unavailable. Please try again later.',
  },
  'provider.timeout': {
    title: 'Request timeout',
    action: 'The request timed out. Please retry.',
  },
  'provider.cancelled': {
    title: 'Request cancelled',
    action: '',
  },
  'provider.stream_interrupted': {
    title: 'Stream interrupted',
    action: 'Streaming was interrupted. Please retry.',
  },
  'provider.auth': {
    title: 'Authentication failed',
    action: 'Please check the API key in Settings.',
  },
  'provider.quota': {
    title: 'Quota exhausted',
    action: 'Please top up or switch providers.',
  },
  'provider.endpoint_unavailable': {
    title: 'Endpoint unavailable',
    action: 'Please check the provider endpoint.',
  },
  'provider.unknown': {
    title: 'Unknown provider error',
    action: 'Please report the issue.',
  },
  // ── subagent 域 ──
  'subagent.depth_exceeded': {
    title: 'Subagent depth exceeded',
    action: 'Please simplify the task.',
  },
  'subagent.deadlock_detected': {
    title: 'Subagent deadlock',
    action: 'Please replan the task.',
  },
  'subagent.timeout': {
    title: 'Subagent timeout',
    action: 'Please retry.',
  },
  // ── tool 域 ──
  'tool.not_found': {
    title: 'Tool not found',
    action: 'Please check the tool name and availability.',
  },
  'tool.exec_failed': {
    title: 'Tool execution failed',
    action: 'Please check tool parameters and try again.',
  },
  'tool.path_escape': {
    title: 'Path access violation',
    action: 'Operation outside allowed workspace is forbidden.',
  },
  'tool.permission_denied': {
    title: 'Tool permission denied',
    action: 'Please grant the required tool permissions.',
  },
  'tool.timeout': {
    title: 'Tool timeout',
    action: 'The tool execution timed out. Please retry.',
  },
  'tool.write_path_conflict': {
    title: 'File write conflict',
    action: 'Another operation is modifying this file. Retrying.',
  },
  // ── config 域 ──
  'config.invalid': {
    title: 'Invalid configuration',
    action: 'Please check the configuration settings.',
  },
  'config.missing': {
    title: 'Configuration missing',
    action: 'Please provide the required configuration value.',
  },
  'config.parse_failed': {
    title: 'Configuration parse error',
    action: 'Please verify configuration syntax.',
  },
  // ── session 域 ──
  'session.not_found': {
    title: 'Session not found',
    action: 'Please select an existing session or start a new one.',
  },
  'session.invalid_state': {
    title: 'Invalid session state',
    action: 'Please restart the session.',
  },
  'session.save_failed': {
    title: 'Session save failed',
    action: 'Retrying automatically.',
  },
  // ── plugin 域 ──
  'plugin.not_found': {
    title: 'Plugin not found',
    action: 'Please verify that the plugin is installed.',
  },
  'plugin.permission_denied': {
    title: 'Plugin permission denied',
    action: 'Please check plugin permissions in Settings.',
  },
  // ── security 域 ──
  'security.violation': {
    title: 'Security violation',
    action: 'Operation blocked for security reasons.',
  },
};

/** 内置 action 点分 key 到人格化英文操作建议的映射字典 */
export const BUILTIN_ACTION_DISPLAY: Readonly<Record<string, string>> = {
  // common
  'action.common.report_bug': 'Please try again or report the issue.',
  'action.common.check_field': 'Please check the input field and try again.',
  'action.common.check_encoding': 'Please use a supported text encoding.',
  'action.common.check_version': 'Please check the application version.',
  'action.common.check_resource': 'Please check the resource reference.',

  // config
  'action.config.check_field': 'Please check the configuration settings.',
  'action.config.provide_value':
    'Please provide the required configuration value.',
  'action.config.verify_syntax': 'Please verify configuration syntax.',

  // session
  'action.session.select_existing':
    'Please select an existing session or start a new one.',
  'action.session.restart': 'Please restart the session.',
  'action.session.check_entry': 'Please check the session entry and retry.',
  'action.session.refresh': 'Please refresh the session.',
  'action.session.retry_save': 'Retrying session save automatically.',
  'action.session.check_rewind_target': 'Please check the rewind target point.',
  'action.session.wait_switch': 'Please wait for the current switch to finish.',

  // agent
  'action.agent.increase_max_turns':
    'Please start a new session or increase max turns limit.',
  'action.agent.intervene':
    'Please review agent progress and intervene if necessary.',
  'action.agent.review': 'Please review the execution results.',

  // runtime
  'action.runtime.restart_session': 'Please restart the session.',
  'action.runtime.report_bug': 'Please report the issue.',
  'action.runtime.none': '',
  'action.runtime.retry': 'Please retry.',

  // provider
  'action.provider.check_network':
    'Service is temporarily unavailable. Please try again later.',
  'action.provider.disable_proxy': 'Please check network proxy settings.',
  'action.provider.wait_retry': 'Too many requests. Please wait and retry.',
  'action.provider.check_api_key': 'Please check the API key in Settings.',
  'action.provider.check_key': 'Please check the API key in Settings.',
  'action.provider.top_up': 'Please top up or switch providers.',
  'action.provider.check_endpoint':
    'Please check the provider endpoint in Settings.',
  'action.provider.fix_request':
    'Please adjust your prompt or request parameters.',
  'action.provider.retry': 'Please retry.',
  'action.provider.report_bug': 'Please report the issue.',
  'action.provider.check_connection':
    'Please check your connection to the model service.',
  'action.provider.reauth': 'Please re-authenticate your account in Settings.',

  // context
  'action.context.compact':
    'Please compact the context or start a new session.',
  'action.context.retry_compact': 'Please retry context compaction.',
  'action.context.manual_trim': 'Please manually clear earlier messages.',

  // tool
  'action.tool.check_name': 'Please check the tool name and availability.',
  'action.tool.fix_input': 'Please check and fix tool input arguments.',
  'action.tool.retry': 'Please retry the tool execution.',
  'action.tool.check_path': 'Please check the file path and permissions.',
  'action.tool.refresh_and_retry': 'Please refresh the tool state and retry.',
  'action.tool.request_path_allowance':
    'Please grant workspace access permissions.',
  'action.tool.wait_retry':
    'Another operation is running. Please wait and retry.',
  'action.tool.aborted_before_dispatch':
    'Tool execution was cancelled before start.',
  'action.tool.cancelled': 'Tool execution was cancelled.',
  'action.tool.outcome_unknown':
    'Tool outcome is unknown. Please verify manually.',
  'action.tool.exec_failed': 'Please check tool parameters and try again.',

  // browser
  'action.browser.wait_ready': 'Please wait for the browser to become ready.',
  'action.browser.check_target':
    'Please check the target browser tab or window.',
  'action.browser.enable_capability':
    'Please enable browser automation capability.',
  'action.browser.resnapshot': 'Please refresh the page snapshot.',
  'action.browser.check_whitelist': 'Please verify domain whitelist settings.',
  'action.browser.close_tabs': 'Please close unnecessary browser tabs.',
  'action.browser.check_version':
    'Please update your browser to a compatible version.',

  // computer
  'action.computer.fix_input':
    'Please check the input coordinates and parameters.',
  'action.computer.refresh_perception':
    'Please refresh the screen perception capture.',
  'action.computer.manual_operation': 'Please perform the operation manually.',
  'action.computer.enable_session': 'Please enable computer use permissions.',
  'action.computer.wait_retry': 'Please wait a moment and retry.',
  'action.computer.none': '',
  'action.computer.check_capability':
    'Please check OS accessibility permissions.',
  'action.computer.check_supported':
    'This action is not supported on the current platform.',

  // mcp
  'action.mcp.check_server': 'Please check the MCP server status.',
  'action.mcp.report_bug':
    'Please report the issue to the MCP server maintainer.',
  'action.mcp.check_config': 'Please check the MCP configuration file.',

  // store
  'action.store.retry_write': 'Retrying storage write automatically.',
  'action.store.retry_read': 'Retrying storage read automatically.',
  'action.store.restore_backup': 'Please restore from backup.',
  'action.store.cleanup_or_expand': 'Please clean up or expand storage.',

  // subagent
  'action.subagent.reduce_depth':
    'Please simplify the task to avoid deep nesting.',
  'action.subagent.ask_main_agent':
    'Please request delegation from the main agent.',
  'action.subagent.verify_id': 'Please verify the subagent ID.',
  'action.subagent.break_cycle': 'Please break the subagent dependency cycle.',
  'action.subagent.retry': 'Please retry the subagent task.',

  // plugin
  'action.plugin.check_install':
    'Please verify that the plugin is properly installed.',
  'action.plugin.check_manifest': 'Please check plugin manifest configuration.',
  'action.plugin.grant_permission':
    'Please grant plugin permissions in Settings.',

  // event_store
  'action.event_store.retry_append': 'Retrying event append automatically.',
  'action.event_store.rebuild_index': 'Please rebuild the event index.',
  'action.event_store.retry_read': 'Retrying event read automatically.',
  'action.event_store.check_disk': 'Please check disk space.',

  // security
  'action.security.check_target': 'Operation blocked for security reasons.',

  // goal
  'action.goal.review_progress': 'Please review goal progress.',
  'action.goal.break_loop': 'Goal loop detected. Please intervene.',
  'action.goal.increase_max_rounds':
    'Please increase the max rounds limit for this goal.',
};

/** 未知码的通用英文回退（未命中 BUILTIN_ERROR_DISPLAY 时使用） */
