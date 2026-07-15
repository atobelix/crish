/**
 * 工具展示 + 助手时间线（正文与工具交错）。
 *
 * 原则：
 * - 显示「已结束的工具」为主（带命令/路径摘要），不丢 success
 * - 同 id / 同签名合并时优先终态（success/error）
 * - 中断工具可隐藏；正常完成的绝不能因文案误伤
 */

import type { MessageToolCall, SessionMessage } from '../store/layoutStore';
import { isEditToolName, isShellToolName, sanitizeToolDisplayOutput } from './toolFeedback';

/** 仅真正会话中断才隐藏，勿匹配「工具未完成」等收口文案 */
const HIDE_TOOL_RE = /上次会话中断|会话中断|interrupted|cancelled by user/i;

export function isInterruptedTool(tc: MessageToolCall): boolean {
  if (tc.status !== 'error') return false;
  return HIDE_TOOL_RE.test(tc.output || '');
}

/** 从 arguments 抽出命令/路径 */
export function extractToolCommand(args: string): string {
  if (!args?.trim()) return '';
  const raw = args.trim();
  if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if ('parameters' in (parsed as object) || 'toolName' in (parsed as object)) {
        const p = parsed as Record<string, unknown>;
        const inner = p.parameters ?? p.input;
        if (inner && typeof inner === 'object') {
          return extractToolCommand(JSON.stringify(inner));
        }
        if (typeof p.command === 'string' && p.command.trim()) return p.command.trim();
        if (typeof p.summary === 'string' && p.summary.trim()) return p.summary.trim();
      }
      for (const key of ['command', 'cmd', 'path', 'filePath', 'target_file', 'query', 'pattern']) {
        const v = (parsed as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      if (typeof (parsed as { content?: string }).content === 'string') {
        const c = (parsed as { content: string }).content.trim();
        return c.slice(0, 80) + (c.length > 80 ? '…' : '');
      }
    }
  } catch {
    /* plain */
  }
  return raw;
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** 是否像「人能读」的中文说明（非命令、非 JSON） */
function isHumanExplanation(text: string, toolName: string): boolean {
  const t = text.trim();
  if (!t || t === toolName || t === '需要确认') return false;
  if (t.startsWith('{') || t.startsWith('[')) return false;
  if (/^[\w./\\:-]+\s+[\w./\\:-]+/.test(t) && !/[\u4e00-\u9fff]/.test(t)) return false;
  // 含中文或完整句子
  if (/[\u4e00-\u9fff]/.test(t)) return t.length <= 96;
  // 短英文说明
  if (/^[A-Za-z][A-Za-z0-9 ,.'-]{4,80}$/.test(t) && !/[\\/]/.test(t)) return true;
  return false;
}

/** 去掉前导 cd / 取链式命令中真正干活的一段（便于人话） */
function primaryShellSegment(cmd: string): string {
  let s = cmd.replace(/\s+/g, ' ').trim();
  if (!s) return s;

  // 反复剥掉前导 cd / Set-Location / pushd（cd foo && npm i）
  const cdHead =
    /^(?:cd|Set-Location|sl|pushd)\s+(?:\/[dD]\s+)?(?:"[^"]+"|'[^']+'|[^\s&|;]+)\s*(?:&&|;)\s*/i;
  while (cdHead.test(s)) {
    s = s.replace(cdHead, '');
  }

  // 仍有 && / ; 链：取最后一个非 cd 段（多半是实际操作）
  if (/\s*(?:&&|;)\s*/.test(s)) {
    const parts = s
      .split(/\s*(?:&&|;)\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !/^(?:cd|Set-Location|sl|pushd)\b/i.test(p));
    if (parts.length) s = parts[parts.length - 1];
  }

  // PowerShell / bash 管道：用管道第一段做主意图（| Select-Object 等多为过滤）
  if (/\s\|\s/.test(s) && !/^\s*aws\b/i.test(s)) {
    const head = s.split(/\s\|\s/)[0]?.trim();
    if (head) s = head;
  }

  return s.trim();
}

/**
 * 把终端/shell 命令翻译成用户一眼能懂的说明。
 * 技术原文仍由 toolCommandPreview / tool-row-cmd 展示。
 */
export function humanizeShellCommand(cmd: string): string {
  const full = cmd.replace(/\s+/g, ' ').trim();
  if (!full) return '运行命令';
  const raw = primaryShellSegment(full);
  if (!raw) return '运行命令';
  const lower = raw.toLowerCase();

  // 包管理 / 脚本（npm / pnpm / yarn）
  if (/\b(npm|pnpm|yarn)\s+(ci|install|i)(\s|$)/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:ci|install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\b(npm|pnpm|yarn)\s+add\s+/i.test(raw)) {
    const pkg = raw.replace(/^.*\badd\s+/i, '').split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\b(npm|pnpm|yarn)\s+run\s+([\w:-]+)/i.test(raw) || /\b(npm|pnpm|yarn)\s+([\w:-]+)\b/i.test(raw)) {
    const m = raw.match(/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:-]+)/i);
    const script = m?.[1]?.toLowerCase();
    const skip = !script || script === 'i' || script === 'install' || script === 'ci' || script === 'add';
    if (!skip) {
      if (script === 'build' || script === 'prod') return '构建项目';
      if (script === 'dev' || script === 'start') return '启动开发服务';
      if (script === 'test' || script.startsWith('test:')) return '运行测试';
      if (script === 'lint' || script.startsWith('lint')) return '检查代码规范';
      if (script === 'typecheck' || script === 'tsc') return '检查类型';
      return `运行脚本 ${script}`;
    }
  }
  if (/\bnpx\s+/i.test(raw)) {
    const tool = raw.replace(/^.*\bnpx\s+/i, '').split(/\s+/)[0];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }
  if (/\b(pnpm|yarn)\s+dlx\s+/i.test(raw)) {
    const tool = raw.replace(/^.*\bdlx\s+/i, '').split(/\s+/)[0];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }

  // Bun
  if (/\bbun\s+(ci|install|i)(\s|$)/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:ci|install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\bbun\s+add\s+/i.test(raw)) {
    const pkg = raw.replace(/^.*\badd\s+/i, '').split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\bbun\s+x\s+/i.test(raw) || /\bbunx\s+/i.test(raw)) {
    const tool = raw.replace(/^.*\b(?:bun\s+x|bunx)\s+/i, '').split(/\s+/)[0];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }
  if (/\bbun\s+(run\s+)?(test|build|dev|start|lint|typecheck)\b/i.test(raw)) {
    const m = raw.match(/\bbun\s+(?:run\s+)?([\w:-]+)/i);
    const script = m?.[1]?.toLowerCase();
    if (script === 'build') return '构建项目';
    if (script === 'dev' || script === 'start') return '启动开发服务';
    if (script === 'test' || script?.startsWith('test')) return '运行测试';
    if (script === 'lint' || script?.startsWith('lint')) return '检查代码规范';
    if (script === 'typecheck' || script === 'tsc') return '检查类型';
  }
  if (/\bbun\s+run\s+([\w:-]+)/i.test(raw)) {
    const script = raw.match(/\bbun\s+run\s+([\w:-]+)/i)?.[1];
    return script ? `运行脚本 ${script}` : '运行脚本';
  }
  if (/\bbun\b/i.test(raw)) return '执行 Bun 命令';

  // PHP Composer
  if (/\bcomposer\s+install\b/i.test(raw)) return '安装 PHP 依赖';
  if (/\bcomposer\s+require\b/i.test(raw)) {
    const pkg = raw.replace(/^.*\brequire\s+/i, '').split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `添加 PHP 依赖 ${pkg}` : '添加 PHP 依赖';
  }
  if (/\bcomposer\s+update\b/i.test(raw)) return '更新 PHP 依赖';
  if (/\bcomposer\b/i.test(raw)) return '执行 Composer 命令';

  // Python 包 / 脚本
  if (/\b(pip3?|python\s+-m\s+pip|py\s+-m\s+pip)\s+(install|i)\b/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装 Python 包 ${pkg}` : '安装 Python 依赖';
  }
  if (/\b(pip3?|python\s+-m\s+pip)\s+uninstall\b/i.test(raw)) return '卸载 Python 包';
  if (/\b(pip3?|python\s+-m\s+pip)\s+list\b/i.test(raw)) return '查看已装 Python 包';
  if (/\bpython\b|\bpy\b/i.test(lower) && /\.py\b/i.test(raw)) return '运行 Python 脚本';
  if (/\bpytest\b/i.test(raw)) return '运行 Python 测试';

  // Go
  if (/\bgo\s+test\b/i.test(raw)) return '运行 Go 测试';
  if (/\bgo\s+build\b/i.test(raw)) return '构建 Go 项目';
  if (/\bgo\s+run\b/i.test(raw)) return '运行 Go 程序';
  if (/\bgo\s+mod\b/i.test(raw)) return '管理 Go 依赖';
  if (/\bgo\s+get\b/i.test(raw)) return '获取 Go 依赖';
  if (/\bgo\s+fmt\b|\bgo\s+vet\b/i.test(raw)) return '检查 Go 代码';
  if (/\bgo\s+/i.test(raw)) return '执行 Go 命令';

  // Rust
  if (/\bcargo\s+run\b/i.test(raw)) return '运行 Rust 程序';
  if (/\bcargo\s+test\b/i.test(raw)) return '运行 Rust 测试';
  if (/\bcargo\s+clippy\b/i.test(raw)) return '检查 Rust 代码';
  if (/\bcargo\s+fmt\b/i.test(raw)) return '格式化 Rust 代码';
  if (/\bcargo\s+check\b/i.test(raw)) return '检查 Rust 编译';
  if (/\bcargo\s+build\b/i.test(raw)) return '构建 Rust 项目';
  if (/\bcargo\s+add\b/i.test(raw)) return '添加 Rust 依赖';
  if (/\bcargo\s+/i.test(raw)) return '执行 Cargo 命令';
  if (/\brustc\b/i.test(raw)) return '编译 Rust 源码';

  // .NET
  if (/\bdotnet\s+test\b/i.test(raw)) return '运行 .NET 测试';
  if (/\bdotnet\s+build\b/i.test(raw)) return '构建 .NET 项目';
  if (/\bdotnet\s+run\b/i.test(raw)) return '运行 .NET 程序';
  if (/\bdotnet\s+restore\b/i.test(raw)) return '还原 .NET 依赖';
  if (/\bdotnet\s+publish\b/i.test(raw)) return '发布 .NET 项目';
  if (/\bdotnet\s+/i.test(raw)) return '执行 .NET 命令';

  // CMake / Make
  if (/\bcmake\b/i.test(raw)) {
    if (/\b--build\b/i.test(raw) || /\s+--build\b/i.test(raw)) return '用 CMake 构建';
    return '配置 CMake 工程';
  }
  if (/^make\b/i.test(raw) || /\bmake\s+[\w-]+/i.test(raw)) {
    const t = raw.match(/^make\s+([\w.-]+)/i)?.[1];
    if (t && t !== '-j' && !t.startsWith('-')) return `执行 make ${t}`;
    return '执行 Make 构建';
  }

  // Git
  if (/\bgit\s+status\b/i.test(raw)) return '查看代码变更状态';
  if (/\bgit\s+diff\b/i.test(raw)) return '查看文件差异';
  if (/\bgit\s+log\b/i.test(raw)) return '查看提交历史';
  if (/\bgit\s+add\b/i.test(raw)) return '暂存改动';
  if (/\bgit\s+commit\b/i.test(raw)) return '创建提交';
  if (/\bgit\s+push\b/i.test(raw)) return '推送到远程';
  if (/\bgit\s+pull\b/i.test(raw)) return '拉取远程更新';
  if (/\bgit\s+checkout\b|\bgit\s+switch\b/i.test(raw)) return '切换分支';
  if (/\bgit\s+branch\b/i.test(raw)) return '查看或管理分支';
  if (/\bgit\s+clone\b/i.test(raw)) return '克隆仓库';
  if (/\bgit\s+fetch\b/i.test(raw)) return '获取远程更新';
  if (/\bgit\s+merge\b|\bgit\s+rebase\b/i.test(raw)) return '合并分支';
  if (/\bgit\s+stash\b/i.test(raw)) return '贮藏工作区改动';
  if (/\bgit\s+reset\b/i.test(raw)) return '重置 Git 状态';
  if (/\bgit\s+restore\b/i.test(raw)) return '还原文件改动';
  if (/\bgit\s+revert\b/i.test(raw)) return '回退某次提交';
  if (/\bgit\s+show\b/i.test(raw)) return '查看提交详情';
  if (/\bgit\s+/i.test(raw)) return '执行 Git 操作';

  // 云 / 集群 / 远程
  if (/\bkubectl\b/i.test(raw)) {
    if (/\bget\b/i.test(raw)) return '查询 Kubernetes 资源';
    if (/\bapply\b/i.test(raw)) return '应用 Kubernetes 配置';
    if (/\blogs\b/i.test(raw)) return '查看集群日志';
    if (/\bdescribe\b/i.test(raw)) return '查看 Kubernetes 详情';
    if (/\bdelete\b/i.test(raw)) return '删除 Kubernetes 资源';
    if (/\bexec\b/i.test(raw)) return '进入集群容器';
    return '执行 Kubernetes 操作';
  }
  if (/\baws\b/i.test(raw)) {
    if (/\bs3\b/i.test(raw)) return '操作 AWS S3';
    if (/\bec2\b/i.test(raw)) return '操作 AWS EC2';
    if (/\blambda\b/i.test(raw)) return '操作 AWS Lambda';
    if (/\bsts\b/i.test(raw)) return '查询 AWS 身份';
    return '执行 AWS 命令';
  }
  if (/^ssh\b/i.test(raw) || /\bssh\s+/i.test(raw)) return '通过 SSH 连接远程';
  if (/^scp\b/i.test(raw) || /\bscp\s+/i.test(raw)) return '通过 SCP 传输文件';
  if (/\bdocker\b/i.test(raw)) {
    if (/\bps\b/i.test(raw)) return '查看 Docker 容器';
    if (/\bbuild\b/i.test(raw)) return '构建 Docker 镜像';
    if (/\bcompose\b/i.test(raw) || /\b-compose\b/i.test(raw)) return '运行 Docker Compose';
    if (/\blogs\b/i.test(raw)) return '查看 Docker 日志';
    return '运行 Docker 相关命令';
  }

  // 权限
  if (/^chmod\b/i.test(raw) || /\bchmod\s+/i.test(raw)) return '修改文件权限';
  if (/^chown\b/i.test(raw) || /\bchown\s+/i.test(raw)) return '修改文件所有者';

  // 编译 / 检查 / 测试
  if (/\btsc\b/i.test(raw) || /\btypescript\b/i.test(raw)) return '检查 TypeScript 类型';
  if (/\beslint\b/i.test(raw)) return '运行 ESLint 检查';
  if (/\bprettier\b/i.test(raw)) return '格式化代码';
  if (/\bvitest\b|\bjest\b/i.test(raw)) return '运行测试';
  if (/\bnode\b/i.test(lower) && /\.m?js\b/i.test(raw)) return '运行 Node 脚本';

  // 文件浏览 / 读写（含 PowerShell 别名）
  if (
    /^(ls|dir|ll|Get-ChildItem|gci)\b/i.test(raw) ||
    /\bGet-ChildItem\b/i.test(raw) ||
    (/\bls\s+/i.test(raw) && !/\bnpm\b/i.test(raw))
  ) {
    return '列出目录内容';
  }
  if (/^(cat|type|Get-Content|gc|head|tail)\b/i.test(raw) || /\bGet-Content\b/i.test(raw)) {
    const file = raw.split(/\s+/).find((p) => /[./\\]/.test(p) && !p.startsWith('-'));
    return file ? `查看 ${basename(file)}` : '查看文件内容';
  }
  if (/^(rm|del|Remove-Item|ri)\b/i.test(raw) || /\bRemove-Item\b/i.test(raw)) return '删除文件或目录';
  if (/^(cp|copy|Copy-Item)\b/i.test(raw) || /\bCopy-Item\b/i.test(raw)) return '复制文件';
  if (/^(mv|move|Move-Item|ren|Rename-Item)\b/i.test(raw) || /\bMove-Item\b|\bRename-Item\b/i.test(raw)) {
    return '移动或重命名';
  }
  if (/^(mkdir|md|New-Item)\b/i.test(raw) || /\bNew-Item\b/i.test(raw)) return '创建目录';
  // 纯切换目录（复合命令已在 primaryShellSegment 剥掉）
  if (/^(cd|Set-Location|sl|pushd|popd)\b/i.test(raw)) return '切换工作目录';

  // 搜索
  if (/\brg\b|\bgrep\b|\bfindstr\b|\bSelect-String\b|\bfind\b/i.test(raw)) {
    const q = raw.match(/['"]([^'"]{1,40})['"]/) || raw.match(/\s(-e\s+)?(\S{2,40})\s*$/);
    const term = q?.[1] || q?.[2];
    return term && !term.startsWith('-') ? `搜索「${term}」` : '搜索代码';
  }

  // 网络 / 进程（PowerShell 常见）
  if (/\bcurl\b|\bwget\b|\bInvoke-WebRequest\b|\bInvoke-RestMethod\b/i.test(raw)) return '请求网络资源';
  if (/\bGet-Process\b|\bStop-Process\b|(^|\s)ps(\s|$)/i.test(raw)) return '查看或管理进程';
  if (/\bGet-Service\b|\bStart-Service\b|\bStop-Service\b/i.test(raw)) return '管理 Windows 服务';
  if (/\bSelect-Object\b|\bWhere-Object\b|\bForEach-Object\b|\bSort-Object\b/i.test(raw)) {
    return '处理命令输出';
  }

  return '运行命令';
}

/**
 * 人话主文案：用户扫一眼就知道 AI 在做什么。
 * 技术命令放到 toolCommandPreview / 折叠详情。
 */
export function toolHumanLabel(tc: MessageToolCall): string {
  const name = (tc.name || 'tool').toLowerCase();
  const cmd = extractToolCommand(tc.arguments || '');
  const exp = (tc.explanation || '').trim();

  if (exp && isHumanExplanation(exp, tc.name || '')) {
    return exp.length > 72 ? exp.slice(0, 71) + '…' : exp;
  }

  if (isShellToolName(name) || name.includes('bash') || name.includes('shell') || name.includes('exec') || name.includes('powershell')) {
    return cmd ? humanizeShellCommand(cmd) : '运行终端命令';
  }
  if (isEditToolName(name) || name.includes('write') || name.includes('edit') || name.includes('patch') || name.includes('apply')) {
    return cmd ? `正在修改 ${basename(cmd)}` : '正在修改文件';
  }
  if (name.includes('read') || name.includes('cat') || name.includes('view') || name.includes('open_file')) {
    return cmd ? `正在查看 ${basename(cmd)}` : '正在查看文件';
  }
  if (name.includes('list') || name.includes('glob') || name.includes('dir') || name.includes('ls')) {
    if (cmd && cmd !== '.' && cmd !== './') {
      const short = cmd.length > 36 ? '…' + cmd.slice(-34) : cmd;
      return `正在浏览 ${short}`;
    }
    return '正在浏览目录';
  }
  if (name.includes('grep') || name.includes('search') || name.includes('find') || name.includes('rg')) {
    const q = cmd.replace(/^.*(?:pattern|query)["']?\s*[:=]\s*["']?/i, '').slice(0, 32);
    if (cmd && cmd.length < 40) return `正在搜索 ${cmd}`;
    if (q && !q.startsWith('{')) return `正在搜索「${q}」`;
    return '正在搜索代码';
  }
  if (name.includes('web') || name.includes('fetch') || name.includes('http') || name.includes('browser')) {
    return '正在访问网络';
  }
  if (name === 'run_subagent' || name.includes('subagent')) {
    try {
      const parsed = tc.arguments?.trim().startsWith('{')
        ? (JSON.parse(tc.arguments) as Record<string, unknown>)
        : null;
      const desc =
        (typeof parsed?.description === 'string' && parsed.description.trim()) ||
        (typeof parsed?.prompt === 'string' && parsed.prompt.trim().slice(0, 40)) ||
        '';
      if (desc) return `协作子任务：${desc.length > 40 ? desc.slice(0, 39) + '…' : desc}`;
    } catch {
      /* plain */
    }
    if (exp && isHumanExplanation(exp, tc.name || '')) return `协作子任务：${exp.slice(0, 40)}`;
    return '启动协作子任务';
  }
  if (name.includes('git')) {
    return cmd ? humanizeShellCommand(cmd.startsWith('git') ? cmd : `git ${cmd}`) : '执行 Git 操作';
  }
  if (name.includes('mcp')) return '调用扩展服务';
  if (name.includes('memory')) return '读写记忆';
  if (name.includes('todo') || name.includes('plan')) return '更新任务计划';

  if (cmd) {
    // 无更好文案时，用「操作 + 短目标」
    const short = basename(cmd);
    if (short && short !== cmd && short.length < 48) return `使用工具处理 ${short}`;
  }
  const n = tc.name || '工具';
  // 把 snake_case 工具名收成稍可读
  const pretty = n.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return pretty ? `调用 ${pretty}` : '调用工具';
}

/**
 * 折叠行主文案：人话优先（扫一眼知意图）。
 * @deprecated 语义等同 toolHumanLabel，保留别名避免大面积改调用方
 */
export function toolSummaryLabel(tc: MessageToolCall): string {
  return toolHumanLabel(tc);
}

/**
 * 次要技术预览：真实命令/路径，与人话主文案区分开。
 * 人话作主行时技术副行尽量显示完整命令（默认 max 72）。
 */
export function toolCommandPreview(tc: MessageToolCall, max = 72): string {
  const cmd = extractToolCommand(tc.arguments || '');
  if (!cmd) return '';
  const human = toolHumanLabel(tc);
  const one = cmd.replace(/\s+/g, ' ').trim();
  // 人话已等于完整命令时不再重复
  if (human === one) return '';
  // 人话已是中文说明时，副行展示完整技术命令（可截断）
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

/** 折叠行预览可截断；展开区请用 fullToolOutput */
export function truncateToolOutput(output: string, maxLines = 16, maxChars = 1600): string {
  if (!output) return '';
  // 运行中占位不展示；「完成」允许作为结果预览
  if (/^(执行中|运行中)…?$/.test(output.trim())) return '';
  let text = sanitizeToolDisplayOutput(output);
  if (!text) {
    // 清洗后为空但原串是简短终态词
    if (/^(完成|OK|ok|失败|failed)$/i.test(output.trim())) return output.trim();
    return '';
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…（已截断）';
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n…（共 ${lines.length} 行）`;
  }
  return text;
}

/** 展开区完整正文（仅清洗，不截断） */
export function fullToolOutput(output: string): string {
  if (!output) return '';
  if (/^(执行中|运行中)…?$/.test(output.trim())) return '';
  const text = sanitizeToolDisplayOutput(output);
  if (!text) {
    if (/^(完成|OK|ok|失败|failed)$/i.test(output.trim())) return output.trim();
    return '';
  }
  return text;
}

/** 从工具参数取可点路径展示名（basename） */
export function toolPathDisplayName(filePath: string): string {
  return basename(filePath);
}

export function isInspectTool(tc: MessageToolCall): boolean {
  if (tc.status === 'pending_approval') return false;
  const n = (tc.name || '').toLowerCase();
  if (isEditToolName(n)) return false;
  if (isShellToolName(n)) {
    const cmd = extractToolCommand(tc.arguments || '').toLowerCase();
    if (/^(pwd|ls|dir|cat|type|head|tail|git\s+status|git\s+diff|git\s+log|echo|whoami|hostname)\b/.test(cmd)) {
      return true;
    }
    if (/\b(rm|del|move|copy|set-content|out-file|write|install|npm\s+i|mkdir)\b/i.test(cmd)) {
      return false;
    }
    return true;
  }
  return (
    n.includes('read') ||
    n.includes('grep') ||
    n.includes('search') ||
    n.includes('list') ||
    n.includes('glob') ||
    n.includes('stat')
  );
}

export type ToolRenderItem =
  | { kind: 'single'; tc: MessageToolCall }
  | { kind: 'group'; id: string; tools: MessageToolCall[]; label: string };

function statusRank(s: MessageToolCall['status']): number {
  if (s === 'success') return 4;
  if (s === 'error') return 3;
  if (s === 'pending_approval') return 2;
  return 1; // running
}

/** 折叠行结果预览（一行） */
export function toolResultPreview(tc: MessageToolCall, max = 72): string {
  if (tc.status === 'running' || tc.status === 'pending_approval') return '';
  const raw = truncateToolOutput(tc.output || '', 2, max + 20);
  if (!raw) {
    if (tc.status === 'success') return '完成';
    if (tc.status === 'error') return '失败';
    return '';
  }
  const line = raw.split('\n').find((l) => l.trim()) || raw;
  const one = line.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : one.slice(0, max - 1) + '…';
}

export function toolHasDisplayableResult(tc: MessageToolCall): boolean {
  if (tc.status === 'running' || tc.status === 'pending_approval') return false;
  if (tc.diffs && tc.diffs.length > 0) return true;
  const t = truncateToolOutput(tc.output || '');
  return Boolean(t) || tc.status === 'success' || tc.status === 'error';
}

/**
 * 规范化助手消息时间线：blocks 与 toolCalls 对齐，保证可交错渲染。
 * live / hydrate / 持久化共用，避免各写一套顺序。
 */
export function normalizeAssistantTimeline(msg: SessionMessage): SessionMessage {
  if (msg.sender !== 'assistant') return msg;
  const tools = [...(msg.toolCalls || [])];
  const toolIds = new Set(tools.map((t) => t.id));
  let blocks = [...(msg.blocks || [])].filter(
    (b) => b.type !== 'tool_call' || (b.id != null && toolIds.has(b.id)),
  );

  const inBlocks = new Set(
    blocks.filter((b) => b.type === 'tool_call' && b.id).map((b) => b.id as string),
  );
  const missing = tools.filter((t) => !inBlocks.has(t.id));

  if (missing.length > 0) {
    // 无真实交错数据时：工具在前、正文在后（agent 常见形态）
    const onlyTextOrEmpty =
      blocks.length === 0 || blocks.every((b) => b.type === 'text');
    if (onlyTextOrEmpty) {
      const textContent =
        msg.text?.trim() ||
        blocks
          .filter((b) => b.type === 'text')
          .map((b) => b.content || '')
          .join('\n')
          .trim();
      blocks = [
        ...tools.map((t) => ({ type: 'tool_call' as const, id: t.id })),
        ...(textContent ? [{ type: 'text' as const, content: textContent }] : []),
      ];
    } else {
      // 有交错：缺失的 tool 插在最后一个 text 之前，或末尾
      let insertAt = blocks.length;
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (blocks[i].type === 'text') {
          insertAt = i;
          break;
        }
      }
      const inject = missing.map((t) => ({ type: 'tool_call' as const, id: t.id }));
      blocks = [...blocks.slice(0, insertAt), ...inject, ...blocks.slice(insertAt)];
    }
  }

  // 有正文但无 text 块
  if ((msg.text || '').trim() && !blocks.some((b) => b.type === 'text')) {
    blocks.push({ type: 'text', content: msg.text || '' });
  }

  return {
    ...msg,
    toolCalls: tools,
    blocks,
  };
}

