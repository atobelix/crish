/**
 * apps/crish-desktop/src/api/tool-presentation/toolActionClassifier.ts
 *
 * 工具动作分类纯逻辑（两阶段：精确注册表 → 保守回退规则）。
 *
 * 【为何不用朴素子串匹配】
 *   朴素写法 `name.includes('read')` 会把 `read_url_content`（网络访问）误判为
 *   文件读取；`isSubagentToolName` 与 `view` 子串又会让 `delete_file` 漏判或错判。
 *   因此本模块采用**两阶段**策略：
 *     ① `EXACT_ACTION_TABLE`——权威工具名 → 动作，O(1) 命中，无歧义；
 *     ② `FALLBACK_RULES`——有序保守规则，仅对未登记名生效，且**否定优先**
 *        （先排除无关域，再匹配）。
 *
 * 【SSOT】权威定义位置：本文件（07-方案收敛审计与SSOT裁决.md §2.2）。
 * 负向红线：禁止在其它文件实现工具分类；禁止把 emoji/Lucide 名称写进本模块。
 */

import { isSubagentToolName } from '../../components/chat-message/turnProcessState';

/**
 * 工具在「折叠态摘要」中的动作轴（与 `ProcessLeadAction` 同构，但语义更细）。
 *
 * - `subagent`：多 Agent / 子任务
 * - `edit`：写文件、编辑、替换、打补丁、删除（删除亦属写侧变更）
 * - `search`：代码/文本检索、目录列举、Web 搜索
 * - `read`：读文件、查阅资源、网络抓取
 * - `command`：终端/Shell 执行
 * - `thought`：非工具（仅用于聚合兜底，工具分类不会返回）
 */
export type ToolActionKind = 'subagent' | 'edit' | 'search' | 'read' | 'command';

/**
 * 阶段 ①：精确注册表。
 *
 * 只登记**语义明确无歧义**的工具名。未登记者交由 `FALLBACK_RULES`。
 */
export const EXACT_ACTION_TABLE: Readonly<Record<string, ToolActionKind>> = Object.freeze({
  // ── 子代理 / 多 Agent ──
  invoke_subagent: 'subagent',
  run_subagent: 'subagent',
  wait_subagents: 'subagent',

  // ── 编辑 / 写入 / 删除（写侧统一归 `edit`）──
  write_file: 'edit',
  write_to_file: 'edit',
  create_file: 'edit',
  edit_file: 'edit',
  replace_string_in_file: 'edit',
  apply_patch: 'edit',
  delete_file: 'edit',
  delete_dir: 'edit',
  remove_dir: 'edit',
  trash: 'edit',

  // ── 检索 / 列举（读侧但属「查找」语义）──
  grep_search: 'search',
  find_by_name: 'search',
  search_web: 'search',
  web_search: 'search',
  list_dir: 'search',
  list_directory: 'search',
  list_files: 'search',
  glob: 'search',
  ls: 'search',

  // ── 读取 / 抓取 ──
  read_file: 'read',
  view_file: 'read',
  open_file: 'read',
  read_url_content: 'read',
  read_browser_page: 'read',
  read_resource: 'read',
  list_resources: 'read',

  // ── 终端执行 ──
  run_command: 'command',
  run_in_terminal: 'command',
  execute_command: 'command',
});

/**
 * 阶段 ②：有序保守回退规则。
 *
 * **顺序即优先级**，且每条规则均为「否定优先」的谓词——先排除明确的无关域，
 * 再匹配自身特征。顺序不可随意调整。
 */
const FALLBACK_RULES: ReadonlyArray<{
  readonly match: (name: string) => boolean;
  readonly action: ToolActionKind;
}> = [
  // 1. 子代理（复用既有唯一判定源，禁止另写一份）
  { match: (n) => isSubagentToolName(n), action: 'subagent' },

  // 2. 网络抓取：read_url_* 必须在通用 read 之前判定（否则被误判为文件读取）
  {
    match: (n) =>
      n.startsWith('read_url') ||
      n.includes('fetch') ||
      n.includes('browser') ||
      n.includes('_url'),
    action: 'read',
  },

  // 3. 目录/资源列举：`list_*` 属查找语义
  { match: (n) => n.startsWith('list_') || n.startsWith('ls_'), action: 'search' },

  // 4. 检索：grep/find/search/glob/rg（注意：`search_web` 已在精确表命中）
  {
    match: (n) =>
      n.includes('grep') ||
      n.includes('search') ||
      n.includes('find') ||
      n.includes('glob') ||
      n.endsWith('_rg'),
    action: 'search',
  },

  // 5. 写侧：write / edit / replace / patch / delete / remove / create
  {
    match: (n) =>
      n.includes('write') ||
      n.includes('edit') ||
      n.includes('replace') ||
      n.includes('patch') ||
      n.includes('delete') ||
      n.includes('remove') ||
      n.includes('create'),
    action: 'edit',
  },

  // 6. 读侧：read / view / cat / open（`preview` 排除，避免与 UI 预览混淆）
  {
    match: (n) =>
      (n.includes('read') || n.includes('view') || n === 'cat' || n.includes('open')) &&
      !n.includes('preview'),
    action: 'read',
  },

  // 7. 终端执行：shell / bash / powershell / pwsh / exec / command / terminal
  {
    match: (n) =>
      n.includes('shell') ||
      n.includes('bash') ||
      n.includes('powershell') ||
      n.includes('pwsh') ||
      n.includes('exec') ||
      n.includes('command') ||
      n.includes('terminal'),
    action: 'command',
  },
];

/**
 * 工具名 → 动作轴（两阶段分类）。
 *
 * @param name 工具名（原始大小写、连字符/空格混排均可）
 * @returns 动作轴；未匹配任何规则时回退为 `'command'`（终端类为最大公约数兜底，
 *          与折叠摘要的「mixed」区分：此处的兜底是**分类**兜底，不是摘要兜底）
 */
export function classifyToolAction(name?: string): ToolActionKind {
  if (!name) return 'command';

  const normalized = name.toLowerCase().replace(/[\s-]+/g, '_');

  // 阶段 ①：精确注册表
  const exact = EXACT_ACTION_TABLE[normalized];
  if (exact !== undefined) return exact;

  // 阶段 ②：有序保守回退
  for (const rule of FALLBACK_RULES) {
    if (rule.match(normalized)) return rule.action;
  }

  // 最终兜底
  return 'command';
}

/**
 * 批量分类（纯函数，无副作用）。
 */
export function classifyToolActions(names: readonly string[]): ToolActionKind[] {
  return names.map((n) => classifyToolAction(n));
}
