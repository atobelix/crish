// 动效 token 单源守卫（批 A，2026-11-03；核查 ㉞ 的门化落地）：
// 移动端一切动画时长/弹簧只许消费 theme.motion 单源（adapters/platform/
// theme.ts）。Cherry 深比的总判断是 Crish 的「乱」来自口径靠人肉批次
// 收敛、无机器守卫——本守卫把下列再犯形态钉成红：
//   1) withTiming / Animated.timing 的配置里出现数字字面量 duration；
//   2) entering/exiting 等 builder 的 .duration(数字) 字面量；
//   3) withSpring 配置里出现数字字面量 damping/stiffness/mass；
//   4) motion 消费点写数字 fallback（motion.xxx ?? 120 / || 120）——
//      fallback 值与正典漂移是核查 ⑥ 在桌面侧实锤的系统性病灶，移动端
//      同罪同判：token 字段均为必填，兜底没有合法存在理由；
//   5) duration 直收大写常量（本地藏值常量的绕行形态，如原 Toast 的
//      ANIM_MS）——时长必须当场来自 theme.motion 表达式。
// 扫描面：app/ + src/ 全部非测试源码；定义单源 theme.ts 本人豁免。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['app', 'src'];

/** 定义单源豁免（文件相对 crish-mobile 根） */
const ALLOWLIST: Record<string, string> = {
  // 动效 token 的定义单源本人
  'src/adapters/platform/theme.ts': 'theme.motion 定义单源',
  // WebView 渲染库生成物（批 E，2026-11-03)：katex / mermaid 官方 dist
  // 产物的字节内嵌字符串（内含 d3 自有 duration 词面），非本仓动效消费
  // 面；来源与版本钉版见各文件头与 scripts/generate-webview-libs.mjs
  'src/presentation/components/blocks/webview/generated/katex.ts':
    'WebView 库生成物',
  'src/presentation/components/blocks/webview/generated/mermaid.ts':
    'WebView 库生成物',
};

// 规则 5 的单独豁免：RUNNING_PULSE_PERIOD_MS 是导出的命名正典常量
// （S4 脉冲 1600ms，具名单源、非藏值），档位归属留待移动收口裁定
const RULE5_EXEMPT = 'src/presentation/components/status/RunningPulseDot.tsx';

function collect(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collect(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

/** 去注释行（与 styleTokens 守卫同法），避免文档里的数值被误判 */
function codeOnly(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((text) => !/^\s*(\/\/|\*|\/\*)/.test(text))
    .join('\n');
}

/**
 * 调用点窗口扫描：从每个 callSite 标记处取后续窗口文本，在窗口内
 * （遇 ';' 即止）找字面量配置——动画调用的配置对象在本仓排版下恒为
 * 紧凑形态，窗口法足够且不易误伤无关代码。
 */
function callWindows(
  source: string,
  marker: RegExp,
  windowSize = 260
): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(marker)) {
    const start = match.index ?? 0;
    const slice = source.slice(start, start + windowSize);
    const end = slice.indexOf(';');
    out.push(end >= 0 ? slice.slice(0, end) : slice);
  }
  return out;
}

const TIMING_MARKER = /\bwithTiming\(|Animated\.timing\(/g;
const SPRING_MARKER = /\bwithSpring\(/g;

describe('动效 token 单源守卫（批 A）', () => {
  const files = SCAN_DIRS.flatMap((dir) => collect(join(ROOT, dir))).map(
    (full) => ({
      full,
      rel: relative(ROOT, full).split(sep).join('/'),
      code: codeOnly(readFileSync(full, 'utf8')),
    })
  );

  it('扫描范围非空', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('withTiming / Animated.timing 不许字面量 duration', () => {
    const hits = files
      .filter(({ rel }) => !(rel in ALLOWLIST))
      .flatMap(({ rel, code }) =>
        callWindows(code, TIMING_MARKER)
          .filter((w) => /duration:\s*\d/.test(w))
          .map((w) => `${rel}: ${w.replace(/\s+/g, ' ').slice(0, 90)}`)
      );
    expect(hits).toEqual([]);
  });

  it('builder .duration() 不许字面量', () => {
    const hits = files
      .filter(({ rel }) => !(rel in ALLOWLIST))
      .flatMap(({ rel, code }) => {
        const found: string[] = [];
        for (const m of code.matchAll(/\.duration\(\s*\d/g)) {
          found.push(
            `${rel}: …${code.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 20).replace(/\s+/g, ' ')}`
          );
        }
        return found;
      });
    expect(hits).toEqual([]);
  });

  it('withSpring 不许字面量弹簧参数', () => {
    const hits = files
      .filter(({ rel }) => !(rel in ALLOWLIST))
      .flatMap(({ rel, code }) =>
        callWindows(code, SPRING_MARKER)
          .filter((w) => /(damping|stiffness|mass):\s*\d/.test(w))
          .map((w) => `${rel}: ${w.replace(/\s+/g, ' ').slice(0, 90)}`)
      );
    expect(hits).toEqual([]);
  });

  it('motion 消费不许数字 fallback', () => {
    const hits = files
      .filter(({ rel }) => !(rel in ALLOWLIST))
      .flatMap(({ rel, code }) => {
        const found: string[] = [];
        for (const m of code.matchAll(
          /\.motion\.[a-zA-Z0-9_.]+\s*(?:\?\?|\|\|)\s*\d/g
        )) {
          found.push(`${rel}: ${m[0]}`);
        }
        return found;
      });
    expect(hits).toEqual([]);
  });

  it('duration 不许直收大写藏值常量', () => {
    const hits = files
      .filter(({ rel }) => rel !== RULE5_EXEMPT && !(rel in ALLOWLIST))
      .flatMap(({ rel, code }) => {
        const found: string[] = [];
        for (const m of code.matchAll(/duration:\s*[A-Z][A-Z0-9_]{2,}\b/g)) {
          found.push(`${rel}: ${m[0]}`);
        }
        return found;
      });
    expect(hits).toEqual([]);
  });

  it('白名单里的文件都还存在（清理后须同步移除）', () => {
    const existing = new Set(files.map(({ rel }) => rel));
    const stale = Object.keys(ALLOWLIST).filter((rel) => !existing.has(rel));
    expect(stale).toEqual([]);
  });
});
