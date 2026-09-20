#!/usr/bin/env node
/**
 * show-full-diff.mjs — 一次性查看/导出全量未暂存代码变更（含修改文件 + 新建未跟踪文件）
 *
 * 用法：
 *   node scripts/show-full-diff.mjs                # 直接打印全量 diff 到终端并自动落盘备份
 *   node scripts/show-full-diff.mjs --out diff.patch # 保存到指定文件
 *   node scripts/show-full-diff.mjs --staged       # 包含已暂存的 diff
 *   npm run diff:all                              # package.json 快捷指令
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);

let outPath = null;
let includeStaged = false;
let printStdout = true;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) {
    outPath = args[i + 1];
    i++;
  } else if (args[i] === '--staged') {
    includeStaged = true;
  } else if (args[i] === '--silent') {
    printStdout = false;
  }
}

// 1. 获取 git diff（已跟踪修改）
let trackedDiff = '';
try {
  const stagedFlag = includeStaged ? 'HEAD' : '';
  trackedDiff = execSync(`git diff ${stagedFlag}`, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
} catch (err) {
  console.error('[show-full-diff] 执行 git diff 失败:', err.message);
}

// 2. 获取 untracked 新建文件并生成新建 diff
let untrackedDiff = '';
try {
  const statusOutput = execSync('git status --porcelain', {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const untrackedFiles = statusOutput
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  for (const relPath of untrackedFiles) {
    const fullPath = join(ROOT, relPath);
    if (!existsSync(fullPath)) continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // 遍历目录内的文件
      const walk = (dir) => {
        let results = [];
        const list = execSync(`git ls-files --others --exclude-standard "${dir}"`, {
          cwd: ROOT,
          encoding: 'utf8',
        })
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        return list;
      };
      const files = walk(relPath);
      for (const f of files) {
        untrackedDiff += formatNewFileDiff(f);
      }
    } else {
      untrackedDiff += formatNewFileDiff(relPath);
    }
  }
} catch (err) {
  console.error('[show-full-diff] 获取未跟踪文件失败:', err.message);
}

function formatNewFileDiff(relPath) {
  const fullPath = join(ROOT, relPath);
  if (!existsSync(fullPath)) return '';
  const stat = statSync(fullPath);
  if (stat.isDirectory()) return '';

  // 跳过二进制文件或超大文件 (> 2MB)
  if (stat.size > 2 * 1024 * 1024) {
    return `\n# [SKIPPED LARGE FILE] ${relPath} (${stat.size} bytes)\n`;
  }

  try {
    const content = readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    const normPath = posix.normalize(relPath.replaceAll('\\', '/'));
    let out = `\ndiff --git a/${normPath} b/${normPath}\n`;
    out += `new file mode 100644\n`;
    out += `--- /dev/null\n`;
    out += `+++ b/${normPath}\n`;
    out += `@@ -0,0 +1,${lines.length} @@\n`;
    for (const line of lines) {
      out += `+${line}\n`;
    }
    return out;
  } catch {
    return `\n# [BINARY OR UNREADABLE] ${relPath}\n`;
  }
}

const fullDiff = (trackedDiff + '\n' + untrackedDiff).trim() + '\n';

// 默认落盘到 .agent-outputs/workspace-full-diff.patch，方便外部随时直接查看完整文件
const defaultBackupPath = join(ROOT, '.agent-outputs', 'workspace-full-diff.patch');
const targetPath = outPath ? (outPath.startsWith('/') || outPath.includes(':') ? outPath : join(ROOT, outPath)) : defaultBackupPath;

try {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, fullDiff, 'utf8');
} catch (err) {
  console.error('[show-full-diff] 写入备份文件失败:', err.message);
}

if (printStdout) {
  process.stdout.write(fullDiff);
}

console.error(`\n\n[show-full-diff] ✅ 全量未暂存代码变更已生成！`);
console.error(`[show-full-diff] 📄 完整 diff 文件已保存至: ${targetPath} (${Buffer.byteLength(fullDiff, 'utf8')} 字节)`);
