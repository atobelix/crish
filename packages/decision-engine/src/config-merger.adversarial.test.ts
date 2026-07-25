/**
 * config-merger 对抗性测试
 *
 * 目标：暴露配置合并、冲突检测、深合并、验证逻辑在边界输入下的隐藏缺陷。
 *
 * 已暴露的 bug 清单（详见各 it 用例注释）：
 *  CM1. conflicts 误报：schema 默认值在 result 中，导致后续 source 同字段被误记为冲突
 *  CM2. 未知字段（schema 中没有的 key）被静默接受到 result
 *  CM3. deep-merge 对 base 含 undefined 字段时正确处理，但对 null 字段被覆盖
 *  CM4. append 策略对 base 非数组 + overlay 数组 → 返回 overlay（丢失 base 语义可疑）
 *  CM5. append 策略对 base 数组 + overlay 非数组 → 返回 overlay（覆盖数组）
 *  CM6. shallow-merge 对 base 数组 + overlay 对象 → 返回 overlay（合理）
 *  CM7. validate 对 required=false + value=null 跳过 validate 函数
 *  CM8. validate 对 schema.validate 返回的错误不区分严重性
 *  CM9. merge 对 priority 非法值（NaN/字符串）的排序行为不稳定
 *  CM10. merge 对空 sources 数组返回只含默认值的 config
 *  CM11. merge 对 source.value 为非对象（number/string）时 Object.entries 抛异常
 *  CM12. merge 对 source.value 含循环引用时 Object.entries 不抛（但 spread 可能栈溢出）
 *  CM13. deepMerge 对原型污染：__proto__ / constructor
 *  CM14. conflicts 中 loserValue 是被覆盖前的值（正确），但 winner 永远是 source.name
 *  CM15. merge 后 result 字段顺序：默认值先入，source 覆盖（依赖 Object.entries 顺序）
 *  CM16. validate 对 value=0 / value=false / value='' 不应误判为缺失
 *  CM17. validate 对 validate 函数抛异常时不捕获
 *  CM18. ConfigMerger 不可重用（schema 闭包，每次 merge 共享）— 实际可重用
 *  CM19. merge 对同名 source 重复出现不报错（允许多个同名 source）
 *  CM20. conflicts 报告 strategy=override 时不区分"override"和"无 policy"
 */

import { describe, it, expect } from 'vitest';
import { ConfigMerger, type ConfigSchema, type ConfigSource } from './config-merger';
import { CONFIG_PRIORITY } from '@crish/shared-types';

function makeSchema(): ConfigSchema {
  return {
    name: 'test',
    fields: {
      port: {
        mergeStrategy: 'override',
        required: true,
        validate: (v) => typeof v === 'number' && v > 0 && v < 65536,
        validateMessage: 'port must be 1-65535',
      },
      tags: {
        mergeStrategy: 'append',
        required: false,
        defaultValue: [],
      },
      options: {
        mergeStrategy: 'deep-merge',
        required: false,
        defaultValue: { verbose: false },
      },
      features: {
        mergeStrategy: 'shallow-merge',
        required: false,
        defaultValue: { experimental: false },
      },
    },
  };
}

function makeSource(priority: number, name: string, value: Record<string, unknown>): ConfigSource {
  return { priority: priority as any, name, value };
}

