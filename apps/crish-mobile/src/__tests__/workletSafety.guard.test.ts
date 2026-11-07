// worklet 安全守卫（2026-11-01 真机崩溃防再发）：
//
// 根因复盘：Sheet.tsx 的 useAnimatedStyle updater 在 worklet（UI 线程）内调用
// Dimensions.get('window')。Dimensions 是 JS 线程的 RN 模块对象，被克隆进
// worklet 运行时后其方法丢失 → 调用抛 TypeError: undefined is not a function，
// 经 worklets runloop 以 CppException 杀死进程（真机 logcat 签名：SheetTsx →
// styleUpdater useAnimatedStyle → mapperRun；登录成功进入主页挂载 Sheet 即崩、
// 已登录态冷启动约 1s 必崩）。jest 的 reanimated 桩不在独立 worklet 运行时
// 执行 updater（且 JS 线程上 Dimensions.get 本就可用），全量测试对此全盲——
// 故在此立静态契约：worklet 函数体内
//   1) 禁止引用 Dimensions.*；
//   2) 禁止调用从 'react-native' 导入对象的成员方法；
//   3) 禁止调用从 reanimated / worklets 以外模块导入的函数或其成员方法。
// 同文件定义的纯函数会被 babel 插件自动 worklet 化（如 SlideToConfirm 的
// slideReleaseDecision、Sheet 的 sheetPanelTranslateY），不在禁列；回调参数
// （event / stateManager 等）与共享值读写亦不在禁列；Math / JSON 等 JS 内置
// 在 worklet 运行时中可用，放行。
// 扫描面：useAnimatedStyle / useAnimatedProps / useDerivedValue /
// useAnimatedReaction / useAnimatedScrollHandler / useFrameCallback 的调用实参、
// 带 'worklet' 指令的函数体、（import gesture-handler 的文件内）手势链式回调。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { sheetPanelTranslateY } from '../presentation/ui/Sheet';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['app', 'src'];

/** 允许在 worklet 内调用的来源模块（其导出均为真 worklet / worklet 安全 API） */
const SAFE_CALLEE_MODULES = new Set([
  'react-native-reanimated',
  'react-native-worklets',
]);
/** worklet 运行时可用的 JS 内置对象（成员调用放行） */
const JS_BUILTIN_OBJECTS = new Set([
  'Math',
  'JSON',
  'Object',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Date',
  'console',
]);
const JS_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'typeof',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'instanceof',
  'await',
  'yield',
  'do',
  'else',
  'try',
  'finally',
  'throw',
  'case',
]);

const HOOK_ENTRY_POINTS = [
  'useAnimatedStyle',
  'useAnimatedProps',
  'useDerivedValue',
  'useAnimatedReaction',
  'useAnimatedScrollHandler',
  'useFrameCallback',
];
const GESTURE_CALLBACKS = [
  'onStart',
  'onUpdate',
  'onEnd',
  'onBegin',
  'onFinalize',
  'onTouchesDown',
  'onTouchesMove',
  'onTouchesUp',
  'onChange',
  'onChanges',
];

function collectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collectFiles(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

/** 带字符串/注释感知的括号配平：返回 open 处开括号的匹配闭括号下标，失败 -1 */
function matchBracket(src: string, openIdx: number): number {
  const open = src[openIdx]!;
  const close = open === '(' ? ')' : open === '{' ? '}' : ']';
  let depth = 0;
  let i = openIdx;
  let inStr: string | null = null;
  let inLine = false;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 2;
      } else i++;
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 解析文件的 import 表：本地标识符 → 来源模块 */
function parseImports(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const clause = m[1]!;
    const mod = m[2]!;
    const trimmed = clause.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('*')) {
      const def = /^\s*([A-Za-z_$][\w$]*)/.exec(clause);
      if (def) map.set(def[1]!, mod);
    }
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) map.set(ns[1]!, mod);
    const named = /\{([\s\S]*?)\}/.exec(clause);
    if (named) {
      for (const part of named[1]!.split(',')) {
        const p = part.trim();
        if (!p) continue;
        const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(p);
        const name = asMatch ? asMatch[1]! : p.replace(/^type\s+/, '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) map.set(name, mod);
      }
    }
  }
  return map;
}

interface Region {
  text: string;
  index: number;
  kind: string;
}