/** 仅按 id 合并状态；同命令多次调用保留多行 */
export function dedupeToolCalls(toolCalls: MessageToolCall[]): MessageToolCall[] {
  const byId = new Map<string, MessageToolCall>();
  const order: string[] = [];
  for (const tc of toolCalls) {
    if (!tc?.id) continue;
    const prev = byId.get(tc.id);
    if (!prev) {
      byId.set(tc.id, { ...tc });
      order.push(tc.id);
      continue;
    }
    if (statusRank(tc.status) > statusRank(prev.status)) {
      byId.set(tc.id, {
        ...prev,
        ...tc,
        arguments: tc.arguments || prev.arguments,
        explanation: tc.explanation || prev.explanation,
        output: tc.output || prev.output,
      });
    } else if (statusRank(tc.status) === statusRank(prev.status)) {
      byId.set(tc.id, {
        ...prev,
        ...tc,
        arguments: tc.arguments || prev.arguments,
        output: tc.output || prev.output,
      });
    } else {
      byId.set(tc.id, {
        ...prev,
        arguments: prev.arguments || tc.arguments,
        explanation: prev.explanation || tc.explanation,
        output: prev.output || tc.output,
      });
    }
  }
  return order.map((id) => byId.get(id)!).filter((tc) => tc && !isInterruptedTool(tc));
}

