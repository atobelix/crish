/**
 * 常见与内置 MCP 服务工具清单映射与解析工具
 */

export const KNOWN_MCP_TOOL_MAP: Record<string, string[]> = {
  'chrome-devtools-mcp': [
    'click',
    'close_page',
    'drag',
    'emulate',
    'evaluate_script',
    'fill',
    'fill_form',
    'get_console_message',
    'get_css_styles',
    'get_network_request',
    'handle_dialog',
    'hover',
    'lighthouse_audit',
    'list_console_messages',
    'list_network_requests',
    'list_pages',
    'navigate_page',
    'new_page',
    'performance_analyze_insight',
    'performance_start_trace',
    'performance_stop_trace',
    'press_key',
    'resize_page',
    'select_page',
    'take_heapsnapshot',
    'take_screenshot',
    'take_snapshot',
    'type_text',
    'upload_file',
    'wait_for',
  ],
  'tauri-mcp': [
    'app_bridge',
    'click',
    'dispatch_pointer',
    'execute_js',
    'inspect_element',
    'log_mark',
    'manage_ipc',
    'manage_storage',
    'manage_window',
    'mouse_action',
    'navigate',
    'press_key',
    'query_logs',
    'query_page',
    'read_text',
    'restart_app',
    'take_screenshot',
    'type_text',
    'wait_for',
  ],
  'tauri-mcp-editor': [
    'app_bridge',
    'click',
    'dispatch_pointer',
    'execute_js',
    'inspect_element',
    'log_mark',
    'manage_ipc',
    'manage_storage',
    'manage_window',
    'mouse_action',
    'navigate',
    'press_key',
    'query_logs',
    'query_page',
    'read_text',
    'restart_app',
    'take_screenshot',
    'type_text',
    'wait_for',
  ],
  'cua-driver': [
    'bring_to_front',
    'browser_click',
    'browser_dialog',
    'browser_download',
    'browser_navigate',
    'browser_pointer',
    'browser_prepare',
    'browser_set_input_files',
    'browser_type',
    'check_for_update',
    'check_permissions',
    'click',
    'clipboard_read',
    'clipboard_write',
    'debug_window_info',
    'double_click',
    'drag',
    'end_session',
    'escalate_session',
    'get_accessibility_tree',
    'get_agent_cursor_state',
    'get_browser_state',
    'get_config',
    'get_cursor_position',
    'get_desktop_state',
    'get_recording_state',
    'get_screen_size',
    'get_session',
    'get_session_state',
    'get_window_state',
    'health_report',
    'hotkey',
    'install_ffmpeg',
    'invoke_menu',
    'kill_app',
    'launch_app',
    'list_apps',
    'list_sessions',
    'list_windows',
    'move_cursor',
    'page',
    'press_key',
    'replay_trajectory',
    'right_click',
    'scroll',
    'set_agent_cursor_enabled',
    'set_agent_cursor_motion',
    'set_agent_cursor_theme',
    'set_config',
    'set_value',
    'set_window_frame',
    'start_recording',
    'start_session',
    'stop_recording',
    'type_text',
    'verify_state',
    'zoom',
  ],
  filesystem: [
    'read_file',
    'write_file',
    'list_directory',
    'get_file_info',
    'search_files',
    'read_multiple_files',
    'directory_tree',
    'move_file',
  ],
  fetch: ['fetch_url', 'download_content'],
  sqlite: ['read_query', 'write_query', 'list_tables', 'describe_table'],
  git: ['git_status', 'git_diff', 'git_commit', 'git_log'],
};

export function resolveMcpTools(
  name: string,
  command?: string,
  args?: string[],
  explicitTools?: string[]
): string[] {
  if (Array.isArray(explicitTools) && explicitTools.length > 0) {
    return explicitTools;
  }
  const needle =
    `${name} ${command || ''} ${(args || []).join(' ')}`.toLowerCase();

  if (
    needle.includes('chrome-devtools') ||
    needle.includes('devtools') ||
    needle.includes('chrome_devtools')
  ) {
    return [...(KNOWN_MCP_TOOL_MAP['chrome-devtools-mcp'] || [])];
  }
  if (
    needle.includes('tauri-mcp-editor') ||
    needle.includes('tauri_mcp_editor')
  ) {
    return [...(KNOWN_MCP_TOOL_MAP['tauri-mcp-editor'] || [])];
  }
  if (
    needle.includes('tauri-mcp') ||
    needle.includes('tauri_mcp') ||
    needle.includes('tauri')
  ) {
    return [...(KNOWN_MCP_TOOL_MAP['tauri-mcp'] || [])];
  }
  if (
    needle.includes('cua-driver') ||
    needle.includes('cua_driver') ||
    needle.includes('cua')
  ) {
    return [...(KNOWN_MCP_TOOL_MAP['cua-driver'] || [])];
  }
  if (needle.includes('filesystem')) {
    return [...(KNOWN_MCP_TOOL_MAP['filesystem'] || [])];
  }
  if (needle.includes('sqlite')) {
    return [...(KNOWN_MCP_TOOL_MAP['sqlite'] || [])];
  }
  if (needle.includes('fetch')) {
    return [...(KNOWN_MCP_TOOL_MAP['fetch'] || [])];
  }
  if (needle.includes('git')) {
    return [...(KNOWN_MCP_TOOL_MAP['git'] || [])];
  }

  for (const [key, tools] of Object.entries(KNOWN_MCP_TOOL_MAP)) {
    if (needle.includes(key.toLowerCase())) {
      return [...tools];
    }
  }
  return [];
}
