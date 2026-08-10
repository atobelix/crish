/**
 * check-chunk-cycles.mjs —— 生产构建 chunk 依赖环检测（R2-4 C1）。
 *
 * 背景（02-performance-fixes 序 4）：manualChunks 手写函数特有的风险——
 * 源码模块级无环（depcruise 门禁），但模块被分入不同手动 chunk 后可能
 * 产生 chunk 级循环引用（运行期模块初始化顺序依赖错误），构建器未必
 * 告警，只有运行期冒烟可暴露。本脚本在构建产物上做静态环检测。
 *
 * 用法：node scripts/check-chunk-cycles.mjs [dist 目录（默认 apps/crish-desktop/dist）]
 * 退出码 0 = 无环；1 = 存在环（输出环路径）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const distDir = process.argv[2] ?? new URL('../apps/crish-desktop/dist', import.meta.url).pathname;
if (!existsSync(distDir)) {
  console.error(`check-chunk-cycles: dist 目录不存在（${distDir}）——先运行 build:desktop`);
  process.exit(1);
}

const assetsDir = join(distDir, 'assets');
if (!existsSync(assetsDir)) {
  console.error('check-chunk-cycles: dist/assets 不存在');
  process.exit(1);
}

const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const graph = new Map(); // chunk -> Set<chunk>

for (const f of jsFiles) {
  const content = readFileSync(join(assetsDir, f), 'utf8');
  const deps = new Set();
  // es2022 输出：静态 import "./x.js" / import("./x.js") 保留字面量
  const re = /(?:from|import)\s*\(\s*["']\.\/([A-Za-z0-9_.-]+\.js)["']\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    deps.add(m[1]);
  }
  graph.set(f, deps);
}

// 检测环（DFS + 三色标记）
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map();
const stack = [];
const cycles = [];

function dfs(node, path) {
  color.set(node, GRAY);
  stack.push(node);
  for (const dep of graph.get(node) || []) {
    const c = color.get(dep) ?? WHITE;
    if (c === GRAY) {
      // 找到环：从 dep 到 node 的路径 + dep
      const start = stack.indexOf(dep);
      cycles.push([...stack.slice(start), dep]);
    } else if (c === WHITE) {
      dfs(dep, path);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}

for (const node of graph.keys()) {
  if ((color.get(node) ?? WHITE) === WHITE) dfs(node, []);
}

if (cycles.length > 0) {
  console.error(`check-chunk-cycles: 发现 ${cycles.length} 个 chunk 依赖环：`);
  for (const cyc of cycles) console.error('  ' + cyc.join(' → '));
  process.exit(1);
}
console.log(`check-chunk-cycles: ${graph.size} 个 chunk 无依赖环 ✓`);
