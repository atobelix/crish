// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/markdown/markdownG2Shapes.test.ts
 *
 * Markdown G² 形状适配器单测：半径解析、单面应用、整根同步（含 RO 重算、
 * 失联解绑、dispose）。不渲染 MarkdownSurface——接线由 tsc + 既有
 * MarkdownSurface.test.tsx 覆盖；此处以真实 DOM 树测适配器本身。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cornerClipPath,
  setCornerScheme,
} from '../../utils/cornerPath';
import {
  ResizeObserverManager,
  type ResizeCallback,
} from '../../utils/ResizeObserverManager';
import {
  applyG2ShapeToElement,
  MarkdownG2ShapeSync,
  MARKDOWN_G2_SHAPE_SELECTORS,
  resolveElementRadii,
} from './markdownG2Shapes';

/** 给元素装一个可改写的 getBoundingClientRect（jsdom 恒返回 0 尺寸） */
function setRect(el: HTMLElement, w: number, h: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: w,
    height: h,
    top: 0,
    left: 0,
    right: w,
    bottom: h,
    toJSON: () => ({}),
  } as DOMRect);
}

function makeEl(tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  return el;
}

const syncs: MarkdownG2ShapeSync[] = [];
function track(sync: MarkdownG2ShapeSync): MarkdownG2ShapeSync {
  syncs.push(sync);
  return sync;
}

afterEach(() => {
  for (const sync of syncs.splice(0)) sync.dispose();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  // 双方案选择点是模块级状态：每例后复位默认 'g2'，防跨例污染
  setCornerScheme('g2');
});

describe('resolveElementRadii', () => {
  it.each([
    ['8px', { tl: 8, tr: 8, br: 8, bl: 8 }],
    ['0px 6px 6px 0px', { tl: 0, tr: 6, br: 6, bl: 0 }],
    ['6px 6px', { tl: 6, tr: 6, br: 6, bl: 6 }],
    ['6px 8px 10px', { tl: 6, tr: 8, br: 10, bl: 8 }],
    ['6px 8px 10px 12px', { tl: 6, tr: 8, br: 10, bl: 12 }],
    ['6.5px', { tl: 6.5, tr: 6.5, br: 6.5, bl: 6.5 }],
    ['8px / 4px', { tl: 8, tr: 8, br: 8, bl: 8 }],
  ])('解析 %s', (input, expected) => {
    const el = makeEl();
    el.style.borderRadius = input;
    expect(resolveElementRadii(el)).toEqual(expected);
  });

  it.each([['0px'], [''], ['50%'], ['6px 50%'], ['var(--radius-m)']])(
    '不塑造：%s',
    (input) => {
      const el = makeEl();
      el.style.borderRadius = input;
      expect(resolveElementRadii(el)).toBeNull();
    }
  );
});

describe('applyG2ShapeToElement', () => {
  it('实测尺寸 + computed 半径生成同路径 clip-path', () => {
    const el = makeEl();
    el.style.borderRadius = '8px';
    setRect(el, 800, 200);
    const path = applyG2ShapeToElement(el);
    expect(path).toBe(cornerClipPath(800, 200, 8));
    expect(el.style.clipPath).toBe(cornerClipPath(800, 200, 8));
  });

  it('分角面按逐角半径生成', () => {
    const el = makeEl('blockquote');
    el.style.borderRadius = '0px 6px 6px 0px';
    setRect(el, 400, 100);
    applyG2ShapeToElement(el);
    expect(el.style.clipPath).toBe(
      cornerClipPath(400, 100, { tl: 0, tr: 6, br: 6, bl: 0 })
    );
  });

  it('方案经真源选择点：切到 concentric 后生成同心圆弧 clip-path', () => {
    const el = makeEl();
    el.style.borderRadius = '8px';
    setRect(el, 800, 200);
    // 默认 'g2'：与既有无方案调用逐字一致（零变化基线）
    expect(applyG2ShapeToElement(el)).toBe(cornerClipPath(800, 200, 8));
    setCornerScheme('concentric');
    try {
      const arc = applyG2ShapeToElement(el);
      expect(arc).toBe(cornerClipPath(800, 200, 8, undefined, 'concentric'));
      // 对照必须显式钉 'g2'：无方案调用此刻跟随已翻转的选择点，同为 concentric
      expect(arc).not.toBe(cornerClipPath(800, 200, 8, undefined, 'g2'));
      expect(el.style.clipPath).toBe(arc);
    } finally {
      setCornerScheme('g2');
    }
  });

  it('尺寸为 0 时不塑造并清除旧 clip-path', () => {
    const el = makeEl();
    el.style.borderRadius = '8px';
    el.style.clipPath = "path('M0 0H10V10H0Z')";
    setRect(el, 0, 0);
    expect(applyG2ShapeToElement(el)).toBe('');
    expect(el.style.clipPath).toBe('');
  });

  it('无半径时不塑造', () => {
    const el = makeEl();
    setRect(el, 100, 50);
    expect(applyG2ShapeToElement(el)).toBe('');
    expect(el.style.clipPath).toBe('');
  });
});

