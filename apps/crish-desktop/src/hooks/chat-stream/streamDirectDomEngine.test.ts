// @vitest-environment jsdom
import React, { useEffect, useRef } from 'react';
import { render, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StreamDirectDomEngine,
  streamDirectEngine,
  makeStreamDirectScopeKey,
  STREAM_DIRECT_DEFAULT_MAX_SLOTS,
} from './streamDirectDomEngine';

/**
 * 创建挂载在真实 document.body 下的容器与 Text 节点，确保 `textNode.isConnected === true`。
 */
function createMountedTextNode(initialText = ''): {
  container: HTMLDivElement;
  textNode: Text;
  unmountDom: () => void;
} {
  const container = document.createElement('div');
  const textNode = document.createTextNode(initialText);
  container.appendChild(textNode);
  document.body.appendChild(container);
  return {
    container,
    textNode,
    unmountDom: () => {
      container.remove();
    },
  };
}

describe('StreamDirectDomEngine (W4-1 DOM-Bypass Pipeline)', () => {
  let engine: StreamDirectDomEngine;

  beforeEach(() => {
    engine = new StreamDirectDomEngine();
    streamDirectEngine.clearAll();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    engine.clearAll();
    streamDirectEngine.clearAll();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('1. 单窗格与多分屏同步直通 appendData 即时性与正确性', () => {
    it('makeStreamDirectScopeKey 生成标准复合键 ${sessionId}::${messageId}', () => {
      expect(makeStreamDirectScopeKey('sess-01', 'msg-99')).toBe(
        'sess-01::msg-99'
      );
    });

    it('单窗格挂载下 appendChunk 直调原生 Text.prototype.appendData 并即时反映到 DOM', () => {
      const { textNode, container } = createMountedTextNode();
      const appendDataSpy = vi.spyOn(textNode, 'appendData');

      const unregister = engine.registerTarget('sess-1', 'msg-1', textNode);
      expect(engine.getTargetCount('sess-1', 'msg-1')).toBe(1);
      expect(textNode.data).toBe('');

      const hit1 = engine.appendChunk('sess-1', 'msg-1', 'Hello');
      const hit2 = engine.appendChunk('sess-1', 'msg-1', ', ');
      const hit3 = engine.appendChunk('sess-1', 'msg-1', 'StreamDirect!');

      expect(hit1).toBe(true);
      expect(hit2).toBe(true);
      expect(hit3).toBe(true);
      expect(appendDataSpy).toHaveBeenCalledTimes(3);
      expect(appendDataSpy).toHaveBeenNthCalledWith(1, 'Hello');
      expect(appendDataSpy).toHaveBeenNthCalledWith(2, ', ');
      expect(appendDataSpy).toHaveBeenNthCalledWith(3, 'StreamDirect!');

      expect(textNode.data).toBe('Hello, StreamDirect!');
      expect(container.textContent).toBe('Hello, StreamDirect!');
      expect(engine.getAccumulatedText('sess-1', 'msg-1')).toBe(
        'Hello, StreamDirect!'
      );

      unregister();
      expect(engine.getTargetCount('sess-1', 'msg-1')).toBe(0);
    });

    it('多分屏（同一 sessionId::messageId 绑定 2 个不同 Text 节点）实现一对多同步直通追加', () => {
      const leftPane = createMountedTextNode();
      const rightPane = createMountedTextNode();
      const leftSpy = vi.spyOn(leftPane.textNode, 'appendData');
      const rightSpy = vi.spyOn(rightPane.textNode, 'appendData');

      const unregLeft = engine.registerTarget(
        'sess-split',
        'msg-shared',
        leftPane.textNode
      );
      const unregRight = engine.registerTarget(
        'sess-split',
        'msg-shared',
        rightPane.textNode
      );

      expect(engine.getTargetCount('sess-split', 'msg-shared')).toBe(2);

      const chunks = ['第一段：', '左右分屏', '共享同一流式槽位', '。'];
      for (const chunk of chunks) {
        expect(engine.appendChunk('sess-split', 'msg-shared', chunk)).toBe(
          true
        );
      }

      const expected = '第一段：左右分屏共享同一流式槽位。';
      expect(leftPane.textNode.data).toBe(expected);
      expect(rightPane.textNode.data).toBe(expected);
      expect(leftSpy).toHaveBeenCalledTimes(chunks.length);
      expect(rightSpy).toHaveBeenCalledTimes(chunks.length);
      expect(engine.getAccumulatedText('sess-split', 'msg-shared')).toBe(
        expected
      );

      // 关闭右分屏（注销右侧节点），左分屏继续无损接收增量
      unregRight();
      expect(engine.getTargetCount('sess-split', 'msg-shared')).toBe(1);

      engine.appendChunk('sess-split', 'msg-shared', '仅左屏继续追加');
      expect(leftPane.textNode.data).toBe(`${expected}仅左屏继续追加`);
      expect(rightPane.textNode.data).toBe(expected);

      unregLeft();
    });
  });

  describe('2. 虚拟列表回滚与中途挂载节点的历史流文本自动同步', () => {
    it('先推流后挂载（或虚拟滚动滑出视口再滚回视口）时，registerTarget 自动对齐完整已累积文本', () => {
      // 阶段 1：目标尚未挂载（或已在视口外卸载），Token 持续写入影子缓冲
      expect(engine.appendChunk('sess-virt', 'msg-virt', 'Chunk-A ')).toBe(
        false
      );
      expect(engine.appendChunk('sess-virt', 'msg-virt', 'Chunk-B ')).toBe(
        false
      );
      expect(engine.getAccumulatedText('sess-virt', 'msg-virt')).toBe(
        'Chunk-A Chunk-B '
      );

      // 阶段 2：虚拟列表滚回视口，首个 Text 节点挂载，立即同步历史累积文本
      const firstMount = createMountedTextNode('stale-placeholder');
      const unregFirst = engine.registerTarget(
        'sess-virt',
        'msg-virt',
        firstMount.textNode
      );
      expect(firstMount.textNode.data).toBe('Chunk-A Chunk-B ');

      // 阶段 3：视口内继续追加
      expect(engine.appendChunk('sess-virt', 'msg-virt', 'Chunk-C ')).toBe(
        true
      );
      expect(firstMount.textNode.data).toBe('Chunk-A Chunk-B Chunk-C ');

      // 阶段 4：再次滑出视口卸载，并在视口外继续接收 Token
      unregFirst();
      firstMount.unmountDom();
      expect(engine.appendChunk('sess-virt', 'msg-virt', 'Chunk-D')).toBe(
        false
      );

      // 阶段 5：二次回滚入视口挂载新节点，完整恢复 A+B+C+D
      const remounted = createMountedTextNode();
      engine.registerTarget('sess-virt', 'msg-virt', remounted.textNode);
      expect(remounted.textNode.data).toBe('Chunk-A Chunk-B Chunk-C Chunk-D');
    });

    it('支持 initialContent 初始化，且当缓冲已有更新内容时不被旧 initialContent 倒退覆盖', () => {
      const paneA = createMountedTextNode();
      engine.registerTarget(
        'sess-init',
        'msg-init',
        paneA.textNode,
        'Initial: '
      );
      expect(paneA.textNode.data).toBe('Initial: ');
      expect(engine.getAccumulatedText('sess-init', 'msg-init')).toBe(
        'Initial: '
      );

      engine.appendChunk('sess-init', 'msg-init', 'Step1');
      expect(paneA.textNode.data).toBe('Initial: Step1');

      // 分屏 B 挂载时即使传入旧的 initialContent，也会自动对齐到最新的 'Initial: Step1'
      const paneB = createMountedTextNode();
      engine.registerTarget(
        'sess-init',
        'msg-init',
        paneB.textNode,
        'Initial: '
      );
      expect(paneB.textNode.data).toBe('Initial: Step1');
    });
  });

  describe('3. 已卸载节点（isConnected === false）安全剔除与防内存泄漏', () => {
    it('当 DOM 节点被直接从文档树移除（未调 unregister）时，appendChunk 自动检测并剔除断连节点', () => {
      const liveMount = createMountedTextNode();
      const detachedMount = createMountedTextNode();

      engine.registerTarget('sess-leak', 'msg-leak', liveMount.textNode);
      engine.registerTarget('sess-leak', 'msg-leak', detachedMount.textNode);
      expect(engine.getTargetCount('sess-leak', 'msg-leak', false)).toBe(2);

      // 模拟 DOM 节点直接从文档树卸载（isConnected 变为 false）
      detachedMount.unmountDom();
      expect(detachedMount.textNode.isConnected).toBe(false);
      expect(liveMount.textNode.isConnected).toBe(true);

      const detachedSpy = vi.spyOn(detachedMount.textNode, 'appendData');
      const hit = engine.appendChunk('sess-leak', 'msg-leak', 'ActiveToken');

      expect(hit).toBe(true);
      expect(liveMount.textNode.data).toBe('ActiveToken');
      // 断连节点绝不被调用 appendData，且已被从内部 Set 中永久剔除
      expect(detachedSpy).not.toHaveBeenCalled();
      expect(engine.getTargetCount('sess-leak', 'msg-leak', false)).toBe(1);
    });

    it('所有节点均已断连时，appendChunk 剔除全部死节点并返回 false，但影子缓冲仍正常累加', () => {
      const mount = createMountedTextNode();
      engine.registerTarget('sess-dead', 'msg-dead', mount.textNode);
      mount.unmountDom();
      expect(mount.textNode.isConnected).toBe(false);

      const hit = engine.appendChunk(
        'sess-dead',
        'msg-dead',
        'BufferedOffline'
      );
      expect(hit).toBe(false);
      expect(engine.getTargetCount('sess-dead', 'msg-dead', false)).toBe(0);
      expect(engine.getAccumulatedText('sess-dead', 'msg-dead')).toBe(
        'BufferedOffline'
      );
    });

    it('新节点调用 registerTarget 时主动清理同槽位内残留的断连节点', () => {
      const oldMount = createMountedTextNode();
      engine.registerTarget('sess-clean', 'msg-clean', oldMount.textNode);
      oldMount.unmountDom();

      const newMount = createMountedTextNode();
      engine.registerTarget('sess-clean', 'msg-clean', newMount.textNode);

      expect(engine.getTargetCount('sess-clean', 'msg-clean', false)).toBe(1);
    });
  });

  describe('4. 10,000 次高频 Token 追加：React 0 重绘与极限性能基准', () => {
    it('10,000 次高频 Token 追加期间 React 组件重渲染次数严格为 0，单次均摊耗时远低于阈值', () => {
      let reactRenderCount = 0;
      const sessionId = 'sess-perf';
      const messageId = 'msg-perf-10k';

      function DirectStreamingHost() {
        reactRenderCount += 1;
        const hostRef = useRef<HTMLDivElement | null>(null);

        useEffect(() => {
          const el = hostRef.current;
          if (!el) return;
          const textNode = document.createTextNode('');
          el.appendChild(textNode);
          const unregister = streamDirectEngine.registerTarget(
            sessionId,
            messageId,
            textNode
          );
          return () => {
            unregister();
            textNode.remove();
          };
        }, []);

        return React.createElement('div', {
          ref: hostRef,
          'data-testid': 'direct-stream-host',
        });
      }

      const { getByTestId } = render(React.createElement(DirectStreamingHost));
      // 挂载阶段仅渲染 1 次（Start）
      expect(reactRenderCount).toBe(1);

      const totalIterations = 10_000;
      const tokenDelta = 'token ';
      const t0 = performance.now();

      for (let i = 0; i < totalIterations; i++) {
        const hit = streamDirectEngine.appendChunk(
          sessionId,
          messageId,
          tokenDelta
        );
        if (!hit) {
          throw new Error(`Expected direct hit at iteration ${i}`);
        }
      }

      const elapsedMs = performance.now() - t0;

      // 断言 1：10,000 次追加期间 React 0 重绘（总渲染次数保持初始挂载的 1 次）
      expect(reactRenderCount).toBe(1);

      // 断言 2：DOM 内容与长度 100% 精确等于 10,000 * 6 = 60,000 字符
      const hostEl = getByTestId('direct-stream-host');
      expect(hostEl.textContent?.length).toBe(
        totalIterations * tokenDelta.length
      );
      expect(
        streamDirectEngine.getAccumulatedText(sessionId, messageId).length
      ).toBe(totalIterations * tokenDelta.length);

      // 断言 3：10,000 次原生 appendData 在 jsdom 下的总耗时远低于阈值（放宽 CI 抖动上限至 250ms，实测通常 < 15ms）
      expect(elapsedMs).toBeLessThan(250);
    });
  });

  describe('5. commitAndRelease 双轨锁存交接与 abortSession 级联清理生命周期', () => {
    it('commitAndRelease 返回完整累积文本、释放槽位与引用，且不抹除在屏 TextNode.data（防止单帧白屏）', () => {
      const { textNode } = createMountedTextNode();
      engine.registerTarget('sess-fin', 'msg-fin', textNode);

      engine.appendChunk('sess-fin', 'msg-fin', 'Final ');
      engine.appendChunk('sess-fin', 'msg-fin', 'Answer.');

      expect(engine.hasSlot('sess-fin', 'msg-fin')).toBe(true);

      const finalText = engine.commitAndRelease('sess-fin', 'msg-fin');
      expect(finalText).toBe('Final Answer.');

      // 槽位与目标集合已彻底释放
      expect(engine.hasSlot('sess-fin', 'msg-fin')).toBe(false);
      expect(engine.getTargetCount('sess-fin', 'msg-fin')).toBe(0);
      expect(engine.getAccumulatedText('sess-fin', 'msg-fin')).toBe('');
      expect(engine.getSessionSlotCount('sess-fin')).toBe(0);

      // 关键：底层 TextNode 文本保留，供双轨锁存交接在 React 持久层完成渲染前维持视觉连续
      expect(textNode.data).toBe('Final Answer.');

      // 重复调用 commitAndRelease 幂等返回空串
      expect(engine.commitAndRelease('sess-fin', 'msg-fin')).toBe('');
    });

    it('abortSession 一键清理目标会话下的全部流式消息槽位，且绝不误伤其他并发会话', () => {
      const m1 = createMountedTextNode();
      const m2 = createMountedTextNode();
      const otherSessMount = createMountedTextNode();

      engine.registerTarget('sess-abort', 'msg-1', m1.textNode);
      engine.registerTarget('sess-abort', 'msg-2', m2.textNode);
      engine.registerTarget('sess-keep', 'msg-k1', otherSessMount.textNode);

      engine.appendChunk('sess-abort', 'msg-1', 'Abort-1');
      engine.appendChunk('sess-abort', 'msg-2', 'Abort-2');
      engine.appendChunk('sess-keep', 'msg-k1', 'Keep-Alive');

      expect(engine.getSessionSlotCount('sess-abort')).toBe(2);
      expect(engine.getSessionSlotCount('sess-keep')).toBe(1);

      // 触发三级级联取消总线会话中止
      engine.abortSession('sess-abort');

      expect(engine.getSessionSlotCount('sess-abort')).toBe(0);
      expect(engine.hasSlot('sess-abort', 'msg-1')).toBe(false);
      expect(engine.hasSlot('sess-abort', 'msg-2')).toBe(false);
      expect(engine.getAccumulatedText('sess-abort', 'msg-1')).toBe('');
      expect(engine.getAccumulatedText('sess-abort', 'msg-2')).toBe('');

      // 另一并发会话完好无损
      expect(engine.getSessionSlotCount('sess-keep')).toBe(1);
      expect(engine.getAccumulatedText('sess-keep', 'msg-k1')).toBe(
        'Keep-Alive'
      );
      expect(engine.appendChunk('sess-keep', 'msg-k1', '!')).toBe(true);
      expect(otherSessMount.textNode.data).toBe('Keep-Alive!');
    });

    it('长会话资源有界性守卫：超出 maxSlots 时优先驱逐无连接目标的陈旧槽位', () => {
      const boundedEngine = new StreamDirectDomEngine({ maxSlots: 3 });
      expect(STREAM_DIRECT_DEFAULT_MAX_SLOTS).toBe(256);

      // s1::m1 具有真实连接节点
      const connected = createMountedTextNode();
      boundedEngine.registerTarget('s1', 'm1', connected.textNode);
      boundedEngine.appendChunk('s1', 'm1', 'live');

      // s2::m2 与 s3::m3 为无连接节点的离屏缓冲
      boundedEngine.appendChunk('s2', 'm2', 'offline-2');
      boundedEngine.appendChunk('s3', 'm3', 'offline-3');

      // 插入第 4 个槽位 s4::m4，应优先驱逐无连接节点的 s2::m2，保留有连接节点的 s1::m1
      boundedEngine.appendChunk('s4', 'm4', 'offline-4');

      expect(boundedEngine.hasSlot('s1', 'm1')).toBe(true);
      expect(boundedEngine.hasSlot('s2', 'm2')).toBe(false);
      expect(boundedEngine.hasSlot('s3', 'm3')).toBe(true);
      expect(boundedEngine.hasSlot('s4', 'm4')).toBe(true);
    });

    it('空参数与重复注销具备防御性幂等保护', () => {
      const { textNode } = createMountedTextNode();
      const noopUnreg = engine.registerTarget('', 'msg-1', textNode);
      noopUnreg();
      expect(engine.appendChunk('', 'msg-1', 'x')).toBe(false);
      expect(engine.appendChunk('sess', '', 'x')).toBe(false);
      expect(engine.getAccumulatedText('', 'msg-1')).toBe('');
      expect(engine.commitAndRelease('', 'msg-1')).toBe('');
      expect(() => engine.abortSession('')).not.toThrow();

      // 注册后未追加任何文本即注销，自动回收空槽位
      const unreg = engine.registerTarget('sess-temp', 'msg-temp', textNode);
      expect(engine.hasSlot('sess-temp', 'msg-temp')).toBe(true);
      unreg();
      unreg(); // 二次调用幂等无副作用
      expect(engine.hasSlot('sess-temp', 'msg-temp')).toBe(false);
    });
  });
});
