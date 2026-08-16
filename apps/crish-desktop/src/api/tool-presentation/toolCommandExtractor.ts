/**
 * CLI 命令与工作目录 CWD 提取与智能人话翻译引擎。
 */

import { basename } from './toolArgsNormalizer';

/** 抽出 powershell/pwsh -Command/-c 内层脚本 */
export function unwrapPowerShellCommand(cmd: string): string {
  const s = cmd.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = s.match(
    /^(?:powershell|pwsh)(?:\.exe)?\b(?:\s+-[A-Za-z]+)*=?(?:\s+"([^"]*)"|\s+'([^']*)'|\s+(.+))?$/i
  );
  if (!m) {
    const m2 = s.match(
      /(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*?-(?:Command|c)\s+(?:"([^"]*)"|'([^']*)'|(.+))$/i
    );
    if (!m2) return s;
    return (m2[1] || m2[2] || m2[3] || '').trim();
  }
  return (m[1] || m[2] || m[3] || '').trim() || s;
}

/** 去掉前导 cd / 取链式命令中真正干活的一段（便于人话） */
export function primaryShellSegment(cmd: string): string {
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
    if (parts.length) s = parts[parts.length - 1]!;
  }

  // PowerShell / bash 管道：用管道第一段做主意图（| Select-Object 等多为过滤）
  if (/\s\|\s/.test(s) && !/^\s*aws\b/i.test(s)) {
    const head = s.split(/\s\|\s/)[0]?.trim();
    if (head) s = head;
  }

  return s.trim();
}

/**
 * 将命令行字符串智能翻译为人性化的中文动作描述
 */
