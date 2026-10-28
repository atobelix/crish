/**
 * 工具展示统一模型与 25 类工具注册表（P5 T-P5-02 · ToolPresentation SSOT）。
 *
 * 5 大去重与消解流水线：
 *   1. 目标对象预提取（extractTarget / extractFallbackTarget）
 *   2. Explanation 意图优先与内含消解（意图已含目标对象或同义词根时 target 置为 undefined）
 *   3. 无 Explanation 时的动宾分离（label 仅承载动作谓词，target 承载宾语对象，严禁双写）
 *   4. 失败态错误扼要提炼（status === 'error' 时提取首行错误摘要至 target，截断 60 字符）
 *   5. 元数据预算截断（优先级：Diff 统计 > 次要指标 > 耗时，最多保留 2 项）
 */

import type { MessageToolCall } from '../../store/types';
import { t } from '../../i18n';
import { basename, parseToolArgsSafe } from './toolArgsNormalizer';
import { toolCommandType, type ToolCommandKind } from './toolCommandType';
import type {
  ToolPresentation,
  ToolPresentationOptions,
  ToolPresentationRegistration,
} from './toolPresentationTypes';
import {
  DIR_KEYS,
  PATH_KEYS,
  extractFallbackTarget,
  extractListDirTarget,
  extractReadUrlTarget,
  extractRunCommandTarget,
  extractSetTimerTarget,
  extractWaitSubagentsTarget,
  mapPresentationStatus,
  pathTarget,
  patternTarget,
  resolveDiffMeta,
  resolveDurationMeta,
  resolveFileStatMeta,
  resolveGrepMeta,
  resolveListDirMeta,
  resolveReadFileMeta,
  textTarget,
} from './toolPresentationParsers';
import {
  cleanHumanExplanation,
  formatErrorTarget,
  formatPresentationMeta,
  formatPresentationStatus,
  formatRowAriaLabel,
  isTargetContainedInExplanation,
  resolveMcpAction,
} from './toolPresentationFormatters';

export type { ToolPresentationRegistration };
export {
  formatUrlHost,
  extractFallbackTarget,
} from './toolPresentationParsers';
export {
  cleanHumanExplanation,
  isTargetContainedInExplanation,
} from './toolPresentationFormatters';

function defTool(
  kind: ToolCommandKind,
  iconName: string,
  defaultAction: string,
  extractTarget: ToolPresentationRegistration['extractTarget'],
  extractMeta?: ToolPresentationRegistration['extractMeta'],
  resolveAction?: ToolPresentationRegistration['resolveAction']
): ToolPresentationRegistration {
  return {
    kind,
    iconName,
    defaultAction,
    extractTarget,
    ...(extractMeta ? { extractMeta } : {}),
    ...(resolveAction ? { resolveAction } : {}),
  };
}

/** 25 类内置工具权威展示注册表（与 crates/agent-tools 及 P5 §4.2.4 双向对齐） */
export const TOOL_PRESENTATION_REGISTRY: Record<
  string,
  ToolPresentationRegistration
