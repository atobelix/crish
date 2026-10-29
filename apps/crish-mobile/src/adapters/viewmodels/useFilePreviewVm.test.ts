// 文件预览视图模型纯函数测试：续读阶梯与错误码状态映射。
import {
  PREVIEW_LINES_HARD_CAP,
  nextLineBudget,
  mapPreviewErrorCode,
} from './useFilePreviewVm';

describe('nextLineBudget（续读阶梯 F4 §4.1）', () => {
  it('400 → 800', () => {
    expect(nextLineBudget(400)).toBe(800);
  });

  it('800 → 1200', () => {
    expect(nextLineBudget(800)).toBe(1200);
  });

  it('1200 → 2000', () => {
    expect(nextLineBudget(1200)).toBe(2000);
  });

  it('2000 → 3000', () => {
    expect(nextLineBudget(2000)).toBe(3000);
  });

  it('3000 → 4000', () => {
    expect(nextLineBudget(3000)).toBe(4000);
  });

  it('4000 → 5000（硬顶）', () => {
    expect(nextLineBudget(4000)).toBe(5000);
  });

  it('已达硬顶时保持不变（不越界）', () => {
    expect(nextLineBudget(5000)).toBe(5000);
    expect(nextLineBudget(9999)).toBe(5000);
  });

  it('低于首档时跳到首档', () => {
    expect(nextLineBudget(0)).toBe(400);
    expect(nextLineBudget(399)).toBe(400);
  });

  it('阶梯严格递增（防配置写错）', () => {
    let prev = 0;
    for (let i = 0; i < 10; i += 1) {
      const next = nextLineBudget(prev);
      expect(next).toBeGreaterThanOrEqual(prev);
      if (next === prev) break;
      prev = next;
    }
    expect(prev).toBe(PREVIEW_LINES_HARD_CAP);
  });
});

describe('mapPreviewErrorCode（错误码 → 占位态）', () => {
  it('file.too_large → too-large', () => {
    expect(mapPreviewErrorCode('file.too_large')).toBe('too-large');
  });

  it('file.binary → binary', () => {
    expect(mapPreviewErrorCode('file.binary')).toBe('binary');
  });

  it('file.encoding → unsupported-encoding', () => {
    expect(mapPreviewErrorCode('file.encoding')).toBe('unsupported-encoding');
  });

  it('未知错误码 → error（可重试）', () => {
    expect(mapPreviewErrorCode('file.not_found')).toBe('error');
    expect(mapPreviewErrorCode('internal')).toBe('error');
  });
});

describe('PREVIEW_LINES_HARD_CAP', () => {
  it('硬顶为 5000（F4-F27）', () => {
    expect(PREVIEW_LINES_HARD_CAP).toBe(5000);
  });
});