/** 抽取文件中全部 worklet 区域（钩子实参 / 'worklet' 指令体 / 手势回调实参） */
function extractWorkletRegions(src: string): Region[] {
  const regions: Region[] = [];
  const pushCallArgs = (startIdx: number, kind: string) => {
    const parenIdx = src.indexOf('(', startIdx);
    if (parenIdx < 0) return;
    const end = matchBracket(src, parenIdx);
    if (end < 0) return;
    regions.push({ text: src.slice(parenIdx, end + 1), index: startIdx, kind });
  };

  for (const hook of HOOK_ENTRY_POINTS) {
    const re = new RegExp(`\\b${hook}\\s*\\(`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) pushCallArgs(m.index, hook);
  }

  if (src.includes('react-native-gesture-handler')) {
    for (const cb of GESTURE_CALLBACKS) {
      const re = new RegExp(`\\.${cb}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) pushCallArgs(m.index, `gesture:${cb}`);
    }
  }

  // 'worklet' 指令：自指令处反向找最近的未闭合 '{' 作为函数体起点
  const dirRe = /'worklet'\s*;/g;
  let dm: RegExpExecArray | null;
  while ((dm = dirRe.exec(src))) {
    let depth = 0;
    let open = -1;
    for (let i = dm.index - 1; i >= 0; i--) {
      const c = src[i]!;
      if (c === '}') depth++;
      else if (c === '{') {
        if (depth === 0) {
          open = i;
          break;
        }
        depth--;
      }
    }
    if (open < 0) continue;
    const close = matchBracket(src, open);
    if (close < 0) continue;
    regions.push({
      text: src.slice(open, close + 1),
      index: open,
      kind: 'worklet-directive',
    });
  }

  // 去重（同一体被手势扫描与指令扫描重复命中时只报一次）
  const seen = new Set<string>();
  return regions.filter((r) => {
    const key = `${r.index}:${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 在一个 worklet 区域内找违规调用，返回违规描述列表 */
function findViolationsInRegion(
  text: string,
  imports: Map<string, string>
): string[] {
  const out: string[] = [];
  if (/\bDimensions\s*\./.test(text)) {
    out.push(
      'worklet 内引用 Dimensions.*（RN 模块对象在 worklet 运行时方法丢失）'
    );
  }
  const memberRe = /([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(text))) {
    const obj = m[1]!;
    if (JS_BUILTIN_OBJECTS.has(obj)) continue;
    const mod = imports.get(obj);
    if (!mod) continue; // 回调参数 / 局部变量 / 共享值：非导入对象，放行
    if (mod === 'react-native') {
      out.push(`worklet 内调用 'react-native' 导入对象 ${obj}.${m[2]}()`);
    } else if (!SAFE_CALLEE_MODULES.has(mod)) {
      out.push(`worklet 内调用 '${mod}' 导入对象 ${obj}.${m[2]}()`);
    }
  }
  const bareRe = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = bareRe.exec(text))) {
    const fn = m[1]!;
    if (JS_KEYWORDS.has(fn)) continue;
    const mod = imports.get(fn);
    if (mod && !SAFE_CALLEE_MODULES.has(mod)) {
      out.push(`worklet 内调用 '${mod}' 导入函数 ${fn}()`);
    }
  }
  return out;
}

/** 对一整份源码做 worklet 安全扫描（合成样本自检与全仓扫描共用） */
export function findWorkletViolations(src: string): string[] {
  const imports = parseImports(src);
  const out: string[] = [];
  for (const region of extractWorkletRegions(src)) {
    for (const v of findViolationsInRegion(region.text, imports)) {
      out.push(`[${region.kind}] ${v}`);
    }
  }
  return out;
}

/** 顶层实参切分（深度为 0 的逗号分割） */
function splitTopLevelArgs(argsStr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let inLine = false;
  let inBlock = false;
  let start = 0;
  let i = 0;
  while (i < argsStr.length) {
    const c = argsStr[i]!;
    const n = argsStr[i + 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i += 2;
      } else i++;
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inStr = c;
      i++;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      args.push(argsStr.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  if (start < argsStr.length) {
    args.push(argsStr.slice(start).trim());
  }
  return args;
}

const SAFE_ANIMATION_APIS = new Set([
  'runOnJS',
  'runOnUI',
  'cancelAnimation',
  'withTiming',
  'withSpring',
]);

/** 扫描源码中 withTiming / withSpring 的完成回调内是否有裸调用的普通 JS 函数 */
export function findAnimationCallbackViolations(src: string): string[] {
  const violations: string[] = [];
  const animRe = /\b(withTiming|withSpring)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = animRe.exec(src))) {
    const openParen = m.index + m[0].length - 1;
    const closeParen = matchBracket(src, openParen);
    if (closeParen < 0) continue;
    const argsStr = src.slice(openParen + 1, closeParen);
    const args = splitTopLevelArgs(argsStr);
    if (args.length >= 3) {
      const cbArg = args[2]!.trim();
      if (!cbArg || cbArg === 'undefined' || cbArg === 'null') continue;

      // 若直接传入裸标识符函数（未用 runOnJS 包装）
      if (/^[A-Za-z_$][\w$]*$/.test(cbArg)) {
        if (!SAFE_ANIMATION_APIS.has(cbArg) && !JS_BUILTIN_OBJECTS.has(cbArg)) {
          violations.push(
            `[${m[1]}] 动画完成回调直接传入了未包裹 runOnJS 的函数 ${cbArg}`
          );
        }
        continue;
      }

      // 提取函数体内容
      let body = cbArg;
      const braceOpen = cbArg.indexOf('{');
      if (braceOpen >= 0) {
        const braceClose = matchBracket(cbArg, braceOpen);
        if (braceClose > braceOpen) {
          body = cbArg.slice(braceOpen + 1, braceClose);
        }
      } else {
        const arrowIdx = cbArg.indexOf('=>');
        if (arrowIdx >= 0) {
          body = cbArg.slice(arrowIdx + 2);
        }
      }

      // 脱敏注释与字符串字面量
      let masked = '';
      let i = 0;
      let inStr: string | null = null;
      let inLine = false;
      let inBlock = false;
      while (i < body.length) {
        const c = body[i]!;
        const n = body[i + 1];
        if (inLine) {
          masked += ' ';
          if (c === '\n') inLine = false;
          i++;
          continue;
        }
        if (inBlock) {
          masked += ' ';
          if (c === '*' && n === '/') {
            masked += ' ';
            inBlock = false;
            i += 2;
          } else i++;
          continue;
        }
        if (inStr) {
          masked += ' ';
          if (c === '\\') {
            masked += ' ';
            i += 2;
            continue;
          }
          if (c === inStr) inStr = null;
          i++;
          continue;
        }
        if (c === '/' && n === '/') {
          inLine = true;
          masked += '  ';
          i += 2;
          continue;
        }
        if (c === '/' && n === '*') {
          inBlock = true;
          masked += '  ';
          i += 2;
          continue;
        }
        if (c === "'" || c === '"' || c === '`') {
          inStr = c;
          masked += ' ';
          i++;
          continue;
        }
        masked += c;
        i++;
      }

      // 脱敏所有 runOnJS(...) 结构及其立即调用 runOnJS(...)(...)
      const runRe = /\brunOnJS\s*\(/g;
      let rm: RegExpExecArray | null;
      while ((rm = runRe.exec(masked))) {
        const rOpen = rm.index + rm[0].length - 1;
        const rClose = matchBracket(masked, rOpen);
        if (rClose > rOpen) {
          let end = rClose + 1;
          const rest = masked.slice(end);
          const callMatch = rest.match(/^\s*\(/);
          if (callMatch) {
            const secondOpen = end + callMatch[0].length - 1;
            const secondClose = matchBracket(masked, secondOpen);
            if (secondClose > secondOpen) end = secondClose + 1;
          }
          masked =
            masked.slice(0, rm.index) +
            ' '.repeat(end - rm.index) +
            masked.slice(end);
          runRe.lastIndex = rm.index;
        }
      }

      // 检查剩余部分中是否存在函数裸调用
      const callRe = /(?<![\w$.])([A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(masked))) {
        const fullFn = cm[1]!;
        const base = fullFn.split('.')[0]!;
        if (
          JS_KEYWORDS.has(base) ||
          JS_BUILTIN_OBJECTS.has(base) ||
          SAFE_ANIMATION_APIS.has(base)
        ) {
          continue;
        }
        violations.push(
          `[${m[1]}] 动画完成回调内直接裸调用了未包裹 runOnJS 的函数 ${fullFn}()`
        );
      }
    }
  }
  return violations;
}

describe('worklet 安全守卫 · 扫描器自检（证明能拦住本次肇事模式）', () => {
  it('肇事样本：updater 内 Dimensions.get 被拦', () => {
    const bad = `
      import { Dimensions } from 'react-native';
      import { useAnimatedStyle } from 'react-native-reanimated';
      export function Demo() {
        const s = useAnimatedStyle(() => ({
          transform: [{ translateY: Dimensions.get('window').height }],
        }));
        return s;
      }
    `;
    expect(findWorkletViolations(bad).length).toBeGreaterThan(0);
  });

  it('同类样本：updater 内调用领域纯函数（跨模块导入）被拦', () => {
    const bad = `
      import { useAnimatedStyle } from 'react-native-reanimated';
      import { formatRelativeTime } from '@/domain/pure/time';
      export function Demo() {
        return useAnimatedStyle(() => ({
          opacity: formatRelativeTime(1) ? 1 : 0,
        }));
      }
    `;
    expect(findWorkletViolations(bad).length).toBeGreaterThan(0);
  });

  it('合法样本：reanimated API + 纯数字捕获 + 同文件 worklet 函数放行', () => {
    const good = `
      import { useWindowDimensions } from 'react-native';
      import { interpolate, useAnimatedStyle } from 'react-native-reanimated';
      export function sheetPanelTranslateY(p: number, h: number, w: number): number {
        'worklet';
        return (1 - p) * (h > 0 ? h : w);
      }
      export function Demo() {
        const { height } = useWindowDimensions();
        return useAnimatedStyle(() => ({
          opacity: interpolate(1, [0, 1], [0, 1]),
          transform: [{ translateY: sheetPanelTranslateY(0, 0, height) }],
        }));
      }
    `;
    expect(findWorkletViolations(good)).toEqual([]);
  });

  it('动画回调肇事样本：withTiming 完成回调内裸调用 handleExitFinished 被拦', () => {
    const bad = `
      panelProgress.value = withTiming(
        0,
        { duration: 250 },
        (finished) => {
          if (finished) handleExitFinished();
        }
      );
    `;
    const violations = findAnimationCallbackViolations(bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('handleExitFinished');
  });

  it('动画回调违规样本：withSpring 完成回调内裸调用外部函数被拦', () => {
    const bad = `
      panelProgress.value = withSpring(
        0,
        { damping: 15 },
        (finished) => {
          if (finished) notifyClose();
        }
      );
    `;
    const violations = findAnimationCallbackViolations(bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toContain('notifyClose');
  });

  it('动画回调合法样本：withTiming 完成回调内使用 runOnJS 包裹放行', () => {
    const good = `
      panelProgress.value = withTiming(
        0,
        { duration: 250 },
        (finished) => {
          if (finished) runOnJS(handleExitFinished)();
        }
      );
    `;
    expect(findAnimationCallbackViolations(good)).toEqual([]);
  });

  it('动画回调合法样本：withTiming 完成回调内仅更新 SharedValue 与 Math 放行', () => {
    const good = `
      panelProgress.value = withTiming(
        1,
        { duration: 280 },
        (finished) => {
          if (finished) {
            baselineHeight.value = Math.max(0, panelHeight);
          }
        }
      );
    `;
    expect(findAnimationCallbackViolations(good)).toEqual([]);
  });
});

describe('worklet 安全守卫 · 全仓扫描', () => {
  it('app/ 与 src/ 全部 worklet 区域无违规调用', () => {
    const problems: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectFiles(join(ROOT, dir))) {
        const src = readFileSync(file, 'utf8');
        const violations = findWorkletViolations(src);
        if (violations.length > 0) {
          const rel = relative(ROOT, file).split(sep).join('/');
          for (const v of violations) problems.push(`${rel}: ${v}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('app/ 与 src/ 中 withTiming / withSpring 动画完成回调内禁止裸调用普通 JS 函数', () => {
    const problems: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of collectFiles(join(ROOT, dir))) {
        const src = readFileSync(file, 'utf8');
        const violations = findAnimationCallbackViolations(src);
        if (violations.length > 0) {
          const rel = relative(ROOT, file).split(sep).join('/');
          for (const v of violations) problems.push(`${rel}: ${v}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('sheetPanelTranslateY（Sheet 面板位移纯函数）', () => {
  it('未测得面板高度时以窗口高度兜底（首帧整块藏于屏外）', () => {
    expect(sheetPanelTranslateY(0, 0, 800)).toBe(800);
    expect(sheetPanelTranslateY(0.5, 0, 800)).toBe(400);
  });
  it('测得面板高度后按面板高度位移', () => {
    expect(sheetPanelTranslateY(0, 240, 800)).toBe(240);
    expect(sheetPanelTranslateY(0.25, 240, 800)).toBe(180);
  });
  it('展开完成位移归零', () => {
    expect(sheetPanelTranslateY(1, 240, 800)).toBe(0);
    expect(sheetPanelTranslateY(1, 0, 800)).toBe(0);
  });
});
