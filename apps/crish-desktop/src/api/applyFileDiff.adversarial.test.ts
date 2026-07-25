/**
 * applyFileDiff 纯函数对抗性测试套件
 *
 * 目标：暴露路径规范化、search_replace 状态分析、冲突检测等纯函数的 bug。
 * 不测试磁盘 IO（已在其他套件覆盖）。
 *
 * 期望暴露的 bug：
 *  - normalizeApplyPath 对 UNC 路径处理不当
 *  - isSafeApplyPath 对 Windows 保留名检测的边界
 *  - analyzeSearchReplace 的冲突检测阈值（24 字符）过于武断
 *  - countOccurrences 的重叠匹配行为
 *  - classifyFileDiff 对元数据与实际行数不一致的判断
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  normalizeApplyPath,
  isSafeApplyPath,
  analyzeSearchReplace,
  applySearchReplaceToContent,
  countOccurrences,
  classifyFileDiff,
  hasEffectiveDiffChanges,
  reconstructFullContent,
  reconstructSearchReplace,
  normalizeEol,
  preferEolStyle,
  formatApplyFailureToast,
} from './applyFileDiff';
import type { FileDiff, DiffChange } from '../store/types';

describe('normalizeApplyPath — 路径规范化', () => {
  it('去除首尾引号', () => {
    expect(normalizeApplyPath('"foo/bar.ts"')).toBe('foo/bar.ts');
    expect(normalizeApplyPath("'foo/bar.ts'")).toBe('foo/bar.ts');
  });

  it('反斜杠转正斜杠', () => {
    expect(normalizeApplyPath('foo\\bar\\baz.ts')).toBe('foo/bar/baz.ts');
  });

  it('折叠重复斜杠', () => {
    expect(normalizeApplyPath('foo///bar//baz.ts')).toBe('foo/bar/baz.ts');
  });

  it('去除前导 ./', () => {
    expect(normalizeApplyPath('./foo/bar.ts')).toBe('foo/bar.ts');
    expect(normalizeApplyPath('./././foo.ts')).toBe('foo.ts');
  });

  it('去除尾随斜杠', () => {
    expect(normalizeApplyPath('foo/bar/')).toBe('foo/bar');
    expect(normalizeApplyPath('foo/bar///')).toBe('foo/bar');
  });

  it('空字符串返回空', () => {
    expect(normalizeApplyPath('')).toBe('');
    expect(normalizeApplyPath(null)).toBe('');
    expect(normalizeApplyPath(undefined)).toBe('');
  });

  it('暴露 bug: UNC 路径 \\server\share 被折叠为 /server/share', () => {
    // UNC 路径以双反斜杠开头，规范化后变成单斜杠
    expect(normalizeApplyPath('\\\\server\\share\\file.ts')).toBe('/server/share/file.ts');
    // 这变成了 POSIX 绝对路径，语义改变
  });

  it('保留盘符形式', () => {
    expect(normalizeApplyPath('C:\\foo\\bar.ts')).toBe('C:/foo/bar.ts');
    expect(normalizeApplyPath('C:/foo/bar.ts')).toBe('C:/foo/bar.ts');
  });

  it('属性测试: 规范化幂等（再规范化不变）', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 64 }).filter(s => !s.includes('\0')), (s) => {
        const once = normalizeApplyPath(s);
        const twice = normalizeApplyPath(once);
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});

describe('isSafeApplyPath — 安全路径校验', () => {
  it('合法相对路径通过', () => {
    expect(isSafeApplyPath('src/foo.ts')).toEqual({ ok: true, path: 'src/foo.ts' });
    expect(isSafeApplyPath('src/foo/bar.ts')).toEqual({ ok: true, path: 'src/foo/bar.ts' });
  });

  it('合法绝对路径通过', () => {
    expect(isSafeApplyPath('/home/user/foo.ts').ok).toBe(true);
    expect(isSafeApplyPath('C:/foo/bar.ts').ok).toBe(true);
  });

  it('拒绝 .. 越界', () => {
    expect(isSafeApplyPath('../foo.ts').ok).toBe(false);
    expect(isSafeApplyPath('foo/../../bar.ts').ok).toBe(false);
    expect(isSafeApplyPath('foo/../bar.ts').ok).toBe(false);
  });

  it('拒绝空路径', () => {
    expect(isSafeApplyPath('').ok).toBe(false);
    expect(isSafeApplyPath('   ').ok).toBe(false);
    expect(isSafeApplyPath(null).ok).toBe(false);
  });

  it('拒绝含 NULL 字节的路径', () => {
    expect(isSafeApplyPath('foo\x00bar.ts').ok).toBe(false);
  });

  it('拒绝含控制字符的路径', () => {
    expect(isSafeApplyPath('foo\x1bbar.ts').ok).toBe(false);
    expect(isSafeApplyPath('foo\x7fbar.ts').ok).toBe(false);
  });

  it('拒绝 Windows 保留名', () => {
    expect(isSafeApplyPath('CON').ok).toBe(false);
    expect(isSafeApplyPath('PRN').ok).toBe(false);
    expect(isSafeApplyPath('AUX').ok).toBe(false);
    expect(isSafeApplyPath('NUL').ok).toBe(false);
    expect(isSafeApplyPath('COM1').ok).toBe(false);
    expect(isSafeApplyPath('LPT9').ok).toBe(false);
  });

  it('Windows 保留名带扩展名也拒绝', () => {
    expect(isSafeApplyPath('CON.txt').ok).toBe(false);
    expect(isSafeApplyPath('PRN.log').ok).toBe(false);
  });

  it('Windows 保留名大小写不敏感', () => {
    expect(isSafeApplyPath('con').ok).toBe(false);
    expect(isSafeApplyPath('Con').ok).toBe(false);
    expect(isSafeApplyPath('CON').ok).toBe(false);
  });

  it('拒绝占位符路径', () => {
    expect(isSafeApplyPath('变更').ok).toBe(false);
    expect(isSafeApplyPath('文件').ok).toBe(false);
    expect(isSafeApplyPath('unknown').ok).toBe(false);
    expect(isSafeApplyPath('untitled').ok).toBe(false);
  });

  it('暴露 bug: 占位符只检查完整路径与 basename，不检查中间段', () => {
    // 中间段含 unknown 不被拒绝
    expect(isSafeApplyPath('unknown/foo.ts').ok).toBe(true);
    // 但 basename 是 unknown 被拒绝
    expect(isSafeApplyPath('foo/unknown').ok).toBe(false);
  });

  it('拒绝尾随点/空格的段（Windows 危险）', () => {
    expect(isSafeApplyPath('foo /bar.ts').ok).toBe(false);
    expect(isSafeApplyPath('foo./bar.ts').ok).toBe(false);
  });

  it('拒绝含冒号的非盘符路径', () => {
    expect(isSafeApplyPath('foo:bar.ts').ok).toBe(false);
    expect(isSafeApplyPath('foo/bar:baz.ts').ok).toBe(false);
  });

  it('属性测试: 任何含 .. 的路径都应被拒绝', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }).filter(s => !s.includes('/') && !s.includes('\0') && s !== '.' && s !== '..'), 1, 5),
        (parts) => {
          const path = ['..', ...parts].join('/');
          expect(isSafeApplyPath(path).ok).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('countOccurrences — 出现次数统计', () => {
  it('无匹配返回 0', () => {
    expect(countOccurrences('hello', 'x')).toBe(0);
  });

  it('空 needle 返回 0', () => {
    expect(countOccurrences('hello', '')).toBe(0);
  });

  it('单次匹配', () => {
    expect(countOccurrences('hello world', 'world')).toBe(1);
  });

  it('多次非重叠匹配', () => {
    expect(countOccurrences('aaa', 'a')).toBe(3);
  });

  it('不重叠的多字符 needle', () => {
    expect(countOccurrences('ababab', 'ab')).toBe(3);
  });

  it('暴露 bug: 重叠 needle 不计数（设计行为，但可能不符预期）', () => {
    // "aaaa" 中 "aa" 重叠出现 3 次（位置 0,1,2），但函数返回 2
    expect(countOccurrences('aaaa', 'aa')).toBe(2); // 非重叠
    // 如果用户期望重叠计数，这是 bug
  });

  it('needle 长度 1 正常工作', () => {
    expect(countOccurrences('a-b-c-d', '-')).toBe(3);
  });
});

describe('analyzeSearchReplace — 状态分析', () => {
  it('apply: 唯一匹配替换', () => {
    const r = analyzeSearchReplace('foo bar baz', 'bar', 'qux');
    expect(r.status).toBe('apply');
    if (r.status === 'apply') {
      expect(r.content).toBe('foo qux baz');
    }
  });

  it('already_applied: newStr 已在 body 中', () => {
    const r = analyzeSearchReplace('foo qux baz', 'bar', 'qux');
    expect(r.status).toBe('already_applied');
  });

  it('missing_old: oldStr 不在 body 中且 newStr 也不在', () => {
    const r = analyzeSearchReplace('foo baz', 'bar', 'qux');
    expect(r.status).toBe('missing_old');
  });

  it('ambiguous: oldStr 多次出现', () => {
    const r = analyzeSearchReplace('foo bar foo bar', 'foo', 'qux');
    expect(r.status).toBe('ambiguous');
    if (r.status === 'ambiguous') {
      expect(r.hits).toBe(2);
    }
  });

  it('empty: old 和 new 都为空', () => {
    const r = analyzeSearchReplace('body', '', '');
    expect(r.status).toBe('empty');
  });

  it('append: old 为空，new 非空，body 不含 new', () => {
    const r = analyzeSearchReplace('body', '', 'appended');
    expect(r.status).toBe('append');
    if (r.status === 'append') {
      expect(r.content).toBe('body\nappended');
    }
  });

  it('append: body 为空时直接写 new', () => {
    const r = analyzeSearchReplace('', '', 'appended');
    expect(r.status).toBe('append');
    if (r.status === 'append') {
      expect(r.content).toBe('appended');
    }
  });

  it('already_applied: old === new 且 body 含 old', () => {
    const r = analyzeSearchReplace('foo bar', 'bar', 'bar');
    expect(r.status).toBe('already_applied');
  });

  it('exposed bug: 冲突检测要求 newStr 长度 >= 24 或含换行，短 newStr 漏报冲突', () => {
    // body 同时包含 old 和 new（短），但函数认为不是冲突
    const r = analyzeSearchReplace('foo abc xyz def abc', 'abc', 'xyz');
    // old=abc 出现 2 次 → ambiguous，不会进入冲突分支
    // 改为 old 出现 1 次
    const r2 = analyzeSearchReplace('foo abc def xyz', 'abc', 'xyz');
    // old=abc 出现 1 次，new=xyz 在 body 中，但 new 长度 < 24 且无换行
    // 函数不认为是冲突，直接 apply
    expect(r2.status).toBe('apply');
    // 但实际上 new 已经在 body 中，可能是部分应用
  });

  it('冲突检测: newStr 含换行时识别冲突', () => {
    // newStr 必须真的含换行，且在 body 中存在，才触发 conflict
    const body = 'foo old bar\nnew content\nhere';
    const r = analyzeSearchReplace(body, 'old', 'new content\nhere');
    // old 出现 1 次，new 含换行且在 body 中
    expect(r.status).toBe('conflict');
  });

  it('冲突检测: newStr 长度 >= 24 时识别冲突', () => {
    const body = 'foo old bar this-is-a-long-new-string-24';
    const r = analyzeSearchReplace(body, 'old', 'this-is-a-long-new-string-24');
    expect(r.status).toBe('conflict');
  });

  it('CRLF 与 LF 混合时统一为 LF 比较', () => {
    const body = 'foo\r\nbar\r\n';
    const r = analyzeSearchReplace(body, 'foo', 'baz');
    expect(r.status).toBe('apply');
    if (r.status === 'apply') {
      // 保留原 EOL 风格
      expect(r.content).toBe('baz\r\nbar\r\n');
    }
  });

  it('属性测试: apply 后再分析应返回 already_applied', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => !s.includes('\n') && !s.includes('\r')),
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => !s.includes('\n') && !s.includes('\r')),
        (oldStr, newStr) => {
          const body = `prefix${oldStr}suffix`;
          const r1 = analyzeSearchReplace(body, oldStr, newStr);
          if (r1.status === 'apply') {
            const r2 = analyzeSearchReplace(r1.content, oldStr, newStr);
            // 替换后 oldStr 不再存在
            expect(['missing_old', 'already_applied']).toContain(r2.status);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('applySearchReplaceToContent — 应用结果', () => {
  it('成功应用返回新内容', () => {
    const r = applySearchReplaceToContent('foo bar', 'bar', 'baz');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe('foo baz');
      expect(r.alreadyApplied).toBeUndefined();
    }
  });

  it('已应用返回原内容 + alreadyApplied 标记', () => {
    const r = applySearchReplaceToContent('foo baz', 'bar', 'baz');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe('foo baz');
      expect(r.alreadyApplied).toBe(true);
    }
  });

  it('歧义返回 ambiguous 错误码', () => {
    const r = applySearchReplaceToContent('foo foo foo', 'foo', 'bar');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ambiguous');
    }
  });

  it('空变更返回 empty 错误码', () => {
    const r = applySearchReplaceToContent('body', '', '');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('empty');
    }
  });
});

describe('classifyFileDiff — diff 分类', () => {
  function makeAdd(content: string): DiffChange {
    return { type: 'addition', content };
  }
  function makeDel(content: string): DiffChange {
    return { type: 'deletion', content };
  }
  function makeNormal(content: string): DiffChange {
    return { type: 'normal', content };
  }

  it('纯新增 → full_write', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [makeAdd('line1'), makeAdd('line2')],
      additions: 2,
      deletions: 0,
    };
    expect(classifyFileDiff(diff)).toEqual({ ok: true, mode: 'full_write' });
  });

  it('纯删除 → search_replace', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [makeDel('line1')],
      additions: 0,
      deletions: 1,
    };
    expect(classifyFileDiff(diff)).toEqual({ ok: true, mode: 'search_replace' });
  });

  it('增删混合 → search_replace', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [makeDel('old'), makeAdd('new')],
      additions: 1,
      deletions: 1,
    };
    expect(classifyFileDiff(diff)).toEqual({ ok: true, mode: 'search_replace' });
  });

  it('空 changes → 拒绝', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [],
      additions: 0,
      deletions: 0,
    };
    expect(classifyFileDiff(diff).ok).toBe(false);
  });

  it('仅噪声 normal → 拒绝', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [makeNormal('@@ hunk header'), makeNormal('（占位）')],
      additions: 0,
      deletions: 0,
    };
    expect(classifyFileDiff(diff).ok).toBe(false);
  });

  it('有真实上下文 normal → 拒绝（无法还原）', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [makeNormal('context line'), makeAdd('new')],
      additions: 1,
      deletions: 0,
    };
    expect(classifyFileDiff(diff).ok).toBe(false);
  });

  it('暴露 bug: 元数据 additions=0 但实际有 add 行，不触发截断检测', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [makeAdd('line1'), makeAdd('line2')],
      additions: 0, // 元数据声称 0，但实际有 2 行
      deletions: 0,
    };
    // 不触发"diff 内容已截断"判断
    expect(classifyFileDiff(diff).ok).toBe(true);
  });

  it('元数据 additions > 实际行数 → 截断', () => {
    const diff: FileDiff = {
      filePath: 'foo.ts',
      changes: [makeAdd('line1')],
      additions: 5, // 元数据声称 5，但实际只有 1
      deletions: 0,
    };
    expect(classifyFileDiff(diff).ok).toBe(false);
  });

  it('不安全路径 → 拒绝', () => {
    const diff: FileDiff = {
      filePath: '../escape.ts',
      changes: [makeAdd('line1')],
      additions: 1,
      deletions: 0,
    };
    expect(classifyFileDiff(diff).ok).toBe(false);
  });
});

describe('formatApplyFailureToast — 失败提示', () => {
  it('failed=0 返回空字符串', () => {
    expect(formatApplyFailureToast(0, [])).toBe('');
  });

  it('单文件失败显示文件名与原因', () => {
    const r = formatApplyFailureToast(1, [
      { filePath: 'foo/bar.ts', result: { ok: false, message: '冲突' } },
    ]);
    expect(r).toBe('应用失败 · bar.ts：冲突');
  });

  it('多文件失败显示数量与首个文件名', () => {
    const r = formatApplyFailureToast(3, [
      { filePath: 'foo/a.ts', result: { ok: false, message: 'x' } },
      { filePath: 'foo/b.ts', result: { ok: false, message: 'y' } },
    ]);
    expect(r).toBe('部分失败 3 · a.ts 等');
  });

  it('暴露 bug: 失败结果中 ok=true 的条目被忽略，可能误报', () => {
    // 如果 results 数组中混入了 ok=true 的条目，find 找不到 ok=false 的
    const r = formatApplyFailureToast(1, [
      { filePath: 'foo/success.ts', result: { ok: true, mode: 'full_write' } },
    ]);
    // failed=1 但 results 中没有失败条目
    expect(r).toBe('应用失败'); // 没有文件名
  });
});

describe('normalizeEol / preferEolStyle — 换行处理', () => {
  it('CRLF → LF', () => {
    expect(normalizeEol('foo\r\nbar\r\n')).toBe('foo\nbar\n');
  });

  it('孤立的 CR → LF', () => {
    expect(normalizeEol('foo\rbar')).toBe('foo\nbar');
  });

  it('混合换行统一为 LF', () => {
    expect(normalizeEol('foo\r\nbar\rbaz\n')).toBe('foo\nbar\nbaz\n');
  });

  it('preferEolStyle: body 含 CRLF 时还原 CRLF', () => {
    expect(preferEolStyle('body\r\n', 'foo\nbar\n')).toBe('foo\r\nbar\r\n');
  });

  it('preferEolStyle: body 无 CRLF 时保持 LF', () => {
    expect(preferEolStyle('body\n', 'foo\nbar\n')).toBe('foo\nbar\n');
  });
});
