// P3 B5（A5 渲染分层 L3）Canvas 预留接缝单测：注册表注册/注销/查询、
// 默认 DOM 空操作实现、渲染模式判定四象限（readOnly/行数阈值/注册表）。
// 测试环境 node（无 DOM）：工厂 container 参数以占位对象传入（接口仅
// 类型约束，node 环境无真实元素可传）。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CANVAS_LINE_COUNT_THRESHOLD,
  createDomRowSurface,
  getRowSurfaceFactory,
  registerRowSurface,
  unregisterRowSurface,
  resolveRenderMode,
} from '../../src/core/rowSurface';
import type {
  RenderMode,
  RowSurface,
  RowSurfaceItem,
} from '../../src/core/rowSurface';

// node 环境无 HTMLElement——工厂入参仅类型载体，占位对象断言调用链不炸
const fakeContainer = { tagName: 'DIV' } as unknown as HTMLElement;

// 每例前置清理：注册表隔离（测试间互不污染）
beforeEach(() => {
  unregisterRowSurface('dom');
  unregisterRowSurface('canvas');
});

describe('rowSurface 注册表（Canvas 接缝）', () => {
  it('registerRowSurface 后可按模式查询到工厂', () => {
    expect(getRowSurfaceFactory('canvas')).toBeNull();
    const factory = () => createDomRowSurface(fakeContainer);
    registerRowSurface('canvas', factory);
    expect(getRowSurfaceFactory('canvas')).toBe(factory);
  });

  it('重复注册同模式 = 覆盖', () => {
    const f1 = () => createDomRowSurface(fakeContainer);
    const f2 = () => createDomRowSurface(fakeContainer);
    registerRowSurface('canvas', f1);
    registerRowSurface('canvas', f2);
    expect(getRowSurfaceFactory('canvas')).toBe(f2);
  });

  it('unregisterRowSurface 后查询回落 null（注册表回到空态）', () => {
    registerRowSurface('canvas', () => createDomRowSurface(fakeContainer));
    unregisterRowSurface('canvas');
    expect(getRowSurfaceFactory('canvas')).toBeNull();
  });

  it('未注册的任何模式查询均为 null（默认无 canvas 实现）', () => {
    expect(getRowSurfaceFactory('dom')).toBeNull();
    expect(getRowSurfaceFactory('canvas')).toBeNull();
  });

  it('工厂能力检测失败（返回 null）→ 引擎回落 DOM 的契约载体成立', () => {
    // A5 §3.1：能力检测（getContext/字体就绪）失败返回 null → 行粒度回退
    registerRowSurface('canvas', () => null);
    expect(getRowSurfaceFactory('canvas')!(fakeContainer)).toBeNull();
  });
});

describe('默认 DOM 行表面（空操作封装位）', () => {
  it('mode 恒为 dom（Canvas 未启用时行为零变化）', () => {
    const surface = createDomRowSurface(fakeContainer);
    expect(surface.mode).toBe('dom');
  });

  it('mount/update/unmount 三方法可调用且不抛错（空操作）', () => {
    const surface = createDomRowSurface(fakeContainer);
    const items: RowSurfaceItem[] = [
      { index: 0, start: 0, size: 28, key: '0' },
      { index: 1, start: 28, size: 28, key: '1' },
    ];
    expect(() => surface.mountRows(items)).not.toThrow();
    expect(() => surface.updateRows([0, 1])).not.toThrow();
    expect(() => surface.unmountRows([0])).not.toThrow();
  });

  it('locateRow 返回 null（未接管——调用方走既有 HeightMap 定位链路）', () => {
    const surface = createDomRowSurface(fakeContainer);
    expect(surface.locateRow(0)).toBeNull();
    expect(surface.locateRow(123456)).toBeNull();
  });

  it('接口形状：四方法 + mode 字段齐备（类型契约编译期强制）', () => {
    const surface: RowSurface = createDomRowSurface(fakeContainer);
    expect(typeof surface.mountRows).toBe('function');
    expect(typeof surface.updateRows).toBe('function');
    expect(typeof surface.unmountRows).toBe('function');
    expect(typeof surface.locateRow).toBe('function');
    expect(typeof surface.mode).toBe('string');
  });

  it('RenderMode 联合类型：dom | canvas 二值可赋值', () => {
    // 类型级断言（编译期）：任一值必须可赋给 RenderMode
    const modes: RenderMode[] = ['dom', 'canvas'];
    expect(modes).toEqual(['dom', 'canvas']);
  });
});

describe('resolveRenderMode 触发条件登记（readOnly && 阈值 && 注册表）', () => {
  it('readOnly=false（编辑器模式）→ 恒 dom，即使注册与超阈值', () => {
    registerRowSurface('canvas', () => createDomRowSurface(fakeContainer));
    expect(
      resolveRenderMode({
        readOnly: false,
        lineCount: CANVAS_LINE_COUNT_THRESHOLD + 1,
      })
    ).toBe('dom');
  });

  it('readOnly=true 但行数不足阈值 → dom', () => {
    registerRowSurface('canvas', () => createDomRowSurface(fakeContainer));
    expect(
      resolveRenderMode({
        readOnly: true,
        lineCount: CANVAS_LINE_COUNT_THRESHOLD - 1,
      })
    ).toBe('dom');
  });

  it('readOnly=true + 超阈值但注册表无 canvas → dom（DOM 回退兜底）', () => {
    expect(
      resolveRenderMode({
        readOnly: true,
        lineCount: CANVAS_LINE_COUNT_THRESHOLD + 1,
      })
    ).toBe('dom');
  });

  it('readOnly=true + 超阈值 + canvas 已注册 → canvas', () => {
    registerRowSurface('canvas', () => createDomRowSurface(fakeContainer));
    expect(
      resolveRenderMode({
        readOnly: true,
        lineCount: CANVAS_LINE_COUNT_THRESHOLD,
      })
    ).toBe('canvas');
  });

  it('阈值可配置（threshold 覆盖缺省 5 万行）', () => {
    registerRowSurface('canvas', () => createDomRowSurface(fakeContainer));
    // 自定义阈值 100：行数 500 即超阈值 → canvas
    expect(
      resolveRenderMode({ readOnly: true, lineCount: 500, threshold: 100 })
    ).toBe('canvas');
    // 同配置下行数不足自定义阈值 → dom
    expect(
      resolveRenderMode({ readOnly: true, lineCount: 99, threshold: 100 })
    ).toBe('dom');
  });

  it('缺省阈值常量为 5 万行（A5 §3.1 建议 ≥5 万行）', () => {
    expect(CANVAS_LINE_COUNT_THRESHOLD).toBe(50_000);
  });
});
