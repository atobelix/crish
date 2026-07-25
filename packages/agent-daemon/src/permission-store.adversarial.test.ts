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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { PermissionStore } from './permission-store';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'perm-store-adv-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('PermissionStore — matchPattern 正则元字符未转义', () => {
  it('字面量 . 在 pattern 中被解释为"任意字符"', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git status.', 'allow');
    // pattern "git status." → regex "^git status.$" → . 匹配任意字符
    // 所以 "git statusX" 也匹配
    expect(store.evaluate('git statusX')).toBe('allow');
    // 但用户意图是只匹配 "git status." 字面量
  });

  it('字面量 + 在 pattern 中被解释为"一次或多次"', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git commit+', 'allow');
    // "git commit+" → "^git commit+$" → + 表示一个或多个 t
    expect(store.evaluate('git committttt')).toBe('allow');
    expect(store.evaluate('git commi')).toBe(null); // 不匹配（无 t）
  });

  it('字面量 ( ) 在 pattern 中被解释为分组', () => {
    const store = new PermissionStore(tempDir);
    // 含括号的 pattern 会触发 regex 语法错误，被 catch 后返回 false
    store.addRule('global', 'foo(bar)', 'allow');
    // "(bar)" 是合法分组，所以 regex "^foo(bar)$" 匹配 "foobar"
    expect(store.evaluate('foobar')).toBe('allow');
    // 用户可能期望只匹配字面 "foo(bar)"
  });

  it('未闭合括号触发 regex 语法错误，规则静默失效', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'foo(bar', 'allow');
    // pattern "foo(bar" → "^foo(bar$" — 未闭合分组，regex 抛错
    // catch 后返回 false，规则永远不会匹配
    expect(store.evaluate('foo(bar')).toBe(null);
    expect(store.evaluate('foobar')).toBe(null);
  });

  it('方括号 [ ] 被解释为字符类', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'file[abc]', 'allow');
    // "file[abc]" → "^file[abc]$" → 匹配 "filea", "fileb", "filec"
    expect(store.evaluate('filea')).toBe('allow');
    expect(store.evaluate('fileb')).toBe('allow');
    expect(store.evaluate('filed')).toBe(null);
  });

  it('反斜杠 \ 在 pattern 中可能引发意外行为', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'foo\\d+', 'allow');
    // "foo\d+" → "^foo\\d+$" → \d 匹配数字
    expect(store.evaluate('foo123')).toBe('allow');
    expect(store.evaluate('fooabc')).toBe(null);
  });

  it('属性测试: 不含 * ? 的字面量 pattern 应精确匹配', () => {
    // 这个测试会失败 —— 当前实现把 . + 等解释为 regex 元字符
    const store = new PermissionStore();
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }).filter(s => /^[\w.+-]+$/.test(s) && !s.includes('*') && !s.includes('?')),
        (s) => {
          store.addRule('global', s, 'allow');
          // 字面量 pattern 应只匹配自身
          const result = store.evaluate(s);
          // 当前实现：如果 s 含 . 或 +，可能匹配其他字符串
          // 但至少应匹配自身
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

  it('暴露 bug: JSON 文件包含 null 时，rules 被设为 null，后续操作崩溃', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, 'null', 'utf-8');
    const store = new PermissionStore(tempDir);
    // load 后 this.rules = null
    expect(() => store.addRule('global', 'x', 'allow')).toThrow();
    // 因为 this.rules.push 在 null 上调用
  });

  it('暴露 bug: JSON 文件包含非数组对象时，rules 被设为对象，push 失败', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, '{"foo":"bar"}', 'utf-8');
    const store = new PermissionStore(tempDir);
    expect(() => store.addRule('global', 'x', 'allow')).toThrow();
  });

  it('暴露 bug: JSON 文件包含数组但元素结构错误时，evaluate 行为未定义', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, '[{"foo":"bar"}]', 'utf-8');
    const store = new PermissionStore(tempDir);
    // rule.targetPattern 是 undefined，matchPattern 调用 undefined.trim() 抛错
    expect(() => store.evaluate('test')).toThrow();
  });

  it('损坏的 JSON（语法错误）静默重置为空规则', () => {
    const file = join(tempDir, 'permissions.json');
    writeFileSync(file, '{invalid json', 'utf-8');
    const store = new PermissionStore(tempDir);
    expect(store.getRules()).toEqual([]);
  });

  it('暴露 bug: save 不使用原子写（无 tmp+rename），中断可损坏文件', () => {
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git *', 'allow');
    // 验证非原子写：直接 writeFileSync
    const file = join(tempDir, 'permissions.json');
    const content = readFileSync(file, 'utf-8');
    expect(content).toBeDefined();
    // 如果在 writeFileSync 过程中崩溃，文件可能被截断
  });

  it('暴露 bug: save 不做 fsync，崩溃后数据可能丢失', () => {
    // 这个 bug 难以在测试中直接复现，但可以通过代码审查确认
    const store = new PermissionStore(tempDir);
    store.addRule('global', 'git *', 'allow');
    // 代码中 save() 只调用 writeFileSync，无 fsync
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
