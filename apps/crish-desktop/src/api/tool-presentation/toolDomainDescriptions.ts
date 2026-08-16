/**
 * 13 类全领域工具参数解析与精准中文语义标签映射。
 */

import type { MessageToolCall } from '../../store/layoutStore';
import { isEditToolName, isShellToolName } from '../toolFeedback';
import { basename, parseToolArgsSafe } from './toolArgsNormalizer';
import { humanizeShellCommand } from './toolCommandExtractor';

/** 从工具名 + args 生成 100% 精准中文语义标题（不依赖 explanation） */
export function toolLabelFromArgs(tc: MessageToolCall): string {
  const name = (tc.name || 'tool').toLowerCase().replace(/[\s-]+/g, '_');
  const args = parseToolArgsSafe(tc.arguments);
  const p = args.props;

  // 1. Shell / 终端执行类
  if (
    isShellToolName(name) ||
    name.includes('bash') ||
    name.includes('powershell') ||
    name.includes('pwsh') ||
    name.includes('exec')
  ) {
    const cmd =
      args.primaryTarget || (typeof p.command === 'string' ? p.command : '');
    return cmd ? humanizeShellCommand(cmd) : '运行终端命令';
  }

  // 2. 网络访问 / Web 抓取 (优先精确匹配，消除被 generic read_file 误判，DEC-05)
  if (
    name === 'read_url_content' ||
    name.startsWith('read_url') ||
    name.includes('fetch') ||
    name.includes('browser') ||
    name === 'web_search' ||
    name === 'search_web' ||
    name === 'read_browser_page'
  ) {
    if (name === 'web_search' || name === 'search_web') {
      const q = String(p.query || p.q || args.primaryTarget || '').trim();
      return q ? `搜索网络「${q.slice(0, 24)}」` : '搜索网络内容';
    }
    const url = String(
      p.url ||
        p.uri ||
        p.targeturl ||
        p.target_url ||
        p.link ||
        args.primaryTarget ||
        ''
    ).trim();
    if (url && !url.startsWith('{')) {
      try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        return `访问 ${u.hostname}`;
      } catch {
        return `访问 ${url.length > 28 ? `${url.slice(0, 27)}…` : url}`;
      }
    }
    return '访问网络页面';
  }

  // 3. MCP 扩展服务与资源查阅 (read_resource / call_mcp_tool)
  if (
    name === 'read_resource' ||
    name === 'list_resources' ||
    name === 'call_mcp_tool' ||
    name.startsWith('mcp_')
  ) {
    if (name === 'read_resource') {
      const uri = String(
        p.uri || p.url || p.resource || args.primaryTarget || ''
      ).trim();
      return uri && !uri.startsWith('{')
        ? `读取资源 ${basename(uri) || uri}`
        : '读取扩展资源';
    }
    if (name === 'list_resources') {
      const server = String(p.servername || p.server_name || '').trim();
      return server ? `列出 MCP [${server}] 资源` : '列出扩展资源';
    }
    const summary = String(p.toolsummary || p.toolaction || '').trim();
    if (summary) return summary;
    const toolName = String(p.toolname || p.tool_name || '').trim();
    const serverName = String(p.servername || p.server_name || '').trim();
    if (toolName && serverName) return `调用 MCP [${serverName}:${toolName}]`;
    if (toolName) return `调用 MCP [${toolName}]`;
    return '调用扩展服务';
  }

  // 4. 后台任务管理 (manage_task / background_task)
  if (
    name === 'manage_task' ||
    name === 'background_task' ||
    name.includes('task_manager')
  ) {
    const action = String(p.action || '').toLowerCase();
    const taskId = String(p.taskid || p.task_id || '').trim();
    const taskTag = taskId ? ` (${taskId})` : '';
    if (action === 'list') return '查询后台任务列表';
    if (action === 'status') return `查询后台任务${taskTag}`;
    if (action === 'read_log') return `读取任务日志${taskTag}`;
    if (action === 'send_input') return `向任务发送输入${taskTag}`;
    if (action === 'kill') return `终止后台任务${taskTag}`;
    return `管理后台任务${taskTag}`;
  }

  // 5. 文件读取 / 查阅 (read_file / view_file / cat / open_file，排除 url/resource)
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
    const path = String(
      p.absolutepath ||
        p.path ||
        p.filepath ||
        p.file_path ||
        p.targetfile ||
        p.file ||
        ''
    );
    const sl = p.startline || p.start_line;
    const el = p.endline || p.end_line;
    const lineTag = sl ? ` (L${sl}${el ? `-${el}` : ''})` : '';
    return path ? `查看 ${basename(path)}${lineTag}` : '查看文件';
  }

  // 6. 文件写入 / 创建 (write_file / write_to_file / create_file)
  if (
    name === 'write_file' ||
    name === 'write_to_file' ||
    name === 'create_file' ||
    (name.includes('write') && !name.includes('edit'))
  ) {
    const path = String(
      p.targetfile ||
        p.target_file ||
        p.file_path ||
        p.filepath ||
        p.path ||
        p.file ||
        ''
    );
    return path ? `写入 ${basename(path)}` : '写入文件';
  }

  // 7. 文件编辑 / 代码替换 (replace_file_content / multi_replace / edit_file / apply_patch)
  if (
    isEditToolName(name) ||
    name.includes('replace') ||
    name.includes('patch') ||
    name.includes('edit')
  ) {
    const path = String(
      p.targetfile || p.target_file || p.path || p.filepath || p.file || ''
    );
    return name.includes('multi_replace')
      ? path
        ? `批量修改 ${basename(path)}`
        : '批量修改文件'
      : path
        ? `修改 ${basename(path)}`
        : '修改文件';
  }

  // 8. 工作区产出与上下文 (resolve_output_dir / project_tree)
  if (name === 'resolve_output_dir' || name.startsWith('resolve_output')) {
    const folder = String(p.folder || '').trim();
    return folder ? `解析产出目录 (${folder})` : '解析会话产出目录';
  }
  if (name === 'project_tree') return '生成项目结构树';
  if (name === 'decompress_context') {
    const chunk = String(p.chunk_id || p.chunkid || '').trim();
    return chunk ? `解压上下文块 (${chunk})` : '解压历史上下文';
  }

  // 9. 安全删除 (delete_file / delete_dir / trash)
  if (name === 'delete_file' || name.startsWith('delete_file')) {
    const target = String(p.path || p.targetfile || p.file || '').trim();
    return target
      ? `删除文件 ${basename(target)} (移入回收站)`
      : '删除文件 (移入回收站)';
  }
  if (
    name === 'delete_dir' ||
    name.startsWith('delete_dir') ||
    name === 'trash' ||
    name === 'remove_dir'
  ) {
    const target = String(p.path || p.target || p.directorypath || '').trim();
    return target
      ? `删除目录 ${basename(target)} (移入回收站)`
      : '删除目录 (移入回收站)';
  }

  // 10. 目录列表 (list_dir / list_directory / ls / dir)
  if (
    name === 'list_dir' ||
    name === 'list_directory' ||
    name === 'ls' ||
    name === 'dir' ||
    name === 'list_files' ||
    name === 'glob' ||
    name.startsWith('list_dir')
  ) {
    const dir = String(
      p.directorypath || p.directory_path || p.path || p.dir || ''
    ).trim();
    if (!dir || dir === '.' || dir === './' || dir === '{}')
      return '列出当前目录';
    return `列出目录 ${basename(dir) || dir}`;
  }

  // 11. 代码与文本搜索 (grep_search / search / ripgrep)
  if (
    name.includes('grep') ||
    name.includes('search') ||
    name.includes('find') ||
    name.includes('rg')
  ) {
    const query = String(p.query || p.pattern || p.term || '').trim();
    const searchPath = String(p.searchpath || p.search_path || '').trim();
    if (query && !query.startsWith('{')) {
      const qClip = query.length > 24 ? `${query.slice(0, 23)}…` : query;
      return searchPath && searchPath !== '.' && searchPath !== './'
        ? `在 ${basename(searchPath)} 搜索「${qClip}」`
        : `搜索「${qClip}」`;
    }
    return '搜索代码';
  }

  // 12. 多 Agent 与子任务 (run_subagent / invoke_subagent / wait_subagents / send_message)
  if (
    name.includes('subagent') ||
    name === 'invoke_subagent' ||
    name === 'run_subagent'
  ) {
    const role = String(
      p.role || p.typename || p.description || p.prompt || ''
    ).trim();
    return role && !role.startsWith('{')
      ? `启动子代理：${role.length > 28 ? `${role.slice(0, 27)}…` : role}`
      : '启动协作子任务';
  }
  if (name === 'wait_subagents' || name.includes('wait_sub'))
    return '等待子任务完成';
  if (name === 'send_message') {
    const recipient = String(p.recipient || p.recipientid || '').trim();
    return recipient ? `向 ${recipient} 发送消息` : '发送消息给子代理';
  }

  // 13. 定时器与计划 (set_timer / cancel_timer / schedule)
  if (name === 'set_timer' || name === 'schedule') {
    const duration = p.durationseconds || p.duration_seconds || p.duration;
    if (duration) return `设置定时器 (${duration}秒)`;
    const cron = p.cronexpression || p.cron_expression;
    if (cron) return `设置定时任务 (${cron})`;
    return '设置定时器';
  }
  if (name === 'cancel_timer') {
    const taskId = p.taskid || p.task_id;
    return taskId ? `取消定时器 (${taskId})` : '取消定时器';
  }

  // 14. 笔记知识库 (note_*)
  if (name.startsWith('note_')) {
    if (name.includes('query')) {
      const q = String(p.query || '').trim();
      return q ? `查询笔记区块「${q}」` : '查询笔记区块';
    }
    if (name.includes('outline')) return '读取笔记大纲';
    const blockId = String(p.block_id || p.blockid || '').trim();
    return blockId ? `更新笔记区块 (${blockId})` : '更新笔记区块';
  }

  // 终极安全清洗兜底
  if (args.primaryTarget) {
    const short = basename(args.primaryTarget);
    if (
      short &&
      short !== '.' &&
      short !== './' &&
      !short.startsWith('{') &&
      short.length < 40
    ) {
      return `处理 ${short}`;
    }
  }

  const prettyName = name.replace(/_/g, ' ').trim();
  return `调用 ${prettyName || '工具'}`;
}
