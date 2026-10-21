import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorStore } from './ErrorStore';
import { ToastStore } from './toast/ToastStore';
import {
  readUncaughtWindowNotice,
  reportUncaughtWindowNotice,
} from './uncaughtWindowError';

const FALLBACK = '发生一次未预期的错误';

describe('窗口未捕获异常只走顶部通知', () => {
  beforeEach(() => {
    ToastStore.clear();
    errorStore.resolveByCode('GLOBAL_UNCAUGHT_ERROR');
  });

  afterEach(() => {
    ToastStore.clear();
    errorStore.resolveByCode('GLOBAL_UNCAUGHT_ERROR');
  });

  it('布局观察器回路完成通知不进入通知', () => {
    const notice = readUncaughtWindowNotice(
      'error',
      {
        message:
          'ResizeObserver loop completed with undelivered notifications.',
      },
      FALLBACK
    );
    reportUncaughtWindowNotice(notice);
    expect(notice).toBeNull();
    expect(ToastStore.getToasts()).toHaveLength(0);
  });

  it('布局观察器回路超限不进入通知', () => {
    const notice = readUncaughtWindowNotice(
      'error',
      { message: 'ResizeObserver loop limit exceeded' },
      FALLBACK
    );
    reportUncaughtWindowNotice(notice);
    expect(notice).toBeNull();
    expect(ToastStore.getToasts()).toHaveLength(0);
  });

  it('带前缀的回路文案同样忽略', () => {
    const notice = readUncaughtWindowNotice(
      'unhandledrejection',
      {
        reason: new Error(
          'Uncaught ResizeObserver loop completed with undelivered notifications.'
        ),
      },
      FALLBACK
    );
    expect(notice).toBeNull();
  });

  it('真正的窗口异常进入顶部通知，且不写入全局错误账本', () => {
    const notice = readUncaughtWindowNotice(
      'error',
      {
        message: 'Cannot read properties of null',
        error: new Error('Cannot read properties of null'),
      },
      FALLBACK
    );
    reportUncaughtWindowNotice(notice);
    expect(ToastStore.getToasts()).toHaveLength(1);
    expect(ToastStore.getToasts()[0]?.type).toBe('error');
    expect(ToastStore.getToasts()[0]?.message).toBe(
      'Cannot read properties of null'
    );
    expect(
      errorStore
        .getActiveErrors()
        .some((entry) => entry.code === 'GLOBAL_UNCAUGHT_ERROR')
    ).toBe(false);
  });

  it('未处理的拒绝使用异常消息，同一文案不叠第二条', () => {
    const notice = readUncaughtWindowNotice(
      'unhandledrejection',
      { reason: new Error('保存失败') },
      FALLBACK
    );
    reportUncaughtWindowNotice(notice);
    reportUncaughtWindowNotice(notice);
    expect(ToastStore.getToasts()).toHaveLength(1);
    expect(ToastStore.getToasts()[0]?.message).toBe('保存失败');
  });

  it('没有消息时使用兜底文案', () => {
    const notice = readUncaughtWindowNotice('error', {}, FALLBACK);
    expect(notice?.message).toBe(FALLBACK);
  });
});