export function buildToolRenderItems(toolCalls: MessageToolCall[]): ToolRenderItem[] {
  const visible = dedupeToolCalls(toolCalls);
  const out: ToolRenderItem[] = [];
  let buf: MessageToolCall[] = [];

  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      out.push({ kind: 'single', tc: buf[0] });
    } else {
      const last = buf[buf.length - 1];
      const n = buf.length;
      out.push({
        kind: 'group',
        id: `grp-${buf[0].id}`,
        tools: [...buf],
        label: `${toolHumanLabel(last)} · ${n} 步`,
      });
    }
    buf = [];
  };

  for (const tc of visible) {
    if (tc.status === 'pending_approval') {
      flush();
      out.push({ kind: 'single', tc });
      continue;
    }
    // 有实质输出的查看类单独成行，避免「组折叠藏结果」
    if (isInspectTool(tc) && !toolHasDisplayableResult(tc) && tc.status !== 'running') {
      buf.push(tc);
    } else if (isInspectTool(tc) && tc.status === 'running') {
      buf.push(tc);
    } else if (isInspectTool(tc) && toolHasDisplayableResult(tc)) {
      flush();
      out.push({ kind: 'single', tc });
    } else {
      flush();
      out.push({ kind: 'single', tc });
    }
  }
  flush();
  return out;
}

