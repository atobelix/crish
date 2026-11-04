import { render } from '@testing-library/react-native';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { EdgeFade } from './EdgeFade';

function findNode(
  node: ReactTestRendererJSON | string | null,
  predicate: (n: ReactTestRendererJSON) => boolean
): ReactTestRendererJSON | null {
  if (!node || typeof node === 'string') return null;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const res = findNode(child, predicate);
    if (res) return res;
  }
  return null;
}

describe('EdgeFade - 紧凑化与动态渐变锚定（方案 16 钉案）', () => {
  it('底部 EdgeFade 默认羽化跨度收窄至 36dp，避免最后一行文字泛白模糊', async () => {
    const view = await render(<EdgeFade side="bottom" height={120} />);
    const json = view.toJSON() as ReactTestRendererJSON;
    const gradient = findNode(
      json,
      (n) => n.props?.x1 === '0' && n.props?.y1 !== undefined
    );
    expect(gradient).toBeTruthy();
    // height = 120, span = 36 -> y1 = 120 - 36 = 84, y2 = 120
    expect(gradient?.props.y1).toBe(84);
    expect(gradient?.props.y2).toBe(120);
  });

  it('顶部 EdgeFade 默认羽化跨度保持 95dp 原型四段过渡', async () => {
    const view = await render(<EdgeFade side="top" height={120} />);
    const json = view.toJSON() as ReactTestRendererJSON;
    const gradient = findNode(
      json,
      (n) => n.props?.x1 === '0' && n.props?.y1 !== undefined
    );
    expect(gradient).toBeTruthy();
    // height = 120, span = 95 -> y1 = 0, y2 = 95
    expect(gradient?.props.y1).toBe(0);
    expect(gradient?.props.y2).toBe(95);
  });

  it('支持传入自定义 fadeSpan 覆盖默认跨度', async () => {
    const view = await render(
      <EdgeFade side="bottom" height={100} fadeSpan={24} />
    );
    const json = view.toJSON() as ReactTestRendererJSON;
    const gradient = findNode(
      json,
      (n) => n.props?.x1 === '0' && n.props?.y1 !== undefined
    );
    expect(gradient).toBeTruthy();
    expect(gradient?.props.y1).toBe(76);
    expect(gradient?.props.y2).toBe(100);
  });

  it('高度小于羽化跨度时自适应钳制（span = height）', async () => {
    const view = await render(<EdgeFade side="bottom" height={20} />);
    const json = view.toJSON() as ReactTestRendererJSON;
    const gradient = findNode(
      json,
      (n) => n.props?.x1 === '0' && n.props?.y1 !== undefined
    );
    expect(gradient).toBeTruthy();
    expect(gradient?.props.y1).toBe(0);
    expect(gradient?.props.y2).toBe(20);
  });
});

describe('EdgeFade - Reanimated 共享值驱动 120fps 动态贴合（方案 19）', () => {
  it('传入 keyboardHeightSV 时，底部羽化高度实时跟随 baseHeight + 键盘高度微秒级贴合', async () => {
    const kbSV = { value: 300 };
    const view = await render(
      <EdgeFade side="bottom" baseHeight={120} keyboardHeightSV={kbSV as any} />
    );
    const json = view.toJSON() as ReactTestRendererJSON;
    // 根节点为 Animated.View，包含了动态 height 计算样式
    const style = Array.isArray(json?.props?.style)
      ? Object.assign({}, ...json.props.style)
      : json?.props?.style;
    expect(style.height).toBe(420); // 120 + 300

    // 内部顶缘羽化条带 SVG 的 height 始终锁定为 FADE_SPAN_BOTTOM (36dp)
    const svg = findNode(
      json,
      (n) => n.type === 'RNSVGSvgView' || n.type === 'svg'
    );
    expect(svg?.props.height).toBe(36);
  });

  it('键盘收起时（keyboardHeightSV 从 300 降为 0），底部羽化高度无级回退至 baseHeight', async () => {
    const kbSV = { value: 0 };
    const view = await render(
      <EdgeFade side="bottom" baseHeight={138} keyboardHeightSV={kbSV as any} />
    );
    const json = view.toJSON() as ReactTestRendererJSON;
    const style = Array.isArray(json?.props?.style)
      ? Object.assign({}, ...json.props.style)
      : json?.props?.style;
    expect(style.height).toBe(138); // 138 + 0
  });

  it('同时支持 animatedAdditionalHeight 别名与负数键盘值安全处理', async () => {
    const kbSV = { value: -336 };
    const view = await render(
      <EdgeFade
        side="bottom"
        baseHeight={100}
        animatedAdditionalHeight={kbSV as any}
      />
    );
    const json = view.toJSON() as ReactTestRendererJSON;
    const style = Array.isArray(json?.props?.style)
      ? Object.assign({}, ...json.props.style)
      : json?.props?.style;
    expect(style.height).toBe(436); // 100 + |-336|
  });
});
