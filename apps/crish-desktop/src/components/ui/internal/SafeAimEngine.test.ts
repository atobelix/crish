// @vitest-environment jsdom
/**
 * ui/internal/SafeAimEngine 核心测试
 * 覆盖 Singleton、SVG Overlay 初始化、4 帧历史追踪、重心坐标判定、4向包围盒生成与销毁
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SafeAimEngine } from './SafeAimEngine';

describe('SafeAimEngine 轨迹保护引擎', () => {
  let engine: SafeAimEngine;

  beforeEach(() => {
    // 清理已存在的 overlay DOM
    const oldOverlay = document.getElementById('sepSafeAimOverlay');
    if (oldOverlay) oldOverlay.remove();
    engine = SafeAimEngine.getInstance();
    engine.initSvgOverlay();
  });

  afterEach(() => {
    engine.clearSubmenu();
    engine.destroy();
  });

  it('单例模式正确返回同实例并更新配置', () => {
    const inst1 = SafeAimEngine.getInstance();
    const inst2 = SafeAimEngine.getInstance({ debug: true, enabled: false });
    expect(inst1).toBe(inst2);
    expect(inst1.debug).toBe(true);
    expect(inst1.enabled).toBe(false);

    // 恢复
    SafeAimEngine.getInstance({ enabled: true, debug: false });
  });

  it('DOM 虚拟 SVG 碰撞层 #sepSafeAimOverlay 正确初始化', () => {
    const svg = document.getElementById('sepSafeAimOverlay');
    expect(svg).not.toBeNull();
    expect(svg?.classList.contains('sep-safe-aim-overlay')).toBe(true);
    const poly = svg?.querySelector('polygon');
    expect(poly).not.toBeNull();
  });

  it('调试模式 setDebug 动态切换 CSS 修饰类', () => {
    const svg = document.getElementById('sepSafeAimOverlay');
    engine.setDebug(true);
    expect(svg?.classList.contains('sep-debug-visible')).toBe(true);
    engine.setDebug(false);
    expect(svg?.classList.contains('sep-debug-visible')).toBe(false);
  });

  it('鼠标轨迹历史最多保留 4 帧队列', () => {
    engine.onMouseMove({ clientX: 10, clientY: 10 });
    engine.onMouseMove({ clientX: 20, clientY: 20 });
    engine.onMouseMove({ clientX: 30, clientY: 30 });
    engine.onMouseMove({ clientX: 40, clientY: 40 });
    engine.onMouseMove({ clientX: 50, clientY: 50 });

    expect(engine.getRecentMousePos()).toEqual({ x: 50, y: 50 });
    expect(engine.getPreviousMousePos()).toEqual({ x: 20, y: 20 });
  });

  it('重心坐标系 (Barycentric Coordinates) 精确判定三角形内部与外部点', () => {
    const a = { x: 0, y: 50 };
    const b = { x: 100, y: 0 };
    const c = { x: 100, y: 100 };

    // 中心点严格在内部
    expect(engine.pointInTriangle({ x: 50, y: 50 }, a, b, c)).toBe(true);

    // 顶点与边界点在容差范围内判定为内部
    expect(engine.pointInTriangle({ x: 0, y: 50 }, a, b, c)).toBe(true);
    expect(engine.pointInTriangle({ x: 100, y: 0 }, a, b, c)).toBe(true);
    expect(engine.pointInTriangle({ x: 100, y: 100 }, a, b, c)).toBe(true);
    expect(engine.pointInTriangle({ x: 50, y: 25 }, a, b, c)).toBe(true);

    // 外部点判定为不在内部
    expect(engine.pointInTriangle({ x: 10, y: 0 }, a, b, c)).toBe(false);
    expect(engine.pointInTriangle({ x: 150, y: 50 }, a, b, c)).toBe(false);
    expect(engine.pointInTriangle({ x: -10, y: 50 }, a, b, c)).toBe(false);
  });

  it('setPolygonPoints 动态写入 SVG polygon 属性', () => {
    engine.setPolygonPoints({ x: 10, y: 20 }, { x: 100, y: 50 }, { x: 100, y: 200 });
    const poly = document.querySelector('#sepSafeAimOverlay polygon');
    expect(poly?.getAttribute('points')).toBe('10,20 100,50 100,200');

    engine.clearPolygon();
    expect(poly?.getAttribute('points')).toBeNull();
  });

  it('setSubmenu 关联子菜单并在鼠标移动时动态更新安全多边形', () => {
    const trigger = document.createElement('button');
    const submenu = document.createElement('div');
    document.body.appendChild(trigger);
    document.body.appendChild(submenu);

    submenu.getBoundingClientRect = () => ({
      left: 200,
      top: 100,
      right: 350,
      bottom: 300,
      width: 150,
      height: 200,
      x: 200,
      y: 100,
      toJSON: () => {},
    });

    engine.setSubmenu(trigger, submenu, 'right');
    engine.onMouseMove({ clientX: 50, clientY: 150 });

    const poly = document.querySelector('#sepSafeAimOverlay polygon');
    expect(poly?.getAttribute('points')).toBe('50,150 200,100 200,300');

    // 判定安全区
    expect(engine.isPointerInSafeZone({ x: 100, y: 150 })).toBe(true);
    expect(engine.isPointerInSafeZone({ x: 10, y: 10 })).toBe(false);

    trigger.remove();
    submenu.remove();
  });

  it('支持 left 方位子菜单 Safe-Aim 保护区', () => {
    const trigger = document.createElement('button');
    const submenu = document.createElement('div');
    document.body.appendChild(trigger);
    document.body.appendChild(submenu);

    submenu.getBoundingClientRect = () => ({
      left: 50,
      top: 100,
      right: 150,
      bottom: 300,
      width: 100,
      height: 200,
      x: 50,
      y: 100,
      toJSON: () => {},
    });

    engine.setSubmenu(trigger, submenu, 'left');
    engine.onMouseMove({ clientX: 250, clientY: 150 });

    const poly = document.querySelector('#sepSafeAimOverlay polygon');
    expect(poly?.getAttribute('points')).toBe('250,150 150,100 150,300');

    trigger.remove();
    submenu.remove();
  });
});