describe('config-merger — 对抗性测试', () => {
  describe('CM1: conflicts 误报（schema 默认值导致）', () => {
    it('暴露 bug: schema 默认值在 result 中，后续 source 同字段被误记为冲突', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { tags: ['a'] }),
      ];

      const result = merger.merge(sources);

      // Bug: tags 有 defaultValue=[]，所以 result 中已有 tags=[]
      // source 'user' 也提供 tags=['a']，key in result 且 result[key] !== undefined
      // → 被误报为冲突
      // 但 strategy='append'，不是 'override'，所以不应进入 conflicts 分支
      // 让我看代码：第 71 行 `if (!policy || policy.mergeStrategy === "override")`
      // tags 的 policy 存在且 strategy='append'，所以条件 false，不报冲突
      // 实际：append 策略不报冲突
      expect(result.conflicts).toHaveLength(0);
    });

    it('CM1（已修复）: override 策略 + 默认值 → 不再误报冲突', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: {
            mergeStrategy: 'override',
            required: true,
            defaultValue: 8080,
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { port: 3000 }),
      ];

      const result = merger.merge(sources);

      // 修复后：默认值不算"冲突前驱"，不报冲突
      expect(result.conflicts).toHaveLength(0);
      expect(result.config.port).toBe(3000);
    });

    it('override 策略 + 多个真实 source → 正确报告冲突', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: {
            mergeStrategy: 'override',
            required: true,
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.WORKSPACE, 'ws', { port: 8080 }),
        makeSource(CONFIG_PRIORITY.USER, 'user', { port: 3000 }),
      ];

      const result = merger.merge(sources);

      // 两个真实 source 都提供 port，应报告 1 个冲突
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.winner).toBe('user');
      expect(result.conflicts[0]!.loser).toBe('previous');
      expect(result.conflicts[0]!.winnerValue).toBe(3000);
      expect(result.conflicts[0]!.loserValue).toBe(8080);
    });
  });

  describe('CM2: 未知字段被静默接受', () => {
    it('暴露 bug: schema 中没有的 key 被静默接受到 result', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', {
          port: 3000,
          unknownField: 'evil',
          anotherUnknown: 123,
        }),
      ];

      const result = merger.merge(sources);

      // Bug: unknownField 和 anotherUnknown 不在 schema 中，但被静默接受
      expect(result.config.unknownField).toBe('evil');
      expect(result.config.anotherUnknown).toBe(123);
      // validate 也不检查未知字段
      expect(result.validation.valid).toBe(true);
    });

    it('暴露 bug: 未知字段也参与 conflicts 报告', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.WORKSPACE, 'ws', { unknownField: 'a' }),
        makeSource(CONFIG_PRIORITY.USER, 'user', { unknownField: 'b' }),
      ];

      const result = merger.merge(sources);

      // 未知字段也进入 conflicts（因为 !policy 为真，走 override 分支）
      const unknownConflicts = result.conflicts.filter((c) => c.key === 'unknownField');
      expect(unknownConflicts).toHaveLength(1);
      expect(unknownConflicts[0]!.winnerValue).toBe('b');
    });
  });

  describe('CM3: deep-merge 边界', () => {
    it('deep-merge 正确合并嵌套对象', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.WORKSPACE, 'ws', {
          options: { verbose: true, debug: false },
        }),
        makeSource(CONFIG_PRIORITY.USER, 'user', {
          options: { debug: true, level: 3 },
        }),
      ];

      const result = merger.merge(sources);

      // deep-merge: { verbose: true (from ws), debug: true (from user), level: 3 (from user) }
      // 默认值 { verbose: false } 先入
      // ws 覆盖 verbose=true, 添加 debug=false
      // user 覆盖 debug=true, 添加 level=3
      expect(result.config.options).toEqual({
        verbose: true,
        debug: true,
        level: 3,
      });
    });

    it('CM3（已修复）: deep-merge 对 null 字段覆盖（而非保留 base）', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          options: {
            mergeStrategy: 'deep-merge',
            required: false,
            defaultValue: { a: 1, b: 2 },
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', {
          options: { b: null, c: 3 },
        }),
      ];

      const result = merger.merge(sources);

      // 修复后：null 显式覆盖 base 值
      // deepMerge: base={a:1,b:2}, overlay={b:null,c:3}
      // b: deepMerge(2, null) → overlay===null → return null（覆盖）
      // c: deepMerge(undefined, 3) → return 3
      expect(result.config.options).toEqual({ a: 1, b: null, c: 3 });
    });

    it('deep-merge 对 undefined 字段被跳过', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', {
          options: { verbose: undefined, newField: 'ok' },
        }),
      ];

      const result = merger.merge(sources);

      // deepMerge 第 137 行: if (value !== undefined) result[key] = deepMerge(...)
      // verbose=undefined 被跳过，保留默认值 false
      expect(result.config.options).toEqual({ verbose: false, newField: 'ok' });
    });
  });

  describe('CM13: deepMerge 原型污染', () => {
    it('暴露 bug: __proto__ 字段可能污染原型', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', {
          options: { __proto__: { polluted: 'yes' }, legit: 'ok' },
        }),
      ];

      const before = ({} as Record<string, unknown>).polluted;
      expect(before).toBeUndefined();

      const result = merger.merge(sources);

      // deepMerge 用 { ...base } 展开，__proto__ 会被设置为属性而非原型
      // 但 { ...{ __proto__: { polluted: 'yes' } } } 实际行为依赖引擎
      // V8 中 spread 不触发原型污染（__proto__ 作为普通属性）
      const after = ({} as Record<string, unknown>).polluted;
      expect(after).toBeUndefined();
      // options 应该有 __proto__ 作为普通属性
      expect((result.config.options as any).__proto__).toBeDefined();
    });

    it('暴露 bug: constructor.prototype 链可能污染', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', {
          options: { constructor: { prototype: { polluted2: 'yes' } } },
        }),
      ];

      const before = ({} as Record<string, unknown>).polluted2;
      expect(before).toBeUndefined();

      const result = merger.merge(sources);

      const after = ({} as Record<string, unknown>).polluted2;
      expect(after).toBeUndefined();
      // constructor 作为普通属性
      expect((result.config.options as any).constructor).toBeDefined();
    });
  });

  describe('CM4/CM5/CM6: applyMerge 策略边界', () => {
    it('CM4: append 策略对 base 非数组 + overlay 数组 → 返回 overlay（丢失 base）', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          items: {
            mergeStrategy: 'append',
            required: false,
            defaultValue: 'default-string',
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { items: [1, 2, 3] }),
      ];

      const result = merger.merge(sources);

      // Bug: base='default-string' (非数组), overlay=[1,2,3] (数组)
      // applyMerge append 分支：base 不是数组 → 跳过第一个 if
      // 第二个 if：overlay 是数组 → return overlay
      // 结果：默认值被丢弃，但语义上可能应该报错或保留默认值
      expect(result.config.items).toEqual([1, 2, 3]);
    });

    it('CM5: append 策略对 base 数组 + overlay 非数组 → 返回 overlay（覆盖数组）', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          items: {
            mergeStrategy: 'append',
            required: false,
            defaultValue: [0],
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { items: 'not-an-array' }),
      ];

      const result = merger.merge(sources);

      // Bug: base=[0] (数组), overlay='not-an-array' (非数组)
      // applyMerge append 分支：base 是数组但 overlay 不是 → 跳过第一个 if
      // 第二个 if：overlay 不是数组 → 跳过
      // 最后 return overlay
      // 结果：默认数组 [0] 被字符串覆盖
      expect(result.config.items).toBe('not-an-array');
    });

    it('append 策略正确合并两个数组', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.WORKSPACE, 'ws', { tags: ['a', 'b'] }),
        makeSource(CONFIG_PRIORITY.USER, 'user', { tags: ['c', 'd'] }),
      ];

      const result = merger.merge(sources);

      // base=[] (默认), ws 添加 [a,b] → [a,b], user 添加 [c,d] → [a,b,c,d]
      expect(result.config.tags).toEqual(['a', 'b', 'c', 'd']);
    });

    it('CM6: shallow-merge 对 base 数组 + overlay 对象 → 返回 overlay', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          features: {
            mergeStrategy: 'shallow-merge',
            required: false,
            defaultValue: [1, 2, 3],
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { features: { newFeature: true } }),
      ];

      const result = merger.merge(sources);

      // base=[1,2,3] 是数组，overlay={newFeature:true} 是对象
      // shallow-merge 分支：base 是数组 → 条件不满足（!Array.isArray(base)）
      // → return overlay
      expect(result.config.features).toEqual({ newFeature: true });
    });
  });

  describe('CM7: validate 边界', () => {
    it('CM7（已修复）: required=false + value=null 调用 validate 函数', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: {
            mergeStrategy: 'override',
            required: false,
            validate: (v) => v === null || (typeof v === 'number' && v > 0),
            validateMessage: 'port must be null or positive number',
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { port: null }),
      ];

      const result = merger.merge(sources);

      // 修复后：value=null 仍调用 validate 函数
      // validate(null) → null === null → true → 不报错
      expect(result.config.port).toBeNull();
      expect(result.validation.valid).toBe(true);
    });

    it('CM7（已修复）: required=false + value=null + validate 拒绝 null → 报错', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: {
            mergeStrategy: 'override',
            required: false,
            validate: (v) => typeof v === 'number' && v > 0,
            validateMessage: 'port must be positive number',
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { port: null }),
      ];

      const result = merger.merge(sources);

      // 修复后：validate(null) → typeof null === 'object' → false → 报错
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.some((e) => e.path === 'port')).toBe(true);
    });

    it('CM16: value=0 不应误判为缺失', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          count: {
            mergeStrategy: 'override',
            required: true,
            validate: (v) => typeof v === 'number' && v >= 0,
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { count: 0 }),
      ];

      const result = merger.merge(sources);

      // 0 是合法值，不应被误判为缺失
      expect(result.config.count).toBe(0);
      expect(result.validation.valid).toBe(true);
    });

    it('CM16: value=false 不应误判为缺失', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          enabled: {
            mergeStrategy: 'override',
            required: true,
            validate: (v) => typeof v === 'boolean',
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { enabled: false }),
      ];

      const result = merger.merge(sources);

      expect(result.config.enabled).toBe(false);
      expect(result.validation.valid).toBe(true);
    });

    it('CM16: value="" 不应误判为缺失', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          name: {
            mergeStrategy: 'override',
            required: true,
            validate: (v) => typeof v === 'string',
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { name: '' }),
      ];

      const result = merger.merge(sources);

      expect(result.config.name).toBe('');
      expect(result.validation.valid).toBe(true);
    });

    it('CM17（已修复）: validate 函数抛异常时转为 error（不再向上传播）', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: {
            mergeStrategy: 'override',
            required: true,
            validate: () => { throw new Error('validate error'); },
          },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { port: 3000 }),
      ];

      // 修复后：validate 抛异常被捕获，转为 validation error
      const result = merger.merge(sources);
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.some((e) => e.message.includes('validate error'))).toBe(true);
    });
  });

  describe('CM9: priority 非法值排序', () => {
    it('priority 为字符串时排序行为不稳定', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource('300' as any, 'str', { port: 3000 }),
        makeSource(200, 'num', { port: 4000 }),
      ];

      const result = merger.merge(sources);

      // '300' as any - 200 = '300' - 200 = 100 (JS 隐式转换)
      // 200 - '300' = -100
      // 排序：str (300) 在 num (200) 之后
      // 但这是隐式转换，行为可能不稳定
      expect(result.config.port).toBe(3000); // str 优先级更高
    });

    it('priority 为 NaN 时排序完全混乱', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(NaN as any, 'nan', { port: 3000 }),
        makeSource(200, 'num', { port: 4000 }),
      ];

      // NaN - 200 = NaN, 200 - NaN = NaN
      // sort 比较 NaN 永远返回 false，排序结果不确定
      // 但不会抛异常
      const result = merger.merge(sources);
      expect(result.config.port).toBeDefined();
    });

    it('priority 相同时保留原顺序（稳定排序）', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(200, 'first', { port: 3000 }),
        makeSource(200, 'second', { port: 4000 }),
      ];

      const result = merger.merge(sources);

      // 同优先级，sort 稳定 → second 在 first 之后，second 胜出
      expect(result.config.port).toBe(4000);
      const conflict = result.conflicts.find((c) => c.key === 'port');
      expect(conflict).toBeDefined();
      expect(conflict!.winner).toBe('second');
    });
  });

  describe('CM10/CM11/CM12: sources 边界', () => {
    it('CM10: 空 sources 数组返回只含默认值的 config', () => {
      const merger = new ConfigMerger(makeSchema());
      const result = merger.merge([]);

      expect(result.config.tags).toEqual([]);
      expect(result.config.options).toEqual({ verbose: false });
      expect(result.config.features).toEqual({ experimental: false });
      // port 无默认值，不在 config 中
      expect(result.config.port).toBeUndefined();
      // port 是 required，validate 应报错
      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.some((e) => e.path === 'port')).toBe(true);
    });

    it('CM11: source.value 为 number 时 Object.entries 抛异常', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        { priority: 200, name: 'bad', value: 123 as any },
      ];

      // Bug: Object.entries(123) 返回 []（number 没有可枚举属性）
      // 实际不抛异常，但 source 被静默忽略
      expect(() => merger.merge(sources)).not.toThrow();
      const result = merger.merge(sources);
      // config 中只有默认值
      expect(result.config.tags).toEqual([]);
    });

    it('CM11: source.value 为 null 时 Object.entries 抛 TypeError', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        { priority: 200, name: 'bad', value: null as any },
      ];

      // Bug: Object.entries(null) 抛 TypeError
      expect(() => merger.merge(sources)).toThrow(TypeError);
    });

    it('CM11: source.value 为 undefined 时 Object.entries 抛 TypeError', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        { priority: 200, name: 'bad', value: undefined as any },
      ];

      // Bug: Object.entries(undefined) 抛 TypeError
      expect(() => merger.merge(sources)).toThrow(TypeError);
    });

    it('CM11: source.value 为字符串时被静默忽略', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        { priority: 200, name: 'bad', value: 'string' as any },
      ];

      // Object.entries('string') 返回 [['0','s'],['1','t'],...]
      // 每个字符的索引作为 key，字符作为 value
      // Bug: 字符串被错误地当作对象遍历，字符作为字段进入 config
      const result = merger.merge(sources);
      // 'string'[0]='s' → result['0']='s'
      expect(result.config['0']).toBe('s');
    });

    it('CM19: 同名 source 重复出现不报错', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(200, 'same', { port: 3000 }),
        makeSource(300, 'same', { port: 4000 }),
      ];

      const result = merger.merge(sources);

      // 两个同名 source，后者优先级更高，胜出
      expect(result.config.port).toBe(4000);
      // conflicts 中 winner 是 'same'，无法区分是哪个 'same'
      const conflict = result.conflicts.find((c) => c.key === 'port');
      expect(conflict).toBeDefined();
      expect(conflict!.winner).toBe('same');
      expect(conflict!.loser).toBe('previous');
    });
  });

  describe('schema.validate 集成', () => {
    it('schema.validate 返回的错误被合并', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: { mergeStrategy: 'override', required: true },
          host: { mergeStrategy: 'override', required: true },
        },
        validate: (config) => {
          const errors = [];
          if (config.port === 80 && config.host === 'localhost') {
            errors.push({
              path: 'port',
              message: 'port 80 + localhost is reserved',
            });
          }
          return errors;
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(200, 'user', { port: 80, host: 'localhost' }),
      ];

      const result = merger.merge(sources);

      expect(result.validation.valid).toBe(false);
      expect(result.validation.errors.some((e) => e.message.includes('reserved'))).toBe(true);
    });

    it('schema.validate 返回空数组时 valid=true', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: { mergeStrategy: 'override', required: true },
        },
        validate: () => [],
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(200, 'user', { port: 3000 }),
      ];

      const result = merger.merge(sources);
      expect(result.validation.valid).toBe(true);
    });
  });

  describe('CM18: ConfigMerger 可重用', () => {
    it('同一 merger 多次 merge 不互相影响', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources1: ConfigSource[] = [
        makeSource(200, 'user1', { port: 3000 }),
      ];
      const sources2: ConfigSource[] = [
        makeSource(200, 'user2', { port: 4000 }),
      ];

      const result1 = merger.merge(sources1);
      const result2 = merger.merge(sources2);

      expect(result1.config.port).toBe(3000);
      expect(result2.config.port).toBe(4000);
      // result1 不被 result2 影响
      expect(result1.config.port).toBe(3000);
    });
  });

  describe('CM20: conflicts 策略区分', () => {
    it('override 策略报告冲突', () => {
      const schema: ConfigSchema = {
        name: 'test',
        fields: {
          port: { mergeStrategy: 'override', required: true },
        },
      };
      const merger = new ConfigMerger(schema);
      const sources: ConfigSource[] = [
        makeSource(100, 'ws', { port: 8080 }),
        makeSource(200, 'user', { port: 3000 }),
      ];

      const result = merger.merge(sources);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.key).toBe('port');
    });

    it('deep-merge 策略不报告冲突（因为是合并而非覆盖）', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(100, 'ws', { options: { a: 1 } }),
        makeSource(200, 'user', { options: { b: 2 } }),
      ];

      const result = merger.merge(sources);
      // deep-merge 不报冲突
      const optionsConflicts = result.conflicts.filter((c) => c.key === 'options');
      expect(optionsConflicts).toHaveLength(0);
    });

    it('shallow-merge 策略不报告冲突', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(100, 'ws', { features: { a: 1 } }),
        makeSource(200, 'user', { features: { b: 2 } }),
      ];

      const result = merger.merge(sources);
      const featuresConflicts = result.conflicts.filter((c) => c.key === 'features');
      expect(featuresConflicts).toHaveLength(0);
    });

    it('append 策略不报告冲突', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(100, 'ws', { tags: ['a'] }),
        makeSource(200, 'user', { tags: ['b'] }),
      ];

      const result = merger.merge(sources);
      const tagsConflicts = result.conflicts.filter((c) => c.key === 'tags');
      expect(tagsConflicts).toHaveLength(0);
    });
  });

  describe('完整合并流程', () => {
    it('多优先级 source 按优先级排序后合并', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', { port: 3000, tags: ['user'] }),
        makeSource(CONFIG_PRIORITY.WORKSPACE, 'ws', { port: 8080, tags: ['ws'] }),
        makeSource(CONFIG_PRIORITY.ENV, 'env', { tags: ['env'] }),
      ];

      const result = merger.merge(sources);

      // 优先级：ws(100) < user(200) < env(300)
      // port: ws=8080, user=3000 → user 胜（200>100），env 无 port
      // tags: append 所有 → ['ws', 'user', 'env']（按优先级顺序追加）
      expect(result.config.port).toBe(3000);
      expect(result.config.tags).toEqual(['ws', 'user', 'env']);
    });

    it('defaultValue + source 完整合并', () => {
      const merger = new ConfigMerger(makeSchema());
      const sources: ConfigSource[] = [
        makeSource(CONFIG_PRIORITY.USER, 'user', {
          port: 3000,
          tags: ['a'],
          options: { verbose: true },
          features: { fast: true },
        }),
      ];

      const result = merger.merge(sources);

      expect(result.config.port).toBe(3000);
      // tags: 默认 [] + append ['a'] = ['a']
      expect(result.config.tags).toEqual(['a']);
      // options: 默认 {verbose:false} + deep-merge {verbose:true} = {verbose:true}
      expect(result.config.options).toEqual({ verbose: true });
      // features: 默认 {experimental:false} + shallow-merge {fast:true} = {experimental:false, fast:true}
      expect(result.config.features).toEqual({ experimental: false, fast: true });
    });
  });
});