> = {
  list_dir: defTool(
    'list',
    'folder-01',
    t('tool.action.listDir', '列出目录'),
    extractListDirTarget,
    resolveListDirMeta
  ),
  grep_search: defTool(
    'search',
    'search-01',
    'Grep',
    patternTarget(['query', 'pattern', 'term'], true),
    resolveGrepMeta
  ),
  multi_replace_file_content: defTool(
    'edit',
    'edit-02',
    t('tool.action.editFile', '修改文件'),
    pathTarget(PATH_KEYS, true),
    (tc) => resolveDiffMeta(tc)
  ),
  read_file: defTool(
    'read',
    'file-view',
    t('tool.action.readFile', '读取文件'),
    pathTarget(PATH_KEYS, true),
    resolveReadFileMeta
  ),
  write_file: defTool(
    'write',
    'file-plus',
    t('tool.action.writeFile', '写入文件'),
    pathTarget(PATH_KEYS, true),
    (tc) => resolveDiffMeta(tc)
  ),
  run_command: defTool(
    'shell',
    'terminal',
    t('tool.action.runCommand', '运行命令'),
    extractRunCommandTarget,
    (tc) => resolveDurationMeta(tc)
  ),
  file_stat: defTool(
    'read',
    'file-search',
    t('tool.action.fileStat', '查看文件属性'),
    pathTarget(PATH_KEYS, true),
    resolveFileStatMeta
  ),
  fuzzy_find: defTool(
    'search',
    'search-01',
    t('tool.action.fuzzyFind', '模糊查找'),
    patternTarget(['pattern', 'query', 'name'], false)
  ),
  diff_text: defTool(
    'edit',
    'file-diff',
    t('tool.action.diff', '差异对比'),
    pathTarget(PATH_KEYS, true),
    (tc) => resolveDiffMeta(tc)
  ),
  delete_file: defTool(
    'delete',
    'trash',
    t('tool.action.deleteFile', '删除文件'),
    pathTarget(PATH_KEYS, false)
  ),
  delete_dir: defTool(
    'delete',
    'trash',
    t('tool.action.deleteDir', '删除目录'),
    pathTarget(DIR_KEYS, false)
  ),
  run_subagent: defTool(
    'subagent',
    'bot',
    t('tool.action.spawnSubagent', '启动子代理'),
    textTarget(['prompt', 'task', 'role', 'description'], 48)
  ),
  wait_subagents: defTool(
    'subagent',
    'bot',
    t('tool.action.waitSubagent', '等待子代理'),
    extractWaitSubagentsTarget
  ),
  kill_subagent: defTool(
    'subagent',
    'bot',
    t('tool.action.killSubagent', '终止子代理'),
    textTarget(['task_id', 'taskid', 'subagent_id', 'id'], 48)
  ),
  send_message: defTool(
    'subagent',
    'send',
    t('tool.action.sendSubagentMessage', '向子代理发送消息'),
    textTarget(
      ['recipient', 'recipient_id', 'recipientid', 'task_id', 'to'],
      48
    )
  ),
  set_timer: defTool(
    'timer',
    'timer',
    t('tool.action.scheduleSet', '设置定时器'),
    extractSetTimerTarget
  ),
  cancel_timer: defTool(
    'timer',
    'timer',
    t('tool.action.scheduleCancel', '取消定时器'),
    textTarget(['timer_id', 'timerid', 'task_id', 'taskid', 'id'], 48)
  ),
  create_workflow: defTool(
    'task',
    'workflow',
    t('tool.action.workflowCreate', '创建工作流'),
    textTarget(['name', 'title', 'workflow_name'], 48)
  ),
  resolve_output_dir: defTool(
    'workspace',
    'folder-cog',
    t('tool.action.resolveOutputDir', '解析产出目录'),
    pathTarget(['folder', 'path', 'dir'], true)
  ),
  project_tree: defTool(
    'workspace',
    'folder-tree',
    t('tool.action.treeGenerate', '生成工程结构树'),
    pathTarget(['path', 'root', 'dir'], true)
  ),
  search_context: defTool(
    'search',
    'search-01',
    t('tool.action.memorySearch', '检索压缩记忆'),
    patternTarget(['query', 'keyword', 'pattern'], false)
  ),
  decompress_context: defTool(
    'workspace',
    'archive',
    t('tool.action.memoryRestore', '还原记忆原文'),
    textTarget(['block_id', 'blockid', 'chunk_id', 'chunkid', 'id'], 48)
  ),
  note_query_blocks: defTool(
    'note',
    'notebook-pen',
    t('tool.action.noteQuery', '查询笔记区块'),
    patternTarget(['keyword', 'query', 'block_id', 'blockid'], false)
  ),
  read_url_content: defTool(
    'network',
    'globe-02',
    t('tool.action.webAccess', '访问网络'),
    extractReadUrlTarget
  ),
  call_mcp_tool: defTool(
    'mcp',
    'plug',
    t('tool.action.mcpCall', '调用 MCP 工具'),
    () => undefined,
    undefined,
    resolveMcpAction
  ),
};

