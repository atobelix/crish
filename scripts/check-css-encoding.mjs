/**
 * check-css-encoding.mjs —— CSS 编码门禁（R11-2 入库，批次 9.1）
 *
 * 扫描 apps/crish-desktop/src 下全部 css/tsx/ts 源文件，三项检查：
 * 1. 严格 UTF-8 解码（A 类真 GBK 字节 → 报错）；
 * 2. UTF-8 BOM 检测（应无 BOM）；
 * 3. U+FFFD 替换符扫描（B 类乱码固化文本 → 报错）。
 *
 * 2026-08-10 批次 9.1 已将 6 个历史损坏文件（panels / shell-dragdrop /
 * shell-layout / shell-polish / shell-workspace / chat 域等）修复清零，
 * 本脚本为防复发门禁；退出码非 0 = 违规。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../apps/crish-desktop/src', import.meta.url));
const EXTS = new Set(['.css', '.ts', '.tsx']);

const violations = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (EXTS.has(extname(p)) && !/\.test\.(ts|tsx)$/.test(p)) {
      const bytes = readFileSync(p);
      // ① BOM 检测
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        violations.push(`${p}: UTF-8 BOM 必须去除`);
      }
      // ② 严格 UTF-8 解码（A 类真 GBK 字节）
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        violations.push(`${p}: 非法 UTF-8 字节（疑似 GBK 编码，须转 UTF-8 无 BOM）`);
        continue;
      }
      // ③ U+FFFD 替换符扫描（B 类乱码固化）
      const text = bytes.toString('utf8');
      const lineNo = text.split(/\r?\n/).findIndex((l) => l.includes('\uFFFD'));
      if (lineNo >= 0) {
        violations.push(`${p}:${lineNo + 1}: 含 U+FFFD 乱码替换符（注释须人工重写）`);
      }
    }
  }
};
walk(SRC_ROOT);

if (violations.length > 0) {
  console.error('CSS/TS 编码门禁失败：');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('check-css-encoding: 全部文件 UTF-8 无 BOM 且无乱码替换符 ✓');
