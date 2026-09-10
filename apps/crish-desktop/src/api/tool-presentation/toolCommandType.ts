/**
 * 官方命令类型分类纯函数（决策 12 · 命令类型图标最小映射，V1-γ）。
 *
 * 只出 kind（命令语义轴），不接安全判定（安全判定归引擎权威）、无 store 依赖、
 * 无 React 依赖。域判定与 `toolDomainDescriptions.toolLabelFromArgs` 的 13 类
 * 域分支同序同谓词（shell / network / mcp / task / read / write / edit /
 * workspace / delete / list / search / subagent / timer / note），misc 兜底。
 */

import type { MessageToolCall } from '../../store/layoutStore';
import { isEditToolName, isShellToolName } from '../toolFeedback';

/** 命令类型轴（与 toolDomainDescriptions 13 类域对齐；misc 为兜底） */
export type ToolCommandKind =
  | 'shell'
  | 'network'
  | 'mcp'
  | 'task'
  | 'read'
  | 'write'
  | 'edit'
  | 'workspace'
  | 'delete'
  | 'list'
  | 'search'
  | 'subagent'
  | 'timer'
  | 'note'
  | 'misc';

/**
 * 工具名 → 命令类型 kind。
 * 分支顺序与 toolDomainDescriptions.toolLabelFromArgs 一致
 * （network 先于 read，避免 read_url_* 被 generic read 误判——DEC-05）。
 */
export function toolCommandType(tc: MessageToolCall): ToolCommandKind {
  const name = (tc.name || 'tool').toLowerCase().replace(/[\s-]+/g, '_');

  // 1. Shell / 终端执行类
  if (
    isShellToolName(name) ||
    name.includes('bash') ||
    name.includes('powershell') ||
    name.includes('pwsh') ||
    name.includes('exec')
  ) {
    return 'shell';
  }

  // 2. 网络访问 / Web 抓取
  if (
    name === 'read_url_content' ||
    name.startsWith('read_url') ||
    name.includes('fetch') ||
    name.includes('browser') ||
    name === 'web_search' ||
    name === 'search_web' ||
    name === 'read_browser_page'
  ) {
    return 'network';
  }

  // 3. MCP 扩展服务与资源查阅
  if (
    name === 'read_resource' ||
    name === 'list_resources' ||
    name === 'call_mcp_tool' ||
    name.startsWith('mcp_')
  ) {
    return 'mcp';
  }

  // 4. 后台任务管理
  if (
    name === 'manage_task' ||
    name === 'background_task' ||
    name.includes('task_manager')
  ) {
    return 'task';
  }

  // 5. 文件读取 / 查阅（排除 url/resource）
  if (
    name === 'read_file' ||
    name === 'view_file' ||
    name === 'open_file' ||
    name === 'cat' ||
    (name.includes('read') &&
      !name.includes('url') &&
      !name.includes('resource')) ||
    (name.includes('view') && !name.includes('preview'))
  ) {
    return 'read';
  }

  // 6. 文件写入 / 创建（排除 edit）
  if (
    name === 'write_file' ||
    name === 'write_to_file' ||
    name === 'create_file' ||
    (name.includes('write') && !name.includes('edit'))
  ) {
    return 'write';
  }

  // 7. 文件编辑 / 代码替换
  if (
    isEditToolName(name) ||
    name.includes('replace') ||
    name.includes('patch') ||
    name.includes('edit') ||
    name.includes('diff')
  ) {
    return 'edit';
  }

  // 8. 工作区产出与上下文
  if (
    name === 'resolve_output_dir' ||
    name.startsWith('resolve_output') ||
    name === 'project_tree' ||
    name === 'decompress_context'
  ) {
    return 'workspace';
  }

  // 9. 安全删除
  if (
    name === 'delete_file' ||
    name.startsWith('delete_file') ||
    name === 'delete_dir' ||
    name.startsWith('delete_dir') ||
    name === 'trash' ||
    name === 'remove_dir'
  ) {
    return 'delete';
  }

  // 10. 目录列表
  if (
    name === 'list_dir' ||
    name === 'list_directory' ||
    name === 'ls' ||
    name === 'dir' ||
    name === 'list_files' ||
    name === 'glob' ||
    name.startsWith('list_dir')
  ) {
    return 'list';
  }

  // 11. 代码与文本搜索
  if (
    name.includes('grep') ||
    name.includes('search') ||
    name.includes('find') ||
    name.includes('rg')
  ) {
    return 'search';
  }

  // 12. 多 Agent 与子任务
  if (
    name.includes('subagent') ||
    name === 'invoke_subagent' ||
    name === 'run_subagent' ||
    name.includes('wait_sub') ||
    name === 'send_message'
  ) {
    return 'subagent';
  }

  // 13. 定时器与计划
  if (name === 'set_timer' || name === 'schedule' || name === 'cancel_timer') {
    return 'timer';
  }

  // 14. 笔记知识库
  if (name.startsWith('note_')) {
    return 'note';
  }

  // 兜底：misc（与现状 CircleDot 兜底语义不冲突）
  return 'misc';
}
