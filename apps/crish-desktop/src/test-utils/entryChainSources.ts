/**
 * 前端入口链源码读取工具（测试专用）。
 *
 * ## 为何需要
 *
 * 物理入口链为 `index.html → main.tsx → entry-core.tsx`。
 * 自 ACT-301「单拍装配」起，`main.tsx` 已收敛为 7 行转发器（消除四阶动态
 * import 瀑布），真实装配全部落在 `entry-core.tsx`：
 *
 * - `registerBuiltInViews(builtinViewFactories)`（entry-core.tsx:73）
 * - 官方扩展激活 `activateNotePaper()` / `activateConversationFlow()`（:76-81）
 *
 * 因此任何「启动期装配顺序 / 装配面不得深引扩展内部」的守卫，都必须扫**整条入口链**；
 * 只读 `main.tsx` 会得到空源码 ⇒ 断言全部失效（假红或假绿）。
 * 本模块是该读取口径的单一真源，禁止各测试文件自行拼路径。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

/** `apps/crish-desktop/src` 绝对路径 */
export const DESKTOP_SRC_DIR = resolve(HERE, '..');

/**
 * 入口链文件（相对 DESKTOP_SRC_DIR，按求值顺序）。
 * 新增装配层时在此追加，所有入口守卫自动覆盖。
 */
export const ENTRY_CHAIN_FILES = ['main.tsx', 'entry-core.tsx'] as const;

/** 入口链各文件的绝对路径（按求值顺序） */
export function entryChainPaths(): string[] {
  return ENTRY_CHAIN_FILES.map((f) => join(DESKTOP_SRC_DIR, f));
}

/**
 * 读取入口链全部源码并按求值顺序拼接。
 * 拼接后做 `indexOf` 顺序比较即等价于「真实求值顺序比较」（前置文件的
 * 装配语句索引必然小于后置文件）——前提是同一符号只出现在一个文件里。
 */
export function readEntryChainSource(): string {
  return ENTRY_CHAIN_FILES.map((f) =>
    readFileSync(join(DESKTOP_SRC_DIR, f), 'utf8')
  ).join('\n');
}