export type AssistantTimelineItem =
  | { kind: 'text'; content: string; key: string }
  | { kind: 'tools'; items: ToolRenderItem[]; key: string };

/**
 * 构建交错时间线。
 * blocks 可用时按 blocks 顺序；否则工具在前、正文在后。
 */
export function buildAssistantTimeline(msg: SessionMessage): AssistantTimelineItem[] {
  try {
    const tools = msg.toolCalls || [];
    const toolsById = new Map(tools.map((t) => [t.id, t]));
    const blocks = msg.blocks || [];
    const items: AssistantTimelineItem[] = [];
    let toolBuf: MessageToolCall[] = [];
    let ti = 0;
    let xi = 0;

    const flushTools = () => {
      if (!toolBuf.length) return;
      const rendered = buildToolRenderItems(toolBuf);
      if (rendered.length) {
        items.push({ kind: 'tools', items: rendered, key: `tools-${ti++}` });
      }
      toolBuf = [];
    };

    if (blocks.length > 0) {
      const used = new Set<string>();
      for (const b of blocks) {
        if (b.type === 'text') {
          flushTools();
          const c = b.content || '';
          if (c.trim()) items.push({ kind: 'text', content: c, key: `text-${xi++}` });
        } else if (b.type === 'tool_call' && b.id) {
          const tc = toolsById.get(b.id);
          if (tc) {
            toolBuf.push(tc);
            used.add(b.id);
          }
        }
      }
      flushTools();
      const orphan = tools.filter((t) => !used.has(t.id));
      if (orphan.length) {
        const rendered = buildToolRenderItems(orphan);
        if (rendered.length) items.push({ kind: 'tools', items: rendered, key: 'tools-orphan' });
      }
      if (!items.some((i) => i.kind === 'text') && (msg.text || '').trim()) {
        items.push({ kind: 'text', content: msg.text || '', key: 'text-full' });
      }
      return items;
    }

    if (tools.length) {
      const rendered = buildToolRenderItems(tools);
      if (rendered.length) items.push({ kind: 'tools', items: rendered, key: 'tools-0' });
    }
    if ((msg.text || '').trim()) {
      items.push({ kind: 'text', content: msg.text || '', key: 'text-0' });
    }
    return items;
  } catch {
    // 兜底：至少显示全文
    if ((msg.text || '').trim()) {
      return [{ kind: 'text', content: msg.text || '', key: 'text-fallback' }];
    }
    return [];
  }
}

export function assistantCopyText(msg: SessionMessage): string {
  const raw = (msg.text || '').trim();
  if (raw) return raw;
  return (msg.blocks || [])
    .filter((b) => b.type === 'text' && (b.content || '').trim())
    .map((b) => (b.content || '').trim())
    .join('\n\n');
}

export function extractImageRefs(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)) if (m[1]) out.push(m[1]);
  for (const m of text.matchAll(
    /(?:^|[\s"'`])((?:[A-Za-z]:)?[\\/][^\s"'`]+\.(?:png|jpe?g|gif|webp|svg)|(?:\.\/|\/)[^\s"'`]+\.(?:png|jpe?g|gif|webp|svg))/gi,
  )) {
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)].slice(0, 8);
}
