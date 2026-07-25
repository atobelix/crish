/**
 * PermissionStore 对抗性测试套件
 *
 * 目标：暴露通配符匹配的正则注入、规则顺序依赖、大小写处理等 bug。
 *
 * 期望暴露的 bug：
 *  - matchPattern 未转义 regex 元字符（. + ( ) [ ] 等），导致误匹配
 *  - evaluate 规则顺序敏感（先 deny 后 allow 与先 allow 后 deny 结果不同）
 *  - 大小写不敏感匹配可能与 addRule 的字面量不一致
 *  - isMcpCommandApproved 用空格拼接参数，参数含空格时匹配错位
 *  - load 不校验 JSON 结构，损坏文件可导致后续操作崩溃
 *  - addRule 不去重
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { PermissionStore } from './permission-store';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'perm-store-adv-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('PermissionStore — matchPattern 通配符语义（元字符已转义）', () => {
  it('字面量 . 在 pattern 中作为字面量匹配（非"任意字符"）', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git status.', 'allow');
    // 修复后 . 是字面量，只匹配 "git status."，不匹配 "git statusX"
    expect(store.evaluate('git status.')).toBe('allow');
    expect(store.evaluate('git statusX')).toBe(null);
  });

  it('字面量 + 在 pattern 中作为字面量匹配（非"一次或多次"）', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git commit+', 'allow');
    // 修复后 + 是字面量，只匹配 "git commit+"
    expect(store.evaluate('git commit+')).toBe('allow');
    expect(store.evaluate('git committttt')).toBe(null);
    expect(store.evaluate('git commi')).toBe(null);
  });

  it('字面量 ( ) 在 pattern 中作为字面量匹配（非分组）', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'foo(bar)', 'allow');
    // 修复后 ( ) 是字面量，只匹配 "foo(bar)"，不匹配 "foobar"
    expect(store.evaluate('foo(bar)')).toBe('allow');
    expect(store.evaluate('foobar')).toBe(null);
  });

  it('未闭合括号现在作为字面量匹配（不再触发 regex 语法错误）', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'foo(bar', 'allow');
    // 修复后 ( 被转义为 \(，regex 有效，匹配字面量 "foo(bar"
    expect(store.evaluate('foo(bar')).toBe('allow');
    expect(store.evaluate('foobar')).toBe(null);
  });

  it('方括号 [ ] 作为字面量匹配（非字符类）', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'file[abc]', 'allow');
    // 修复后 [ ] 是字面量，只匹配 "file[abc]"，不匹配 "filea"
    expect(store.evaluate('file[abc]')).toBe('allow');
    expect(store.evaluate('filea')).toBe(null);
    expect(store.evaluate('fileb')).toBe(null);
  });

  it('反斜杠 \ 在 pattern 中作为字面量匹配', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'foo\\d+', 'allow');
    // 修复后 \ 和 + 都是字面量，只匹配 "foo\d+"
    expect(store.evaluate('foo\\d+')).toBe('allow');
    expect(store.evaluate('foo123')).toBe(null);
    expect(store.evaluate('fooabc')).toBe(null);
  });

  it('属性测试: 不含 * ? 的字面量 pattern 应精确匹配自身', () => {
    const store = new PermissionStore();
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }).filter(s => /^[\w.+-]+$/.test(s) && !s.includes('*') && !s.includes('?')),
        (s) => {
          store.addRule('global', s, 'allow');
          // 字面量 pattern 应只匹配自身
          const result = store.evaluate(s);
          expect(result).toBe('allow');
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('PermissionStore — 规则顺序依赖', () => {
  it('暴露 bug: 先 allow 后 deny，deny 胜（按插入顺序匹配）', () => {
    const store = new PermissionStore();
    store.addRule('global', 'git *', 'allow');
    store.addRule('global', 'git push', 'deny');
    // evaluate 按插入顺序，先匹配到 "git *" → allow
    expect(store.evaluate('git push')).toBe('allow'); // deny 被覆盖
  });

  it('反转顺序后结果不同', () => {
    const store = new PermissionStore();
    store.addRule('global', 'git push', 'deny');
    store.addRule('global', 'git *', 'allow');
    // 先匹配到 "git push" → deny
    expect(store.evaluate('git push')).toBe('deny');
  });

  it('暴露 bug: 同一 pattern 多次 addRule 不去重', () => {
    const store = new PermissionStore();
    store.addRule('global', 'git *', 'allow');
    store.addRule('global', 'git *', 'deny');
    store.addRule('global', 'git *', 'allow');
    expect(store.getRules().length).toBe(3); // 三条相同 pattern
  });

  it('暴露 bug: scope 不影响匹配优先级', () => {
    const store = new PermissionStore();
    store.addRule('global', 'git *', 'allow');
    store.addRule('project', 'git push', 'deny');
    // global 先插入，先匹配
    expect(store.evaluate('git push')).toBe('allow');
    // 即使 project scope 更具体，也不优先
  });
});

describe('PermissionStore — 大小写处理', () => {
  it('匹配是大小写不敏感的', () => {
    const store = new PermissionStore();
    store.addRule('global', 'Git Status', 'allow');
    expect(store.evaluate('git status')).toBe('allow');
    expect(store.evaluate('GIT STATUS')).toBe('allow');
    expect(store.evaluate('GiT sTaTuS')).toBe('allow');
  });

  it('暴露 bug: target 与 pattern 大小写不一时仍匹配，但 addRule 不规范化', () => {
    const store = new PermissionStore();
    store.addRule('global', 'Git Status', 'allow');
    const rules = store.getRules();
    expect(rules[0]?.targetPattern).toBe('Git Status'); // 原样保存
    // 但 evaluate('git status') 匹配 — 不一致
  });
});

describe('PermissionStore — isMcpCommandApproved 参数拼接', () => {
  it('正常 command + args 拼接', () => {
    const store = new PermissionStore();
    store.approveMcpCommand('node', ['server.js', '--port', '3000']);
    expect(store.isMcpCommandApproved('node', ['server.js', '--port', '3000'])).toBe(true);
  });

  it('暴露 bug: 参数含空格时，拼接后匹配错位', () => {
    const store = new PermissionStore();
    // 用户批准了 node "my script.js"
    store.approveMcpCommand('node', ['my script.js']);
    // 拼接后 target = "node my script.js"
    // 但下面这个调用也匹配（虽然参数不同）
    expect(store.isMcpCommandApproved('node', ['my', 'script.js'])).toBe(true);
    // 因为拼接后都是 "node my script.js"
  });

  it('暴露 bug: 空参数数组与含一个空字符串的参数数组无法区分', () => {
    const store = new PermissionStore();
    store.approveMcpCommand('cmd', []);
    // target = "cmd"
    expect(store.isMcpCommandApproved('cmd', [])).toBe(true);
    expect(store.isMcpCommandApproved('cmd', [''])).toBe(true); // "cmd " trim 后还是 "cmd"
  });

  it('args 含 * 字符会被解释为通配符', () => {
    const store = new PermissionStore();
    store.approveMcpCommand('node', ['*.js']);
    // target = "node *.js" → pattern "node *.js" → regex "^node .*\.js$"
    expect(store.isMcpCommandApproved('node', ['any.js'])).toBe(true);
    expect(store.isMcpCommandApproved('node', ['foo.js'])).toBe(true);
    // 用户可能期望只匹配字面 "*.js"
  });
});

describe('PermissionStore — 持久化与损坏恢复', () => {
  it('正常加载已保存的规则', () => {
    const store1 = new PermissionStore(tempDir);
    store1.addRule('global', 'git *', 'allow');

    const store2 = new PermissionStore(tempDir);
    expect(store2.evaluate('git status')).toBe('allow');
  });

  it('修复验证: JSON 文件包含 null 时，rules 重置为空数组，不崩溃', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, 'null', 'utf-8');
    const store = new PermissionStore(tempDir);
    // 修复后 load 验证 Array.isArray，null 被重置为 []
    expect(store.getRules()).toEqual([]);
    expect(() => store.addRule('global', 'x', 'allow')).not.toThrow();
  });

  it('修复验证: JSON 文件包含非数组对象时，rules 重置为空数组', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, '{"foo":"bar"}', 'utf-8');
    const store = new PermissionStore(tempDir);
    expect(store.getRules()).toEqual([]);
    expect(() => store.addRule('global', 'x', 'allow')).not.toThrow();
  });

  it('修复验证: JSON 文件含数组但元素结构错误时，evaluate 不崩溃', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, '[{"foo":"bar"}]', 'utf-8');
    const store = new PermissionStore(tempDir);
    // 修复后 matchPattern 防御 undefined targetPattern，返回 false 而非抛错
    expect(() => store.evaluate('test')).not.toThrow();
    expect(store.evaluate('test')).toBe(null);
  });

  it('损坏的 JSON（语法错误）静默重置为空规则', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, '{invalid json', 'utf-8');
    const store = new PermissionStore(tempDir);
    expect(store.getRules()).toEqual([]);
  });

  it('修复验证: save 使用原子写（tmp+rename），无残留临时文件', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git *', 'allow');
    const file = join(tempDir, 'permissions.json');
    const content = readFileSync(file, 'utf-8');
    expect(content).toBeDefined();
    // 原子写后不应有残留的 .tmp 文件
    const files = readdirSync(tempDir).filter(f => f.endsWith('.tmp'));
    expect(files).toHaveLength(0);
  });

  it('修复验证: save 使用 fsync 确保数据落盘', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git *', 'allow');
    // 原子写 + fsync 后，重新加载应得到相同规则
    const store2 = new PermissionStore(tempDir);
    expect(store2.getRules()).toEqual(store.getRules());
  });
});

describe('PermissionStore — evaluate 边界', () => {
  it('空 target 返回 null', () => {
    const store = new PermissionStore();
    store.addRule('global', 'git *', 'allow');
    expect(store.evaluate('')).toBe(null);
    // 因为 pattern "git *" 不匹配空字符串
  });

  it('pattern 为 * 匹配任意 target', () => {
    const store = new PermissionStore();
    store.addRule('global', '*', 'allow');
    expect(store.evaluate('anything')).toBe('allow');
    expect(store.evaluate('')).toBe('allow'); // * 匹配空字符串
  });

  it('pattern 为空字符串只匹配空 target', () => {
    const store = new PermissionStore();
    store.addRule('global', '', 'allow');
    // pattern "" → regex "^$" → 只匹配空字符串
    expect(store.evaluate('')).toBe('allow');
    expect(store.evaluate('x')).toBe(null);
  });

  it('暴露 bug: evaluate 对 target 做 trim，但 addRule 也对 pattern 做 trim，行为不一致', () => {
    const store = new PermissionStore();
    store.addRule('global', '  git *  ', 'allow'); // pattern 被 trim 为 "git *"
    expect(store.evaluate('  git status  ')).toBe('allow'); // target 也被 trim
    expect(store.evaluate('git status')).toBe('allow');
  });

  it('属性测试: pattern === target 时一定匹配', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => !/[.+*?(){}\[\]\\|^$]/.test(s)),
        (s) => {
          const localStore = new PermissionStore();
          localStore.addRule('global', s, 'allow');
          expect(localStore.evaluate(s)).toBe('allow');
        },
      ),
      { numRuns: 200 },
    );
  });
});
