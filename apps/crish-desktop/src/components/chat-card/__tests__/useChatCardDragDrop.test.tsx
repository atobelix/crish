// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useChatCardDragDrop,
  getLogicalDragPosition,
  isPointInsideTarget,
} from '../useChatCardDragDrop';

// 记录注册的 IPC 监听器
type IpcHandler = (event: { payload: any }) => void;
const ipcListeners: Record<string, IpcHandler[]> = {};

vi.mock('../../../hooks/useIpcListener', () => ({
  useIpcListener: (eventName: string, handler: IpcHandler) => {
    if (!ipcListeners[eventName]) {
      ipcListeners[eventName] = [];
    }
    ipcListeners[eventName].push(handler);
  },
}));

function emitIpc(eventName: string, payload: any) {
  const handlers = ipcListeners[eventName] || [];
  handlers.forEach((h) => h({ payload }));
}

describe('useChatCardDragDrop 拖拽坐标转换与目标判定', () => {
  beforeEach(() => {
    for (const k of Object.keys(ipcListeners)) {
      delete ipcListeners[k];
    }
    vi.stubGlobal('devicePixelRatio', 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getLogicalDragPosition: 正确解析物理坐标并按 devicePixelRatio 缩放', () => {
    // 1. 标准平铺 { x, y }
    expect(getLogicalDragPosition({ position: { x: 300, y: 400 } })).toEqual({
      x: 300,
      y: 400,
    });

    // 2. Physical 嵌套对象 { Physical: { x, y } }
    expect(
      getLogicalDragPosition({ position: { Physical: { x: 600, y: 800 } } })
    ).toEqual({
      x: 600,
      y: 800,
    });

    // 3. 高 DPI 缩放（如 150% 缩放）
    vi.stubGlobal('devicePixelRatio', 1.5);
    expect(getLogicalDragPosition({ position: { x: 300, y: 450 } })).toEqual({
      x: 200,
      y: 300,
    });

    // 4. 非法或缺省 payload
    expect(getLogicalDragPosition(null)).toBeNull();
    expect(getLogicalDragPosition({})).toBeNull();
    expect(getLogicalDragPosition({ position: null })).toBeNull();
  });

  it('isPointInsideTarget: 正确判断点是否落在当前容器或其所属 [data-leaf-id] 内', () => {
    const parentLeaf = document.createElement('div');
    parentLeaf.setAttribute('data-leaf-id', 'leaf-right');
    vi.spyOn(parentLeaf, 'getBoundingClientRect').mockReturnValue({
      left: 500,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 500,
      height: 800,
      x: 500,
      y: 0,
      toJSON: () => {},
    });

    const childCard = document.createElement('div');
    vi.spyOn(childCard, 'getBoundingClientRect').mockReturnValue({
      left: 500,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 500,
      height: 800,
      x: 500,
      y: 0,
      toJSON: () => {},
    });
    parentLeaf.appendChild(childCard);
    document.body.appendChild(parentLeaf);

    // 落在右侧叶子内 (x: 600, y: 200)
    expect(isPointInsideTarget(childCard, { x: 600, y: 200 })).toBe(true);
    // 落在左侧 (x: 200, y: 200)，不在当前叶子内
    expect(isPointInsideTarget(childCard, { x: 200, y: 200 })).toBe(false);
    // 落在外部下方 (x: 600, y: 900)
    expect(isPointInsideTarget(childCard, { x: 600, y: 900 })).toBe(false);

    document.body.removeChild(parentLeaf);
  });

  it('isPointInsideTarget: 半开区间 [left, right) × [top, bottom) 确保相邻无缝分屏边界绝不双命中', () => {
    const leftEl = document.createElement('div');
    vi.spyOn(leftEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 500,
      bottom: 800,
      width: 500,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    const rightEl = document.createElement('div');
    vi.spyOn(rightEl, 'getBoundingClientRect').mockReturnValue({
      left: 500,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 500,
      height: 800,
      x: 500,
      y: 0,
      toJSON: () => {},
    });

    // 边界像素点 x = 500: 左分屏 [0, 500) 返回 false，右分屏 [500, 1000) 返回 true
    expect(isPointInsideTarget(leftEl, { x: 500, y: 300 })).toBe(false);
    expect(isPointInsideTarget(rightEl, { x: 500, y: 300 })).toBe(true);

    // 边界像素点 x = 499.9: 左分屏返回 true，右分屏返回 false
    expect(isPointInsideTarget(leftEl, { x: 499.9, y: 300 })).toBe(true);
    expect(isPointInsideTarget(rightEl, { x: 499.9, y: 300 })).toBe(false);

    // 折叠卡片（width <= 0 或 height <= 0）绝不命中
    const collapsedEl = document.createElement('div');
    vi.spyOn(collapsedEl, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    expect(isPointInsideTarget(collapsedEl, { x: 0, y: 0 })).toBe(false);
  });

  it('isPointInsideTarget: elementFromPoint 校验顶层遮挡（同叶抽屉 / Modal 遮罩层）', () => {
    const chatBody = document.createElement('div');
    chatBody.className = 'chatBody';
    vi.spyOn(chatBody, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 500,
      bottom: 800,
      width: 500,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    document.body.appendChild(chatBody);

    const modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'dialog-backdrop';
    document.body.appendChild(modalBackdrop);

    const efpSpy = vi.spyOn(document, 'elementFromPoint');

    // 1. 命中了 Modal 遮罩层 -> 未命中 chatBody
    efpSpy.mockReturnValue(modalBackdrop);
    expect(isPointInsideTarget(chatBody, { x: 250, y: 300 })).toBe(false);

    // 2. 命中了同叶右侧抽屉 -> 排除未命中
    const drawerEl = document.createElement('div');
    drawerEl.className = 'leafToolPanel';
    chatBody.appendChild(drawerEl);
    efpSpy.mockReturnValue(drawerEl);
    expect(isPointInsideTarget(chatBody, { x: 250, y: 300 })).toBe(false);

    // 3. 无遮挡，命中 chatBody 内部子元素
    const childMsg = document.createElement('div');
    chatBody.appendChild(childMsg);
    efpSpy.mockReturnValue(childMsg);
    expect(isPointInsideTarget(chatBody, { x: 250, y: 300 })).toBe(true);

    // 4. JSDOM 环境回退（elementFromPoint 返回 null 时安全回退至几何矩形判定）
    efpSpy.mockReturnValue(null);
    expect(isPointInsideTarget(chatBody, { x: 250, y: 300 })).toBe(true);

    document.body.removeChild(chatBody);
    document.body.removeChild(modalBackdrop);
  });
});

describe('useChatCardDragDrop 多子窗口（分屏）拖拽状态与文件归属隔离', () => {
  let leftContainer: HTMLDivElement;
  let rightContainer: HTMLDivElement;

  beforeEach(() => {
    for (const k of Object.keys(ipcListeners)) {
      delete ipcListeners[k];
    }
    vi.stubGlobal('devicePixelRatio', 1);

    // 模拟左子窗口：[0, 500]
    leftContainer = document.createElement('div');
    leftContainer.setAttribute('data-leaf-id', 'leaf-left');
    vi.spyOn(leftContainer, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 500,
      bottom: 800,
      width: 500,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    // 模拟右子窗口：[500, 1000]
    rightContainer = document.createElement('div');
    rightContainer.setAttribute('data-leaf-id', 'leaf-right');
    vi.spyOn(rightContainer, 'getBoundingClientRect').mockReturnValue({
      left: 500,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 500,
      height: 800,
      x: 500,
      y: 0,
      toJSON: () => {},
    });

    document.body.appendChild(leftContainer);
    document.body.appendChild(rightContainer);
  });

  afterEach(() => {
    if (leftContainer.parentNode) document.body.removeChild(leftContainer);
    if (rightContainer.parentNode) document.body.removeChild(rightContainer);
    vi.unstubAllGlobals();
  });

  it('Tauri IPC 事件：拖拽到右侧子窗口时，仅右侧点亮遮罩，左侧保持不点亮', () => {
    const leftPathsHandler = vi.fn();
    const rightPathsHandler = vi.fn();

    const { result: leftHook } = renderHook(() =>
      useChatCardDragDrop({
        handlePathsSelected: leftPathsHandler,
        handleDroppedFiles: vi.fn(),
      })
    );
    const { result: rightHook } = renderHook(() =>
      useChatCardDragDrop({
        handlePathsSelected: rightPathsHandler,
        handleDroppedFiles: vi.fn(),
      })
    );

    // 将 ref 挂载到对应的 DOM 容器
    leftHook.current.rootRef.current = leftContainer;
    rightHook.current.rootRef.current = rightContainer;

    // 1. 拖入右侧子窗口 (x: 750, y: 300)
    act(() => {
      emitIpc('tauri://drag-enter', {
        paths: ['C:/test/file.txt'],
        position: { x: 750, y: 300 },
      });
    });

    expect(rightHook.current.isDragOver).toBe(true);
    expect(leftHook.current.isDragOver).toBe(false);

    // 2. 移动鼠标到左侧子窗口 (x: 250, y: 300)
    act(() => {
      emitIpc('tauri://drag-over', {
        position: { x: 250, y: 300 },
      });
    });

    expect(leftHook.current.isDragOver).toBe(true);
    expect(rightHook.current.isDragOver).toBe(false);

    // 3. 在左侧子窗口释放 drop (x: 250, y: 300)
    act(() => {
      emitIpc('tauri://drag-drop', {
        paths: ['C:/test/file.txt'],
        position: { x: 250, y: 300 },
      });
    });

    // 断言：只有左侧接收到文件，右侧没有被误触发！
    expect(leftPathsHandler).toHaveBeenCalledWith(['C:/test/file.txt']);
    expect(rightPathsHandler).not.toHaveBeenCalled();

    // 遮罩均已复位
    expect(leftHook.current.isDragOver).toBe(false);
    expect(rightHook.current.isDragOver).toBe(false);
  });

  it('Tauri IPC 事件：文件释放在两个子窗口之外时，两个子窗口均不接收', () => {
    const leftPathsHandler = vi.fn();
    const rightPathsHandler = vi.fn();

    const { result: leftHook } = renderHook(() =>
      useChatCardDragDrop({
        handlePathsSelected: leftPathsHandler,
        handleDroppedFiles: vi.fn(),
      })
    );
    const { result: rightHook } = renderHook(() =>
      useChatCardDragDrop({
        handlePathsSelected: rightPathsHandler,
        handleDroppedFiles: vi.fn(),
      })
    );

    leftHook.current.rootRef.current = leftContainer;
    rightHook.current.rootRef.current = rightContainer;

    // 释放到窗口下方空白处 (x: 500, y: 950)
    act(() => {
      emitIpc('tauri://drag-drop', {
        paths: ['C:/outside.txt'],
        position: { x: 500, y: 950 },
      });
    });

    expect(leftPathsHandler).not.toHaveBeenCalled();
    expect(rightPathsHandler).not.toHaveBeenCalled();
  });

  it('DOM 原生 Window Drop 事件：仅落在目标子窗口内的实例消费文件', () => {
    const leftFilesHandler = vi.fn();
    const rightFilesHandler = vi.fn();

    const { result: leftHook } = renderHook(() =>
      useChatCardDragDrop({
        handlePathsSelected: vi.fn(),
        handleDroppedFiles: leftFilesHandler,
      })
    );
    const { result: rightHook } = renderHook(() =>
      useChatCardDragDrop({
        handlePathsSelected: vi.fn(),
        handleDroppedFiles: rightFilesHandler,
      })
    );

    leftHook.current.rootRef.current = leftContainer;
    rightHook.current.rootRef.current = rightContainer;

    const fakeFile = new File(['content'], 'demo.txt', { type: 'text/plain' });

    // 模拟在右侧子窗口区域发生 drop (clientX: 700, clientY: 200)
    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as any;
    dropEvent.clientX = 700;
    dropEvent.clientY = 200;
    dropEvent.dataTransfer = {
      files: [fakeFile],
      types: ['Files'],
    };

    act(() => {
      window.dispatchEvent(dropEvent);
    });

    // 只有右侧子窗口接收该文件
    expect(rightFilesHandler).toHaveBeenCalledTimes(1);
    expect(rightFilesHandler).toHaveBeenCalledWith([fakeFile]);
    expect(leftFilesHandler).not.toHaveBeenCalled();
  });
});
