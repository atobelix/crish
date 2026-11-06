// 锚点测量接缝单测：映射保真与不可用时的静默口径（题 7 透传回归的接缝侧）。
import { measureAnchorRect } from '../anchorMeasure';

describe('measureAnchorRect 锚点测量接缝', () => {
  it('measureInWindow 的 {x,y,width,height} 原样转出，不换算不取整', () => {
    const onRect = jest.fn();
    const node = {
      measureInWindow: (
        cb: (x: number, y: number, width: number, height: number) => void
      ) => cb(98.5, 640.25, 32, 32),
    };
    measureAnchorRect(node, onRect);
    expect(onRect).toHaveBeenCalledTimes(1);
    expect(onRect).toHaveBeenCalledWith({
      x: 98.5,
      y: 640.25,
      width: 32,
      height: 32,
    });
  });

  it('节点缺失 / 无 measureInWindow / 测量抛错时不回调（调用方不开菜单）', () => {
    const onRect = jest.fn();
    measureAnchorRect(null, onRect);
    measureAnchorRect(undefined, onRect);
    measureAnchorRect({}, onRect);
    measureAnchorRect(
      {
        measureInWindow: () => {
          throw new Error('measure unavailable');
        },
      },
      onRect
    );
    expect(onRect).not.toHaveBeenCalled();
  });

  it('零尺寸（未布局完成）不回调', () => {
    const onRect = jest.fn();
    measureAnchorRect(
      {
        measureInWindow: (
          cb: (x: number, y: number, width: number, height: number) => void
        ) => cb(10, 10, 0, 32),
      },
      onRect
    );
    measureAnchorRect(
      {
        measureInWindow: (
          cb: (x: number, y: number, width: number, height: number) => void
        ) => cb(10, 10, 32, 0),
      },
      onRect
    );
    expect(onRect).not.toHaveBeenCalled();
  });
});
