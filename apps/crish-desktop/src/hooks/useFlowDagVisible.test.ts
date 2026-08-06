// @vitest-environment jsdom
/**
 * useFlowDagVisible 功能开关测试（T-D-12 前端侧，DAG-2）。
 *
 * 覆盖点（对齐 layoutTreeStore 直读先例语义）：
 * - 'true' / '1' → 开；
 * - 'false' / '0' / 缺失 / 脏值 → 关（安全默认）；
 * - localStorage 读取抛异常 → 关（不崩）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLOW_DAG_VISIBLE_KEY,
  useFlowDagVisible,
} from './useFlowDagVisible';

afterEach(() => {
  localStorage.removeItem(FLOW_DAG_VISIBLE_KEY);
});

describe('useFlowDagVisible', () => {
  it("键缺失（默认关）→ false", () => {
    expect(useFlowDagVisible()).toBe(false);
  });

  it("'true' → 开", () => {
    localStorage.setItem(FLOW_DAG_VISIBLE_KEY, 'true');
    expect(useFlowDagVisible()).toBe(true);
  });

  it("'1' → 开（兼容数字形态）", () => {
    localStorage.setItem(FLOW_DAG_VISIBLE_KEY, '1');
    expect(useFlowDagVisible()).toBe(true);
  });

  it("'false' / '0' → 关", () => {
    localStorage.setItem(FLOW_DAG_VISIBLE_KEY, 'false');
    expect(useFlowDagVisible()).toBe(false);
    localStorage.setItem(FLOW_DAG_VISIBLE_KEY, '0');
    expect(useFlowDagVisible()).toBe(false);
  });

  it("脏值（'yes' / 'TRUE' / '1 '）→ 关（安全默认）", () => {
    localStorage.setItem(FLOW_DAG_VISIBLE_KEY, 'yes');
    expect(useFlowDagVisible()).toBe(false);
    localStorage.setItem(FLOW_DAG_VISIBLE_KEY, 'TRUE');
    expect(useFlowDagVisible()).toBe(false);
    localStorage.setItem(FLOW_DAG_VISIBLE_KEY, '1 ');
    expect(useFlowDagVisible()).toBe(false);
  });

  it('localStorage 读取抛异常 → 关（不崩）', () => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('blocked');
    };
    try {
      expect(useFlowDagVisible()).toBe(false);
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  });
});