export function humanizeShellCommand(cmd: string): string {
  const full = cmd.replace(/\s+/g, ' ').trim();
  if (!full) return '运行命令';
  const unwrapped = /^(?:powershell|pwsh)\b/i.test(full)
    ? unwrapPowerShellCommand(full) || full
    : full;
  const raw = primaryShellSegment(unwrapped);
  if (!raw) return '运行命令';
  const lower = raw.toLowerCase();

  // 1. 包管理器 (NPM / PNPM / Yarn / Bun)
  if (/\b(npm|pnpm|yarn|bun)\s+(ci|install|i)(\s|$)/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:ci|install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+add\s+/i.test(raw)) {
    const pkg = raw
      .replace(/^.*\badd\s+/i, '')
      .split(/\s+/)
      .find((t) => t && !t.startsWith('-'));
    return pkg ? `添加依赖 ${pkg}` : '安装项目依赖';
  }
  if (/\bnpx\s+([\w@/:-]+)/i.test(raw)) {
    const tool = raw.match(/\bnpx\s+([\w@/:-]+)/i)?.[1];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }
  if (/\b(pnpm|yarn)\s+dlx\s+([\w@/:-]+)/i.test(raw)) {
    const tool = raw.match(/\b(?:pnpm|yarn)\s+dlx\s+([\w@/:-]+)/i)?.[1];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }
  if (/\bbun\s+x\s+([\w@/:-]+)|\bbunx\s+([\w@/:-]+)/i.test(raw)) {
    const tool =
      raw.match(/\b(?:bun\s+x|bunx)\s+([\w@/:-]+)/i)?.[1] ||
      raw.match(/\b(?:bun\s+x|bunx)\s+([\w@/:-]+)/i)?.[2];
    return tool ? `运行工具 ${tool}` : '运行命令行工具';
  }
  if (
    /\b(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/i.test(raw) ||
    /\b(npm|pnpm|yarn)\s+([\w:-]+)\b/i.test(raw)
  ) {
    const m = raw.match(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:-]+)/i);
    const script = m?.[1]?.toLowerCase();
    if (script && !['i', 'install', 'ci', 'add', 'dlx', 'x'].includes(script)) {
      if (['build', 'prod', 'compile'].includes(script)) return '构建项目';
      if (['dev', 'start', 'serve'].includes(script)) return '启动开发服务';
      if (script === 'test' || script.startsWith('test'))
        return `运行测试 (${script})`;
      if (script === 'lint' || script.startsWith('lint')) return '检查代码规范';
      if (['typecheck', 'tsc', 'check'].includes(script)) return '检查代码类型';
      return `运行脚本 ${script}`;
    }
  }

  // 2. Rust & Cargo
  if (/\bcargo\s+test\b/i.test(raw)) return '运行 Rust 测试';
  if (/\bcargo\s+check\b/i.test(raw)) return '检查 Rust 编译';
  if (/\bcargo\s+clippy\b/i.test(raw)) return '运行 Clippy 审查';
  if (/\bcargo\s+build\b/i.test(raw)) return '构建 Rust 项目';
  if (/\bcargo\s+run\b/i.test(raw)) return '运行 Rust 程序';
  if (/\bcargo\s+fmt\b/i.test(raw)) return '格式化 Rust 代码';
  if (/\bcargo\s+add\b/i.test(raw)) return '添加 Rust 依赖';
  if (/\bcargo\b/i.test(raw)) return '执行 Cargo 命令';
  if (/\brustc\b/i.test(raw)) return '编译 Rust 源码';

  // 3. Git 版本控制
  if (/\bgit\s+status\b/i.test(raw)) return '查看代码变更状态';
  if (/\bgit\s+diff\b/i.test(raw)) return '查看文件差异';
  if (/\bgit\s+log\b/i.test(raw)) return '查看提交历史';
  if (/\bgit\s+commit\b/i.test(raw)) return '创建 Git 提交';
  if (/\bgit\s+add\b/i.test(raw)) return '暂存代码改动';
  if (/\bgit\s+push\b/i.test(raw)) return '推送到远程仓库';
  if (/\bgit\s+pull\b/i.test(raw)) return '拉取远程更新';
  if (/\bgit\s+checkout\b|\bgit\s+switch\b/i.test(raw)) return '切换 Git 分支';
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

  // 4. PHP / Python / Go / .NET / C++
  if (/\bcomposer\s+install\b/i.test(raw)) return '安装 PHP 依赖';
  if (/\bcomposer\s+require\b/i.test(raw)) return '添加 PHP 依赖';
  if (/\b(pip3?|python\s+-m\s+pip)\s+(install|i)\b/i.test(raw)) {
    const rest = raw.replace(/^.*\b(?:install|i)\s*/i, '').trim();
    const pkg = rest.split(/\s+/).find((t) => t && !t.startsWith('-'));
    return pkg ? `安装 Python 包 ${pkg}` : '安装 Python 依赖';
  }
  if (/\b(pip3?|python\s+-m\s+pip)\s+uninstall\b/i.test(raw))
    return '卸载 Python 包';
  if (/\bpytest\b/i.test(raw)) return '运行 Python 测试';
  if (/\bpython\b|\bpy\b/i.test(lower) && /\.py\b/i.test(raw))
    return '运行 Python 脚本';
  if (/\bgo\s+test\b/i.test(raw)) return '运行 Go 测试';
  if (/\bgo\s+build\b/i.test(raw)) return '构建 Go 项目';
  if (/\bgo\s+run\b/i.test(raw)) return '运行 Go 程序';
  if (/\bdotnet\s+test\b/i.test(raw)) return '运行 .NET 测试';
  if (/\bdotnet\s+build\b/i.test(raw)) return '构建 .NET 项目';
  if (/\bcmake\b/i.test(raw)) return '配置或构建 CMake 工程';
  if (/^make\b/i.test(raw)) return '执行 Make 构建';

  // 5. 常见工具与命令
  if (/\btsc\b|\btypescript\b/i.test(raw)) return '检查 TypeScript 类型';
  if (/\beslint\b/i.test(raw)) return '运行 ESLint 检查';
  if (/\bprettier\b/i.test(raw)) return '格式化代码';
  if (/\bvitest\b|\bjest\b/i.test(raw)) return '运行测试';
  if (/^(ls|dir|Get-ChildItem|gci)\b/i.test(raw)) return '列出目录内容';
  if (/^(cat|type|Get-Content|gc|head|tail)\b/i.test(raw)) {
    const file = raw
      .split(/\s+/)
      .find((p) => /[./\\]/.test(p) && !p.startsWith('-'));
    return file ? `查看 ${basename(file)}` : '查看文件内容';
  }
  if (/\b(rg|grep|findstr|Select-String)\b/i.test(raw)) {
    const q =
      raw.match(/['"]([^'"]{1,40})['"]/) ||
      raw.match(/\s(-e\s+)?(\S{2,40})\s*$/);
    const term = q?.[1] || q?.[2];
    return term && !term.startsWith('-') ? `搜索「${term}」` : '搜索代码';
  }

  // 6. 短命令提取兜底
  const words = raw.split(/\s+/).slice(0, 3).join(' ');
  if (words.length <= 32) return `运行 ${words}`;

  return '运行终端命令';
}
