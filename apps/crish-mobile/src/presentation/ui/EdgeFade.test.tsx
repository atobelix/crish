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