describe('MarkdownG2ShapeSync', () => {
  function buildRoot(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'md-rendered';
    root.innerHTML = `
      <div class="md-code-block"><pre class="md-code-pre"><code>x</code></pre></div>
      <div class="md-table-wrap"><table><tr><td>c</td></tr></table></div>
      <div class="md-callout"><div class="md-callout-title">T</div></div>
      <details><summary>S</summary><p>b</p></details>
      <div class="md-math-block">x^2</div>
      <blockquote>q</blockquote>
      <ul><li class="md-task-item"><input class="md-task-checkbox" type="checkbox" />task</li></ul>
      <p>press <kbd>Ctrl</kbd> and <code>inline()</code> and <mark>hl</mark></p>
      <div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">ts</span><button class="md-code-copy">c</button><button class="md-code-wrap">w</button><button class="md-code-fold">f</button></div></div>
      <p><img class="md-img" alt="" /></p>
    `;
    document.body.appendChild(root);
    // 以内联 border-radius 模拟排版层样式表（jsdom 不加载应用 CSS）
    const radii: Array<[string, string]> = [
      ['.md-code-block', '8px'],
      ['.md-table-wrap', '8px'],
      ['.md-callout', '8px'],
      ['details', '8px'],
      ['.md-math-block', '8px'],
      ['blockquote', '0px 6px 6px 0px'],
      ['.md-task-checkbox', '6px'],
      ['kbd', '6px'],
      ['.md-code-lang', '6px'],
      ['.md-code-copy', '6px'],
      ['.md-code-wrap', '6px'],
      ['.md-code-fold', '6px'],
      ['img', '16px'],
      ['code', '6px'],
      ['mark', '6px'],
    ];
    for (const [selector, radius] of radii) {
      root
        .querySelectorAll<HTMLElement>(selector)
        .forEach((el) => {
          el.style.borderRadius = radius;
          setRect(el, 640, 120);
        });
    }
    return root;
  }

  it('选择器表覆盖全部适配面（11 条，无重复）', () => {
    expect(MARKDOWN_G2_SHAPE_SELECTORS).toHaveLength(11);
    expect(new Set(MARKDOWN_G2_SHAPE_SELECTORS).size).toBe(11);
  });

  it('整根同步：适配面挂 G² clip-path，行内码/mark 不动', () => {
    const root = buildRoot();
    const sync = track(new MarkdownG2ShapeSync());
    sync.sync(root);

    const adapted = [
      '.md-code-block',
      '.md-table-wrap',
      '.md-callout',
      'details',
      '.md-math-block',
      'blockquote',
      '.md-task-checkbox',
      'kbd',
      '.md-code-lang',
      '.md-code-copy',
      '.md-code-wrap',
      '.md-code-fold',
      'img',
    ];
    for (const selector of adapted) {
      root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        expect(el.style.clipPath, selector).not.toBe('');
        expect(el.style.clipPath.startsWith("path('M")).toBe(true);
      });
    }
    // 行内码 / mark：形状差 <0.3px 且多行分片，不纳入
    root.querySelectorAll<HTMLElement>('code, mark').forEach((el) => {
      expect(el.style.clipPath).toBe('');
    });
    // 引用块分角：左 0 右 6
    const quote = root.querySelector<HTMLElement>('blockquote')!;
    expect(quote.style.clipPath).toBe(
      cornerClipPath(640, 120, { tl: 0, tr: 6, br: 6, bl: 0 })
    );
    // 图片 R16
    const img = root.querySelector<HTMLElement>('img')!;
    expect(img.style.clipPath).toBe(cornerClipPath(640, 120, 16));
  });

  it('sync 幂等：重复同步不改写已落定的 clip-path', () => {
    const root = buildRoot();
    const sync = track(new MarkdownG2ShapeSync());
    sync.sync(root);
    const block = root.querySelector<HTMLElement>('.md-code-block')!;
    const first = block.style.clipPath;
    sync.sync(root);
    expect(block.style.clipPath).toBe(first);
  });

  it('方案切换：尺寸不变时 sync 也按新方案重算（方案记入面状态）', () => {
    const root = buildRoot();
    const sync = track(new MarkdownG2ShapeSync());
    sync.sync(root);
    const block = root.querySelector<HTMLElement>('.md-code-block')!;
    expect(block.style.clipPath).toBe(cornerClipPath(640, 120, 8));
    setCornerScheme('concentric');
    try {
      sync.sync(root);
      expect(block.style.clipPath).toBe(
        cornerClipPath(640, 120, 8, undefined, 'concentric')
      );
      // 幂等保持：同方案重复同步不改写
      sync.sync(root);
      expect(block.style.clipPath).toBe(
        cornerClipPath(640, 120, 8, undefined, 'concentric')
      );
      // 图片面 R16 同步换形（全根跟随，不只单面）
      const img = root.querySelector<HTMLElement>('img')!;
      expect(img.style.clipPath).toBe(
        cornerClipPath(640, 120, 16, undefined, 'concentric')
      );
    } finally {
      setCornerScheme('g2');
    }
  });

  // RO 回调测试不走 ControllableResizeObserver.triggerResize：test-setup 的
  // beforeEach 会 clearAll()，把 ResizeObserverManager 单例的内部 RO 从
  // activeObservers 驱逐，此后 triggerResize 再也送不到管理器（生产环境无
  // clearAll，不受影响；管理器的投递本身由 test-setup.test.ts 覆盖）。
  // 此处改为在管理器 observe 上抓回调并直接调用——断言的是本适配器的
  // 注册与回调行为（重算/阈值/解绑），投递链不在此重复验证。
  function captureCallback(
    calls: ReadonlyArray<readonly [Element, ResizeCallback, ...unknown[]]>,
    el: Element
  ): ResizeCallback {
    const found = calls.find(([target]) => target === el);
    expect(found, '适配器应在 sync 时向管理器注册该面').toBeDefined();
    return (found as readonly [Element, ResizeCallback, ...unknown[]])[1];
  }

  it('尺寸变化经 RO 回调重算 clip-path', () => {
    const root = buildRoot();
    const manager = ResizeObserverManager.getInstance();
    const observeSpy = vi.spyOn(manager, 'observe');
    const sync = track(new MarkdownG2ShapeSync());
    sync.sync(root);
    const block = root.querySelector<HTMLElement>('.md-code-block')!;
    expect(block.style.clipPath).toBe(cornerClipPath(640, 120, 8));
    const cb = captureCallback(observeSpy.mock.calls, block);

    setRect(block, 800, 240);
    cb({ target: block } as ResizeObserverEntry);
    expect(block.style.clipPath).toBe(cornerClipPath(800, 240, 8));
  });

  it('0.5px 内抖动不重算，超阈重算（正对照证明回调通路有效）', () => {
    const root = buildRoot();
    const manager = ResizeObserverManager.getInstance();
    const observeSpy = vi.spyOn(manager, 'observe');
    const sync = track(new MarkdownG2ShapeSync());
    sync.sync(root);
    const block = root.querySelector<HTMLElement>('.md-code-block')!;
    const cb = captureCallback(observeSpy.mock.calls, block);

    setRect(block, 640.4, 120.2);
    cb({ target: block } as ResizeObserverEntry);
    expect(block.style.clipPath).toBe(cornerClipPath(640, 120, 8));

    setRect(block, 650, 130);
    cb({ target: block } as ResizeObserverEntry);
    expect(block.style.clipPath).toBe(cornerClipPath(650, 130, 8));
  });

  it('失联面（补丁移除）在下次同步向管理器解绑', () => {
    const root = buildRoot();
    const manager = ResizeObserverManager.getInstance();
    const unobserveSpy = vi.spyOn(manager, 'unobserve');
    const sync = track(new MarkdownG2ShapeSync());
    sync.sync(root);
    const block = root.querySelector<HTMLElement>('.md-code-block')!;
    block.remove();
    sync.sync(root);
    expect(unobserveSpy).toHaveBeenCalledWith(block, expect.any(Function));
  });

  it('dispose 向管理器解绑全部已观测面', () => {
    const root = buildRoot();
    const manager = ResizeObserverManager.getInstance();
    const unobserveSpy = vi.spyOn(manager, 'unobserve');
    const sync = track(new MarkdownG2ShapeSync());
    sync.sync(root);
    const blocks = Array.from(
      root.querySelectorAll<HTMLElement>('.md-code-block')
    );
    expect(blocks.length).toBeGreaterThan(0);
    sync.dispose();
    for (const el of blocks) {
      expect(unobserveSpy).toHaveBeenCalledWith(el, expect.any(Function));
    }
  });
});
