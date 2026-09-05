// @vitest-environment jsdom
/**
 * activePortDetector 单元测试套件：
 * 1. 端口数据清洗 sanitizePortList；
 * 2. 网络探测 fetchActiveDevPorts（成功返回、缓存复用、强制刷新、超时与异常降级）；
 * 3. 缓存管理 get/set/clearActivePortCache；
 * 4. useActiveDevPorts React Hook 行为与双重解构语法兼容（对象解构与数组解构）。
 *
 * UTF-8 无 BOM，中文注释。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  sanitizePortList,
  getCachedActivePorts,
  setCachedActivePorts,
  clearActivePortCache,
  fetchActiveDevPorts,
  useActiveDevPorts,
} from './activePortDetector';

describe('activePortDetector 活跃端口探测引擎', () => {
  beforeEach(() => {
    clearActivePortCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearActivePortCache();
    vi.restoreAllMocks();
  });

  describe('1. sanitizePortList 端口列表纯函数校验', () => {
    it('过滤非法类型、浮点数、越界端口', () => {
      const mixed = [
        5173,
        '3000',
        -1,
        0,
        65536,
        8080.5,
        null,
        undefined,
        {},
        8000,
        3000,
      ];
      expect(sanitizePortList(mixed)).toEqual([5173, 8000, 3000]);
    });

    it('非数组输入安全返回空数组', () => {
      expect(sanitizePortList(null)).toEqual([]);
      expect(sanitizePortList(undefined)).toEqual([]);
      expect(sanitizePortList('5173')).toEqual([]);
      expect(sanitizePortList({ port: 5173 })).toEqual([]);
    });
  });

  describe('2. fetchActiveDevPorts 网络探测与缓存', () => {
    it('探测成功：解析并返回活跃端口列表，且写入内存缓存', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [5173, 3000],
      } as Response);

      const ports = await fetchActiveDevPorts();
      expect(fetchSpy).toHaveBeenCalledWith(
        '/__crish_active_ports',
        expect.objectContaining({ method: 'GET' })
      );
      expect(ports).toEqual([5173, 3000]);
      expect(getCachedActivePorts()).toEqual([5173, 3000]);
    });

    it('缓存复用：TTL 内重复调用不再发起网络请求', async () => {
      setCachedActivePorts([8080]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const ports = await fetchActiveDevPorts();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(ports).toEqual([8080]);
    });

    it('skipCache 选项：强制忽略缓存并发起真实探测', async () => {
      setCachedActivePorts([8080]);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [5173],
      } as Response);

      const ports = await fetchActiveDevPorts({ skipCache: true });
      expect(fetchSpy).toHaveBeenCalled();
      expect(ports).toEqual([5173]);
    });

    it('接口返回非 ok 状态：降级返回既有缓存或空数组，不抛异常', async () => {
      setCachedActivePorts([3000]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const ports = await fetchActiveDevPorts({ skipCache: true });
      expect(ports).toEqual([3000]);
    });

    it('网络超时或断网异常：优雅降级返回既有缓存或空数组', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('Failed to fetch')
      );

      const ports = await fetchActiveDevPorts();
      expect(ports).toEqual([]);
    });
  });

  describe('3. useActiveDevPorts React Hook', () => {
    it('挂载时自动发起探测并更新状态', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [5173],
      } as Response);

      const { result } = renderHook(() => useActiveDevPorts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.ports).toEqual([5173]);
    });

    it('支持数组解构语法与对象解构语法双向兼容', async () => {
      setCachedActivePorts([4200]);

      const { result } = renderHook(() => useActiveDevPorts());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      // 对象解构
      const { ports, loading } = result.current;
      expect(ports).toEqual([4200]);
      expect(loading).toBe(false);

      // 数组解构
      const [portsArr, loadingArr] = result.current as unknown as [number[], boolean];
      expect(portsArr).toEqual([4200]);
      expect(loadingArr).toBe(false);
    });

    it('调用 refresh 手动刷新端口列表', async () => {
      setCachedActivePorts([3000]);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => [3000, 5173],
      } as Response);

      const { result } = renderHook(() => useActiveDevPorts());
      expect(result.current.ports).toEqual([3000]);

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.ports).toEqual([3000, 5173]);
    });
  });
});
