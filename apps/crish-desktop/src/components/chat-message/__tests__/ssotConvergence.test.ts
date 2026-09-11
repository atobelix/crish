/**
 * apps/crish-desktop/src/components/chat-message/__tests__/ssotConvergence.test.ts
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 正文交错过程折叠战役 · SSOT 收敛负向断言（零残留扫描）
 *
 * 【存在意义】
 *   依据交付与闭环验收准则第 2 条「负向断言物证」：
 *   自动化测试中必须包含断言 **旧字段、旧方法、旧类名已被彻底根除** 的负向用例。
 *   本文件即该物证——它不验证「新功能可用」，而是验证「旧轨道确实死了」。
 *
 * 【红线遵循】
 *   ① 严禁多轨并存与给旧岛续命 → 旧实现必须物理删除，而非注释/隐藏/Shim；
 *   ② 严禁功能伪连通 → 真实宿主调用链必须指向新 SSOT；
 *   ③ 严禁虚构 Token → CSS 不得出现裸 Hex 与伪变量。
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', '..');

/** 递归收集源码文件（ts/tsx/css），排除测试文件自身 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
      continue;
    }
    const isTest = /\.test\.(ts|tsx)$/.test(name);
    if (!isTest && /\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

const ALL_SOURCES = collectSourceFiles(SRC);

function readAllFiles(): Array<{ file: string; src: string }> {
  return ALL_SOURCES.map((file) => ({ file, src: readFileSync(file, 'utf8') }));
}

describe('SSOT 收敛 · 负向断言（旧字段 / 旧方法 / 旧类名零残留）', () => {
  describe('一、已物理删除的模块必须不存在', () => {
    const DELETED_MODULES = [
      'components/chat-message/TurnProcessNodeView.tsx',
      'components/chat-message/turnProcessState.ts',
      'components/chat-message-row/TimelineThoughtSection.tsx',
      'components/chat-message-row/TimelineThoughtSection.module.css',
      'components/chat-message-row/ThinkingTimer.tsx',
      'components/chat-message/TimelineThoughtSection.tsx',
    ];

    it.each(DELETED_MODULES)('模块已物理切除：%s', (rel) => {
      expect(existsSync(join(SRC, rel))).toBe(false);
    });
  });

  describe('二、已物理删除的旧方法名在源码中零出现', () => {
    const DEAD_SYMBOLS = [
      'countProcessMetrics',
      'deriveTurnProcessState',
      'isToolOnlyTerminalTurn',
      'TurnProcessNodeView',
      'TimelineThoughtSection',
      'ThinkingTimer',
      'formatAggregatedSummaryText',
      'arbitrateDominantCategory',
      'formatSummaryLabel',
    ];

    /** 同「三」：剥离注释/字符串，只判定真实代码标识符残留 */
    function stripCommentsAndStrings(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    }

    it.each(DEAD_SYMBOLS)('旧符号已根除（忽略注释/字符串）：%s', (symbol) => {
      const hits = readAllFiles()
        .filter(({ src }) => stripCommentsAndStrings(src).includes(symbol))
        .map((h) => h.file);
      expect(hits, `残留文件：${hits.join(', ')}`).toEqual([]);
    });
  });

  describe('三、已收敛的旧字段名在源码中零出现', () => {
    const DEAD_FIELDS = [
      'ProcessSectionMetrics',
      'dominantCategory',
      'shellCommandCount',
      'editedFilePaths',
      'readFilePaths',
      'dominantIcon',
      'DominantIconSpec',
      'sectionKey',
    ];

    /**
     * 剥离注释与字符串字面量后再扫描。
     * 收敛说明注释（如「历史别名 X 已物理废除」）是**合法的版本记录**，
     * 不属于「旧轨残活」——真正要禁止的是旧字段仍作为**代码标识符**被引用。
     */
    function stripCommentsAndStrings(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, '')       // 块注释
        .replace(/(^|[^:])\/\/.*$/gm, '$1')      // 行注释（避免误伤 http://）
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")     // 单引号字符串
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')     // 双引号字符串
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');    // 模板字符串
    }

    it.each(DEAD_FIELDS)('旧字段已根除（忽略注释/字符串）：%s', (field) => {
      const hits = readAllFiles()
        .filter(({ src }) => stripCommentsAndStrings(src).includes(field))
        .map((h) => h.file);
      expect(hits, `残留文件：${hits.join(', ')}`).toEqual([]);
    });
  });

  describe('四、已废除的伪样式在 CSS 中零出现', () => {
    const DEAD_CLASSES = [
      'toolRowChevronSlot',
      'toolPulseRing',
      'toolKindIconRunning',
    ];

    it.each(DEAD_CLASSES)('旧样式类已物理切除：%s', (cls) => {
      const cssFiles = ALL_SOURCES.filter((f) => f.endsWith('.css'));
      const hits = cssFiles.filter((f) => readFileSync(f, 'utf8').includes(cls));
      expect(
        hits,
        `残留 CSS：${hits.join(', ')}`
      ).toEqual([]);
    });
  });

  describe('五、SSOT 唯一性：核心概念仅有一处权威定义', () => {
    it('partitionTimelineSegments 仅在 timelineSegmenter.ts 定义', () => {
      const hits = readAllFiles().filter(({ src }) =>
        /export\s+function\s+partitionTimelineSegments/.test(src)
      );
      expect(hits.map((h) => h.file)).toEqual([
        expect.stringContaining('timelineSegmenter.ts'),
      ]);
    });

    it('aggregateProcessMetrics 仅在 processMetricsEngine.ts 定义', () => {
      const hits = readAllFiles().filter(({ src }) =>
        /export\s+function\s+aggregateProcessMetrics/.test(src)
      );
      expect(hits.map((h) => h.file)).toEqual([
        expect.stringContaining('processMetricsEngine.ts'),
      ]);
    });

    it('buildSlotId 仅在 toolPresentationTypes.ts 定义（禁止组件内复制）', () => {
      const hits = readAllFiles().filter(({ src }) =>
        /export\s+function\s+buildSlotId/.test(src)
      );
      expect(hits.map((h) => h.file)).toEqual([
        expect.stringContaining('toolPresentationTypes.ts'),
      ]);
    });

    it('isSubagentToolName 仅在 toolPresentationTypes.ts 定义（禁止 api→components 反向依赖）', () => {
      const hits = readAllFiles().filter(({ src }) =>
        /export\s+function\s+isSubagentToolName/.test(src)
      );
      expect(hits.map((h) => h.file)).toEqual([
        expect.stringContaining('toolPresentationTypes.ts'),
      ]);
    });

    it('DOMINANT_ICON_MAP 仅在 toolPresentationTypes.ts 定义', () => {
      const hits = readAllFiles().filter(({ src }) =>
        /export\s+const\s+DOMINANT_ICON_MAP/.test(src)
      );
      expect(hits.map((h) => h.file)).toEqual([
        expect.stringContaining('toolPresentationTypes.ts'),
      ]);
    });
  });

  describe('六、铁律四（子代理强制展开）在真实宿主链路中生效', () => {
    it('timelineSegmenter 实现子代理短路（subagentCount >= 1）', () => {
      const src = readFileSync(
        join(SRC, 'api/tool-presentation/timelineSegmenter.ts'),
        'utf8'
      );
      expect(src).toMatch(/metrics\.subagentCount\s*>=\s*1/);
      expect(src).toMatch(/forceExpanded\s*=\s*true/);
    });

    it('FoldableProcessSection 消费 forceExpanded 并在强展时永不挂 hidden', () => {
      const src = readFileSync(
        join(SRC, 'components/chat-message/FoldableProcessSection.tsx'),
        'utf8'
      );
      expect(src).toMatch(/forceExpanded/);
      // 强展段恒为展开
      expect(src).toMatch(/forceExpanded\s*\?\s*true\s*:/);
      // 强展段禁用收起交互
      expect(src).toMatch(/if\s*\(forceExpanded\)\s*return/);
    });

    it('MessageContent 将 seg.forceExpanded 透传至容器（禁止本地重推导）', () => {
      const src = readFileSync(
        join(SRC, 'components/chat-message/MessageContent.tsx'),
        'utf8'
      );
      expect(src).toMatch(/forceExpanded=\{seg\.forceExpanded\}/);
      expect(src).toMatch(/isFoldable=\{seg\.foldable\}/);
      // 负向：不得本地推导 foldable
      expect(src).not.toMatch(/const\s+foldable\s*=/);
    });
  });

  describe('七、Design Token 纪律（禁止裸 Hex 与伪变量）', () => {
    const CONVERGED_CSS = [
      'components/chat-message/FoldableProcessSection.module.css',
    ];

    it.each(CONVERGED_CSS)('无裸 Hex 色值：%s', (rel) => {
      const src = readFileSync(join(SRC, rel), 'utf8');
      // 剥离注释后再扫描
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
      const hexes = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes, `发现裸 Hex：${hexes.join(', ')}`).toEqual([]);
    });

    it.each(CONVERGED_CSS)('不得存在 [hidden] 的 display:none !important 覆盖：%s', (rel) => {
      const src = readFileSync(join(SRC, rel), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
      // 核心铁律：必须保留浏览器默认 content-visibility: hidden，否则原生检索无法穿透
      expect(code).not.toMatch(/\[hidden\][^{]*\{[^}]*display\s*:\s*none\s*!important/);
    });
  });

  describe('八、api 层不得反向依赖 components 层（运行期依赖方向红线）', () => {
    it('tool-presentation 下所有模块不产生运行期（值）import components/', () => {
      const dir = join(SRC, 'api/tool-presentation');
      const offenders: string[] = [];
      for (const name of readdirSync(dir)) {
        if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
        const src = readFileSync(join(dir, name), 'utf8');
        // `import type` 在编译期被完全擦除，不构成运行期依赖环；
        // 此处只扫描会真实求值的值导入。
        const valueImports = src
          .split('\n')
          .filter((line) => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line))
          .join('\n');
        if (/from\s+['"][^'"]*components\//.test(valueImports)) offenders.push(name);
      }
      expect(offenders, `运行期反向依赖文件：${offenders.join(', ')}`).toEqual([]);
    });

    it('toolPresentationTypes 对 icons 的依赖必须是 type-only（禁止运行期耦合）', () => {
      const src = readFileSync(
        join(SRC, 'api/tool-presentation/toolPresentationTypes.ts'),
        'utf8'
      );
      expect(src).toMatch(/import\s+type\s*\{[^}]*IconName[^}]*\}\s*from\s*['"][^'"]*components\/ui\/icons['"]/);
    });
  });
});