/** 常见工具别名到 25 类权威注册表的归并映射 */
export const TOOL_PRESENTATION_ALIASES: Readonly<Record<string, string>> = {
  list_directory: 'list_dir',
  ls: 'list_dir',
  dir: 'list_dir',
  list_files: 'list_dir',
  grep: 'grep_search',
  rg: 'grep_search',
  ripgrep: 'grep_search',
  replace_file_content: 'multi_replace_file_content',
  edit_file: 'multi_replace_file_content',
  replace_string_in_file: 'multi_replace_file_content',
  apply_patch: 'multi_replace_file_content',
  view_file: 'read_file',
  open_file: 'read_file',
  cat: 'read_file',
  read_text_file: 'read_file',
  write_to_file: 'write_file',
  create_file: 'write_file',
  execute_command: 'run_command',
  run_in_terminal: 'run_command',
  bash: 'run_command',
  powershell: 'run_command',
  pwsh: 'run_command',
  find_by_name: 'fuzzy_find',
  glob: 'fuzzy_find',
  invoke_subagent: 'run_subagent',
  schedule: 'set_timer',
  fetch_url: 'read_url_content',
  read_browser_page: 'read_url_content',
  web_search: 'read_url_content',
  search_web: 'read_url_content',
  read_resource: 'call_mcp_tool',
  list_resources: 'call_mcp_tool',
};

/** 构建工具调用统一展示模型（SSOT 纯函数） */
export function resolveToolPresentation(
  tc: MessageToolCall,
  humanExplanation?: string,
  options?: ToolPresentationOptions
): ToolPresentation {
  const normName = (tc.name || 'tool').toLowerCase().replace(/[\s-]+/g, '_');
  const regKey = TOOL_PRESENTATION_REGISTRY[normName]
    ? normName
    : TOOL_PRESENTATION_ALIASES[normName];
  const reg = regKey ? TOOL_PRESENTATION_REGISTRY[regKey] : undefined;

  const args = parseToolArgsSafe(tc.arguments).props;
  const kind: ToolCommandKind = reg ? reg.kind : toolCommandType(tc);
  const iconName = reg ? reg.iconName : 'wrench';
  const defaultAction = reg
    ? reg.resolveAction
      ? reg.resolveAction(args, tc)
      : reg.defaultAction
    : t('tool.action.defaultTool', '调用工具');

  let rawTarget = reg
    ? reg.extractTarget(args, tc)
    : extractFallbackTarget(args, tc);
  if (!rawTarget && options?.filePath) {
    rawTarget = {
      text: options.pathLabel || basename(options.filePath),
      kind: 'path',
      clickable: true,
      tooltip: options.filePath,
    };
  }

  const rawExp =
    humanExplanation !== undefined ? humanExplanation : tc.explanation;
  const explanation = cleanHumanExplanation(rawExp, tc.name);
  let label = explanation || defaultAction;
  let target = isTargetContainedInExplanation(label, rawTarget)
    ? undefined
    : rawTarget;

  const status = mapPresentationStatus(tc.status);
  if (status === 'error' && tc.output && tc.output.trim()) {
    const errInfo = formatErrorTarget(tc.output, defaultAction, label);
    target = errInfo.target;
    label = errInfo.label;
  }

  const meta = formatPresentationMeta(tc, args, reg, options);
  const statusZh = formatPresentationStatus(status);
  const rowAriaLabel = formatRowAriaLabel(label, target?.text, meta, statusZh);

  return {
    label,
    ...(target ? { target } : {}),
    meta,
    status,
    iconName,
    kind,
    rowAriaLabel,
  };
}

/** buildToolPresentation 为 resolveToolPresentation 的同义导出 */
export const buildToolPresentation = resolveToolPresentation;
