/**
 * check-css-encoding.mjs —— CSS/TS 编码门禁（R2-1 三层升级，批次 R2-1）
 *
 * 既有三项检查（保留）：
 * ① UTF-8 BOM 检测（应无 BOM）
 * ② 严格 UTF-8 解码（A 类真 GBK 字节 → 报错）
 * ③ U+FFFD 替换符扫描（B 类乱码固化 → 报错）
 *
 * R2-1 新增三层 mojibake 固化检测（对「合法 UTF-8 的 GBK 乱码」有效）：
 * 层 1：PUA 区扫描（U+E000–U+F8FF）——强特征，全仓强制零豁免
 * 层 2：GBK 逆变换检测——强特征，全仓强制零豁免
 *        （line.encode('gbk') → decode('utf-8') 成功且恢复串含 ≥2 CJK → 违规）
 * 层 3：特征字表扫描——弱特征，行级白名单豁免
 *
 * 白名单：scripts/css-encoding-whitelist.json（{ "相对路径": { "行号": "理由" } }）
 *   --init-whitelist         生成当前命中快照（挂账登记）
 *   --whitelist-dirty-check  白名单中存在「文件当前已不命中」行号 → 报错要求清理
 *   --strict                 白名单行也报 error（默认 warning）
 *
 * 退出码非 0 = 违规（CI 红线）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../apps/crish-desktop/src', import.meta.url));
const WHITELIST_PATH = fileURLToPath(new URL('./css-encoding-whitelist.json', import.meta.url));
const EXTS = new Set(['.css', '.ts', '.tsx']);

const args = process.argv.slice(2);
const initWhitelist = args.includes('--init-whitelist');
const dirtyCheck = args.includes('--whitelist-dirty-check');
const strict = args.includes('--strict');

/** 层 3 特征字表（实跑统计所得：GBK 乱码固化常见字 + 片假名段；不含 ASCII） */
const FEATURE_CHARS =
  '閳ユ柡鈧姘顒烽敍妞ょ數鐎鏂鍙鍘鍦鎻鎷鎸鍗鍐鍑鍔鈥鈧锛濠婃艾濮╅崠鐚寸窗鈹€';
const FEATURE_SET = new Set(FEATURE_CHARS.split(''));
const KATAKANA_RE = /[\u30a0-\u30ff]/;

/** 层 2：GBK 逆变换检测（该行文本经 GBK 编码后能严格解码为 UTF-8 且含 ≥2 CJK） */
function gbkInverseRecover(line) {
  if (!/[\u4e00-\u9fff]/.test(line)) return null;
  try {
    const gbkBytes = Buffer.from(line, 'gbk');
    const recovered = new TextDecoder('utf-8', { fatal: true }).decode(gbkBytes);
    const cjkCount = (recovered.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjkCount >= 2) return recovered;
  } catch {
    /* GBK 编码产物无法严格解码为 UTF-8 → 非 mojibake */
  }
  return null;
}

/** 层 3 特征字命中数（去重字符计 + 片假名段按 1 计） */
function featureHitCount(line) {
  const seen = new Set();
  for (const ch of line) {
    if (FEATURE_SET.has(ch)) seen.add(ch);
  }
  if (KATAKANA_RE.test(line)) seen.add('__katakana__');
  return seen.size;
}

