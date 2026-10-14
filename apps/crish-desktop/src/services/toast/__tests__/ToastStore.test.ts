import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CrishError } from '@crish/shared-types';
import type { UserVisibleError } from '../../../utils/error-translation';
import { ToastStore } from '../ToastStore';
import { toast } from '../toast';

describe('ToastStore & toast 命令式门面单元测试', () => {
  beforeEach(() => {
    ToastStore.clear();
  });

  afterEach(() => {
    ToastStore.clear();
    vi.restoreAllMocks();
  });

  it('初始状态下 toasts 列表为空', () => {
    expect(ToastStore.getToasts()).toHaveLength(0);
  });

  it('调用 show / error / warning / info 成功入队并生成正确属性', () => {
    const id1 = toast.error('读取配置文件失败');
    const id2 = toast.warning('网络连接较弱');
    const id3 = toast.info('已分叉: 会话A', { onUndo: () => {} });

    const list = ToastStore.getToasts();
    expect(list).toHaveLength(3);
    // 最新入队的处于首位 (index 0 是最新)
    expect(list[0]?.id).toBe(id3);
    expect(list[0]?.type).toBe('info');
    expect(list[0]?.onUndo).toBeDefined();

    expect(list[1]?.id).toBe(id2);
    expect(list[1]?.type).toBe('warning');

    expect(list[2]?.id).toBe(id1);
    expect(list[2]?.type).toBe('error');
    expect(list[2]?.ariaLive).toBe('assertive');
  });

  it('toast.loading 生成无限生命周期 duration: Infinity 的通知', () => {
    const id = toast.loading('正在导出工作区配置...');
    const list = ToastStore.getToasts();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(id);
    expect(list[0]?.type).toBe('loading');
    expect(list[0]?.duration).toBe(Infinity);
  });

  it('toast.promise 成功决议时无缝流转为 success 通知', async () => {
    const deferred = Promise.resolve({ fileName: 'workspace.zip' });
    const resultPromise = toast.promise(deferred, {
      loading: '导出中...',
      success: (data) => `导出成功: ${data.fileName}`,
      error: '导出失败',
    });

    // 初始处于 loading 态
    let list = ToastStore.getToasts();
    expect(list).toHaveLength(1);
    expect(list[0]?.type).toBe('loading');

    const result = await resultPromise;
    expect(result).toEqual({ fileName: 'workspace.zip' });

    list = ToastStore.getToasts();
    expect(list).toHaveLength(1);
    expect(list[0]?.type).toBe('success');
    expect(list[0]?.message).toBe('导出成功: workspace.zip');
    expect(list[0]?.duration).toBeGreaterThan(0);
    expect(list[0]?.duration).not.toBe(Infinity);
  });

  it('toast.promise 异常拒绝时流转为 error 通知并向上抛出异常', async () => {
    const deferred = Promise.reject(new Error('磁盘空间不足'));
    const resultPromise = toast.promise(deferred, {
      loading: '写入中...',
      success: '写入成功',
      error: (err) => `写入异常: ${(err as Error).message}`,
    });

    await expect(resultPromise).rejects.toThrow('磁盘空间不足');

    const list = ToastStore.getToasts();
    expect(list).toHaveLength(1);
    expect(list[0]?.type).toBe('error');
    expect(list[0]?.message).toBe('写入异常: 磁盘空间不足');
  });

  it('dismiss(id) 移除指定条目并触发 onDismiss 回调', () => {
    const onDismiss = vi.fn();
    const id = toast.error('网络超时', { onDismiss });
    expect(ToastStore.getToasts()).toHaveLength(1);

    toast.dismiss(id);
    expect(ToastStore.getToasts()).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss() / clear() 清空全部通知并触发全部回调', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    toast.error('错误1', { onDismiss: cb1 });
    toast.error('错误2', { onDismiss: cb2 });

    expect(ToastStore.getToasts()).toHaveLength(2);
    toast.clear();
    expect(ToastStore.getToasts()).toHaveLength(0);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('同文案重复触发时进行去重 (dedupe) 并刷新 updateKey 与 TTL', () => {
    const id1 = toast.error('重复错误');
    const firstList = ToastStore.getToasts();
    const firstUpdateKey = firstList[0]?.updateKey;

    // 再次触发相同文案
    const id2 = toast.error('重复错误');
    const secondList = ToastStore.getToasts();
    expect(secondList).toHaveLength(1);
    expect(secondList[0]?.id).toBe(id1);
    expect(secondList[0]?.updateKey).toBeGreaterThanOrEqual(firstUpdateKey!);
  });

  it('超出 maxQueue 上限时自动挤出最旧条目 (FIFO)', () => {
    toast.error('错误 1');
    toast.error('错误 2');
    toast.error('错误 3');
    expect(ToastStore.getToasts()).toHaveLength(3);

    // 第 4 条入队，最旧的「错误 1」应被淘汰
    toast.error('错误 4');
    const list = ToastStore.getToasts();
    expect(list).toHaveLength(3);
    expect(list[0]?.message).toBe('错误 4');
    expect(list.some((t) => t.message === '错误 1')).toBe(false);
  });

  it('无 onUndo 的禁令文案被策略门禁静默 drop', () => {
    toast.show('已复制');
    expect(ToastStore.getToasts()).toHaveLength(0);

    toast.show('已保存');
    expect(ToastStore.getToasts()).toHaveLength(0);

    // 带 onUndo 允许放行
    toast.show('已分叉: 会话B', { onUndo: () => {} });
    expect(ToastStore.getToasts()).toHaveLength(1);
  });

  it('订阅者监听机制：状态改变时通知监听器，注销后不再通知', () => {
    const listener = vi.fn();
    const unsubscribe = ToastStore.subscribe(listener);

    toast.error('新通知');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    toast.error('另一条通知');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe('结构化错误消费与多语言语义解析 (Round 11 / Wave 2 升级)', () => {
    it('ToastStore.showError 原生消费 CrishError (permanent 严重错误)', () => {
      const err = new CrishError(
        'API key invalid',
        'provider.auth',
        'permanent',
        false,
        undefined,
        { public: true, action: 'Please check the API key in Settings.' }
      );

      const id = ToastStore.showError(err);
      const list = ToastStore.getToasts();

      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(id);
      expect(list[0]?.type).toBe('error');
      expect(list[0]?.ariaLive).toBe('assertive');
      expect(list[0]?.title).toBe('Authentication failed');
      expect(list[0]?.message).toBe('API key invalid');
      expect(list[0]?.description).toBe(
        'Please check the API key in Settings.'
      );
    });

    it('toast.error 重载消费 CrishError (transient 可重试错误，自动映射 warning)', () => {
      const err = new CrishError(
        'Service timeout',
        'provider.network',
        'transient',
        true
      );

      const id = toast.error(err);
      const list = ToastStore.getToasts();

      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(id);
      expect(list[0]?.type).toBe('warning');
      expect(list[0]?.ariaLive).toBe('polite');
      expect(list[0]?.title).toBe('Network error');
      expect(list[0]?.message).toBe('Service timeout');
      expect(list[0]?.description).toBe(
        'Service is temporarily unavailable. Please try again later.'
      );
    });

    it('静默错误与非 public 错误自动丢弃（不入队）', () => {
      // 1. 用户主动取消 / 中断 (runtime.aborted -> severity: 'silent')
      const abortErr = new CrishError(
        'Session aborted',
        'runtime.aborted',
        'transient',
        false
      );
      toast.error(abortErr);
      expect(ToastStore.getToasts()).toHaveLength(0);

      // 2. 供应商取消 (provider.cancelled -> severity: 'silent')
      const cancelErr = new CrishError(
        'Provider call cancelled',
        'provider.cancelled',
        'transient',
        false
      );
      ToastStore.showError(cancelErr);
      expect(ToastStore.getToasts()).toHaveLength(0);

      // 3. 非 public 错误 (内部诊断异常 public: false)
      const privateErr = new CrishError(
        'Internal assertion failed',
        'runtime.unexpected_state',
        'permanent',
        false,
        undefined,
        { public: false }
      );
      toast.error(privateErr);
      expect(ToastStore.getToasts()).toHaveLength(0);
    });

    it('原生消费 UserVisibleError 对象', () => {
      const visibleErr: UserVisibleError = {
        visible: true,
        title: '存储损坏',
        message: '数据库索引校验失败',
        action: '请恢复备份',
        retryable: true,
        code: 'store.corrupted',
        severity: 'error',
      };

      toast.error(visibleErr);
      const list = ToastStore.getToasts();

      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe('存储损坏');
      expect(list[0]?.message).toBe('数据库索引校验失败');
      expect(list[0]?.description).toBe('请恢复备份');
      expect(list[0]?.type).toBe('error');
      expect(list[0]?.ariaLive).toBe('assertive');
    });

    it('UserVisibleError 当 visible=false 或 severity=silent 时静默丢弃', () => {
      const silentErr: UserVisibleError = {
        visible: true,
        title: '已取消',
        message: '用户中断了任务',
        action: '',
        retryable: false,
        code: 'runtime.aborted',
        severity: 'silent',
      };
      toast.error(silentErr);
      expect(ToastStore.getToasts()).toHaveLength(0);

      const nonPublicErr: UserVisibleError = {
        visible: false,
        title: '内部错误',
        message: '隐藏细节',
        action: '',
        retryable: false,
        code: 'internal.debug',
        severity: 'error',
      };
      toast.error(nonPublicErr);
      expect(ToastStore.getToasts()).toHaveLength(0);
    });

    it('原生消费标准 Error 实例并生成通用兜底错误展示', () => {
      toast.error(new Error('磁盘已满无法写入'));
      const list = ToastStore.getToasts();

      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe('Unknown error');
      expect(list[0]?.message).toBe('磁盘已满无法写入');
      expect(list[0]?.type).toBe('error');
      expect(list[0]?.ariaLive).toBe('assertive');
    });

    it('彻底拔除中文正则猜测：英文错误不受歧视，中立普通文本不被篡改', () => {
      // 1. 纯英文错误文案正常赋予 error 与 assertive
      toast.error('Network timeout occurred');
      let list = ToastStore.getToasts();
      expect(list[0]?.type).toBe('error');
      expect(list[0]?.ariaLive).toBe('assertive');
      expect(list[0]?.message).toBe('Network timeout occurred');

      ToastStore.clear();

      // 2. 普通通知包含“失败/错误”关键字，但通过 show() 传入时保持 info 与 polite
      // 旧版正则 /失败|错误|无法|拒绝/ 会错误地将此类正常通知篡改为 error
      toast.show('用户反馈中提到了某个错误排查指南');
      list = ToastStore.getToasts();
      expect(list).toHaveLength(1);
      expect(list[0]?.type).toBe('info');
      expect(list[0]?.ariaLive).toBe('polite');
      expect(list[0]?.message).toBe('用户反馈中提到了某个错误排查指南');
    });

    it('显式 options 可正确覆写 title、description、type 与 ariaLive', () => {
      const err = new CrishError(
        'Raw error detail',
        'store.write_failed',
        'transient',
        true
      );

      toast.error(err, {
        title: '覆写自定义标题',
        description: '覆写自定义描述',
        type: 'warning',
        ariaLive: 'polite',
      });

      const list = ToastStore.getToasts();
      expect(list).toHaveLength(1);
      expect(list[0]?.title).toBe('覆写自定义标题');
      expect(list[0]?.description).toBe('覆写自定义描述');
      expect(list[0]?.type).toBe('warning');
      expect(list[0]?.ariaLive).toBe('polite');
    });
  });
});
