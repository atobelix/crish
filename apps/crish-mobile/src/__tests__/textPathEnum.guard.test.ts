/**
 * TextPath 枚举守卫（2026-11-05 波 7c-S 新增）：钉住 RNSVG `<TextPath>`
 * 的枚举属性永远落在原生合法集内，防签名 S 复发——
 *
 * 事故链（I 文档 §2.1b 签名 S）：上一版包 3 小时内多次
 * `IllegalArgumentException: No enum constant
 * TextProperties.TextPathMethod.central` 渲染崩溃。根源是给
 * TextPath 传了原生不认识的枚举值（alignmentBaseline="central"
 * 一类），JS 层无任何校验即直达原生 valueOf 抛错。
 *
 * 守卫规则（合法集以仓内 node_modules 的 react-native-svg 原生
 * TextProperties.java 枚举为准写死：TextPathMethod / TextPathSide /
 * TextPathMidLine / TextPathSpacing）：
 * 1. TextPath 上禁止出现 alignmentBaseline 属性（任何取值）——
 *    基线居中由轨迹几何承担（startOffset="50%" + textAnchor），
 *    该属性正是本事故的输入面；
 * 2. method ∈ {align, stretch}、side ∈ {left, right}、
 *    midLine ∈ {sharp, smooth}、spacing ∈ {auto, exact}；
 * 3. 上述枚举属性必须写成字符串字面量（或 {'字面量'}），表达式
 *    取值无法静态核对，一律判违规。
 *
 * 扫描面：app/ + src/ 的 .ts/.tsx（跳过测试文件）与 assets/ 下的
 * .svg 图标资源（<textPath> 小写形态同样受管）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(__dirname, '..', '..');

/** TextPath 枚举属性 → 原生合法集（RNSVG TextProperties.java） */
const TEXTPATH_ENUM_PROPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['method', new Set(['align', 'stretch'])],
  ['side', new Set(['left', 'right'])],
  ['midLine', new Set(['sharp', 'smooth'])],
  ['spacing', new Set(['auto', 'exact'])],
]);

/** TextPath 上明令禁止的属性（事故输入面，不看取值） */
const TEXTPATH_FORBIDDEN_PROPS: readonly string[] = ['alignmentBaseline'];

/**
 * 从源码中提取 `<TextPath` 的开标签全文本（字符串/括号感知：
 * 属性表达式内的 `>` 不算标签结束）。
 */
export function extractTextPathTags(src: string, tagName = '<TextPath'): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(tagName, from);
    if (start < 0) break;
    const next = src[start + tagName.length];
    if (next !== undefined && !/[\s/>]/.test(next)) {
      from = start + tagName.length;
      continue;
    }
    let i = start + tagName.length;
    let depth = 0;
    let inStr: string | null = null;
    while (i < src.length) {
      const c = src[i]!;
      if (inStr) {
        if (c === '\\') i++;
        else if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === '`') {
        inStr = c;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
      } else if (c === '>' && depth === 0) {
        break;
      }
      i++;
    }
    tags.push(src.slice(start, i + 1));
    from = i + 1;
  }
  return tags;
}

/**
 * 检查一个 TextPath 开标签，返回违规明细（空数组 = 合规）。
 * tag 为开标签全文（如 `<TextPath href="#x" method="align">`）。
 */