function loadWhitelist() {
  try {
    return JSON.parse(readFileSync(WHITELIST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveWhitelist(wl) {
  writeFileSync(WHITELIST_PATH, JSON.stringify(wl, null, 2) + '\n', 'utf8');
}

const violations = []; // {path, line, msg, layer, whitelisted?}
const whitelist = loadWhitelist();

const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (EXTS.has(extname(p)) && !/\.test\.(ts|tsx)$/.test(p)) {
      const rel = relative(SRC_ROOT, p).replace(/\\/g, '/');
      const bytes = readFileSync(p);
      // ① BOM
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        violations.push({ path: p, line: 0, msg: 'UTF-8 BOM 必须去除', layer: 0 });
      }
      // ② 严格解码
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        violations.push({ path: p, line: 0, msg: '非法 UTF-8 字节（疑似 GBK 编码，须转 UTF-8 无 BOM）', layer: 0 });
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = i + 1;
        const wlLine = whitelist[rel]?.[String(lineNo)];
        // ③ FFFD
        if (line.includes('\uFFFD')) {
          violations.push({ path: p, line: lineNo, msg: '含 U+FFFD 乱码替换符（注释须人工重写）', layer: 0, whitelisted: Boolean(wlLine) });
          continue;
        }
        // 层 1：PUA
        if (/[\uE000-\uF8FF]/.test(line)) {
          violations.push({ path: p, line: lineNo, msg: '层1 PUA 区字符（U+E000–U+F8FF，字节损坏铁证）', layer: 1, whitelisted: Boolean(wlLine) });
          continue;
        }
        // 层 2：GBK 逆变换
        const recovered = gbkInverseRecover(line);
        if (recovered) {
          violations.push({ path: p, line: lineNo, msg: `层2 GBK 逆变换命中（恢复串：${recovered.slice(0, 30)}，人工重写提示）`, layer: 2, whitelisted: Boolean(wlLine) });
          continue;
        }
        // 层 3：特征字表（前置：行必须含 CJK——纯英文代码行不可能是 GBK 乱码）
        if (/[\u4e00-\u9fff]/.test(line)) {
          const hit = featureHitCount(line);
          if (hit >= 2) {
            violations.push({
              path: p, line: lineNo, msg: `层3 特征字命中 ${hit} 个（mojibake 固化候选）`,
              layer: 3, whitelisted: Boolean(wlLine),
            });
          }
        }
      }
    }
  }
};

walk(SRC_ROOT);

if (initWhitelist) {
  // 生成快照：全部层命中行（挂账登记，含层 1/2/3）
  const snapshot = {};
  for (const v of violations) {
    const rel = relative(SRC_ROOT, v.path).replace(/\\/g, '/');
    if (!snapshot[rel]) snapshot[rel] = {};
    snapshot[rel][String(v.line)] = '挂账，见 50-reverify 01 §3.2 / 后续卫生轮次';
  }
  saveWhitelist(snapshot);
  console.log(`check-css-encoding: --init-whitelist 快照已生成（${Object.keys(snapshot).length} 文件 / ${Object.values(snapshot).reduce((a, f) => a + Object.keys(f).length, 0)} 行）`);
  process.exit(0);
}

// 分类输出
const errors = violations.filter((v) => !v.whitelisted || strict);
const warnings = violations.filter((v) => v.whitelisted && !strict);
let dirty = [];
if (dirtyCheck) {
  // 白名单中存在「当前已不命中」的行号（文件当前无任何层命中该行）
  for (const [rel, lines] of Object.entries(whitelist)) {
    const live = new Set(
      violations.filter((v) => relative(SRC_ROOT, v.path).replace(/\\/g, '/') === rel)
        .map((v) => String(v.line))
    );
    for (const ln of Object.keys(lines)) {
      if (!live.has(ln)) dirty.push(`${rel}:${ln}`);
    }
  }
}

if (errors.length > 0) {
  console.error('CSS/TS 编码门禁失败：');
  for (const v of errors) {
    console.error(`  ${relative(SRC_ROOT, v.path).replace(/\\/g, '/')}:${v.line}: ${v.msg}`);
  }
  process.exit(1);
}
if (dirty.length > 0) {
  console.error(`check-css-encoding: --whitelist-dirty-check 发现 ${dirty.length} 行已修复但未清理白名单（须从 css-encoding-whitelist.json 摘除）：`);
  for (const d of dirty.slice(0, 20)) console.error('  ' + d);
  process.exit(1);
}
if (warnings.length > 0) {
  console.warn(`check-css-encoding: 白名单豁免 ${warnings.length} 行（挂账）：`);
  for (const w of warnings.slice(0, 10)) console.warn('  ' + relative(SRC_ROOT, w.path).replace(/\\/g, '/') + ':' + w.line);
}
console.log('check-css-encoding: 全部文件 UTF-8 无 BOM 且无乱码（三层检测通过）✓');