export function findTextPathTagViolations(tag: string): string[] {
  const violations: string[] = [];
  for (const prop of TEXTPATH_FORBIDDEN_PROPS) {
    if (new RegExp(`\\b${prop}\\s*=`).test(tag)) {
      violations.push(`禁止属性 ${prop}（签名 S 事故输入面）`);
    }
  }
  for (const [prop, legal] of TEXTPATH_ENUM_PROPS) {
    const m = new RegExp(
      `\\b${prop}\\s*=\\s*("([^"]*)"|'([^']*)'|\\{([\\s\\S]*?)\\})`
    ).exec(tag);
    if (!m) continue;
    const literal = m[2] ?? m[3];
    if (literal !== undefined) {
      if (!legal.has(literal)) {
        violations.push(
          `${prop}="${literal}" 不在原生合法集 {${[...legal].join(', ')}} 内`
        );
      }
      continue;
    }
    // {表达式} 形态：仅当内容恰为字符串字面量时按字面量核对
    const inner = (m[4] ?? '').trim();
    const innerLiteral = /^"([^"]*)"$/.exec(inner) ?? /^'([^']*)'$/.exec(inner);
    if (innerLiteral) {
      if (!legal.has(innerLiteral[1]!)) {
        violations.push(
          `${prop}={${inner}} 不在原生合法集 {${[...legal].join(', ')}} 内`
        );
      }
    } else {
      violations.push(`${prop} 使用表达式取值，无法静态核对原生合法集`);
    }
  }
  return violations;
}

function collectFiles(dir: string, exts: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collectFiles(full, exts);
    if (!exts.test(name)) return [];
    if (/\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

interface ScanHit {
  file: string;
  violations: string[];
}

function scanTree(): { usageCount: number; hits: ScanHit[] } {
  let usageCount = 0;
  const hits: ScanHit[] = [];
  const surfaces: { dir: string; exts: RegExp; tagName: string }[] = [
    { dir: 'app', exts: /\.(ts|tsx)$/, tagName: '<TextPath' },
    { dir: 'src', exts: /\.(ts|tsx)$/, tagName: '<TextPath' },
    { dir: 'assets', exts: /\.svg$/, tagName: '<textPath' },
  ];
  for (const { dir, exts, tagName } of surfaces) {
    for (const file of collectFiles(join(ROOT, dir), exts)) {
      const src = readFileSync(file, 'utf8');
      const tags = extractTextPathTags(src, tagName);
      usageCount += tags.length;
      for (const tag of tags) {
        const violations = findTextPathTagViolations(tag);
        if (violations.length > 0) {
          hits.push({
            file: relative(ROOT, file).split(sep).join('/'),
            violations,
          });
        }
      }
    }
  }
  return { usageCount, hits };
}

describe('TextPath 枚举守卫（签名 S 防再发）', () => {
  it('检测器自检：合规形态放行', () => {
    expect(
      findTextPathTagViolations(
        '<TextPath href="#a" startOffset="50%" textAnchor="middle">'
      )
    ).toEqual([]);
    expect(
      findTextPathTagViolations('<TextPath href="#a" method="align" side="left">')
    ).toEqual([]);
    expect(
      findTextPathTagViolations("<TextPath href=\"#a\" method={'stretch'}>")
    ).toEqual([]);
  });

  it('检测器自检：事故形态与越界值必红', () => {
    // 本事故的原始输入：alignmentBaseline="central"
    expect(
      findTextPathTagViolations(
        '<TextPath href="#a" alignmentBaseline="central">'
      ).length
    ).toBeGreaterThan(0);
    // method 越界（原生 TextPathMethod 只有 align/stretch）
    expect(
      findTextPathTagViolations('<TextPath href="#a" method="central">').length
    ).toBeGreaterThan(0);
    // 表达式取值无法静态核对
    expect(
      findTextPathTagViolations('<TextPath href="#a" method={someVar}>').length
    ).toBeGreaterThan(0);
  });

  it('全仓 TextPath 用法全部落在原生合法集内', () => {
    const { usageCount, hits } = scanTree();
    // 防空转：当前已知使用面（VoiceOverlay 两处弧形胶囊）必须被扫到；
    // 使用面整体移除时本断言会红，届时请同步更新本守卫的扫描预期。
    expect(usageCount).toBeGreaterThanOrEqual(1);
    expect(
      hits.map((h) => `${h.file}: ${h.violations.join('；')}`)
    ).toEqual([]);
  });
});
