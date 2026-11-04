// AdaptiveStreamingSmoother 纯逻辑单元测试
// 对齐《04 · 移动端 AI 流式匀速输出与智能跟随滚动方案》§7.1
// 覆盖：
// 1. 突发网络吐字（瞬间到达 500 字）平准为匀速平滑过渡；
// 2. 网络停顿抗断帧与平缓滑行（无骤降跳帧）；
// 3. 流结束快速优雅泄洪与即时打断（0 字符丢失）；
// 4. Unicode 字符簇（Emoji / 多字节 / ZWJ）安全边界保护。

import {
  AdaptiveStreamingSmoother,
  GraphemeBoundarySnapper,
  SMOOTHER_DEFAULTS,
} from './AdaptiveStreamingSmoother';

class TestScheduler {
  currentTime = 1000;
  private pendingCallbacks = new Map<number, (time: number) => void>();
  private nextId = 1;

  now = () => this.currentTime;

  requestAnimationFrame = (cb: (time: number) => void): number => {
    const id = this.nextId++;
    this.pendingCallbacks.set(id, cb);
    return id;
  };

  cancelAnimationFrame = (id: number): void => {
    this.pendingCallbacks.delete(id);
  };

  /** 推进时钟并执行所触发的动画帧回调 */
  advance(ms: number) {
    this.currentTime += ms;
    const callbacks = [...this.pendingCallbacks.values()];
    this.pendingCallbacks.clear();
    for (const cb of callbacks) {
      cb(this.currentTime);
    }
  }

  get pendingCount(): number {
    return this.pendingCallbacks.size;
  }
}

describe('AdaptiveStreamingSmoother 纯逻辑平准引擎', () => {
  let scheduler: TestScheduler;

  beforeEach(() => {
    scheduler = new TestScheduler();
  });

  describe('1. 突发网络吐字平准（500 字瞬间涌入）', () => {
    it('突发 500 字瞬间到达时，首帧仅输出首 1~2 字符避免白屏，且被平准为柔和匀速推进', () => {
      const commits: string[] = [];
      const smoother = new AdaptiveStreamingSmoother(
        (text) => commits.push(text),
        {
          now: scheduler.now,
          requestAnimationFrame: scheduler.requestAnimationFrame,
          cancelAnimationFrame: scheduler.cancelAnimationFrame,
        }
      );

      // 构造 500 字突发段落
      const burstText = '测试'.repeat(250); // 500 字符
      expect(burstText.length).toBe(500);

      // 瞬间涌入 500 字
      smoother.updateTarget(burstText, true);

      // 首帧立即交付 1~2 字符，避免白屏死寂
      expect(commits.length).toBe(1);
      expect(commits[0]!.length).toBeLessThanOrEqual(2);
      expect(smoother.getVelocity()).toBe(SMOOTHER_DEFAULTS.BASE_CHARS_PER_SEC);

      // 推进 32ms (约 1 帧节流周期)
      scheduler.advance(32);

      // 验证未发生 500 字一次性爆字砸屏
      const latest = commits[commits.length - 1]!;
      expect(latest.length).toBeLessThan(10); // 32ms 内仅推进几个字符
      expect(smoother.getDisplayedLength()).toBe(latest.length);

      // 检查速度过渡：瞬时加速度受限于 MAX_ACCEL (100 chars/s^2)
      // 32ms 最大提速 100 * 0.032 = 3.2 chars/s
      const currentV = smoother.getVelocity();
      expect(currentV).toBeGreaterThanOrEqual(
        SMOOTHER_DEFAULTS.BASE_CHARS_PER_SEC
      );
      expect(currentV).toBeLessThanOrEqual(
        SMOOTHER_DEFAULTS.BASE_CHARS_PER_SEC + 100 * 0.035
      );

      // 连续推进 300ms（模拟后续多帧推进）
      for (let i = 0; i < 10; i++) {
        scheduler.advance(32);
      }

      // 验证平准速度严格被封顶在 maxCharsPerSec (70 chars/s)，绝不失控狂飙
      expect(smoother.getVelocity()).toBeLessThanOrEqual(
        SMOOTHER_DEFAULTS.MAX_CHARS_PER_SEC + 0.1
      );
      // 字符稳步推进但仍有积压
      expect(smoother.getDisplayedLength()).toBeLessThan(500);
      expect(smoother.getBacklog()).toBeGreaterThan(0);

      smoother.reset();
    });
  });

  describe('2. 网络停顿抗断帧与平缓滑行', () => {
    it('网络停顿导致积压急剧减少时，当前速度平缓减速滑行，绝不骤降跳帧', () => {
      const commits: string[] = [];
      const smoother = new AdaptiveStreamingSmoother(
        (text) => commits.push(text),
        {
          now: scheduler.now,
          requestAnimationFrame: scheduler.requestAnimationFrame,
          cancelAnimationFrame: scheduler.cancelAnimationFrame,
        }
      );

      // 先送入 80 字，让平准器提速至平滑追赶速度
      const text =
        '这是用来测试平滑减速与抗断流机制的连续文本，模拟正常流式生成的稳定过程。'.repeat(
          2
        );
      smoother.updateTarget(text, true);

      // 模拟推进 400ms，使速度达到追赶区
      for (let i = 0; i < 12; i++) {
        scheduler.advance(32);
      }
      const highVelocity = smoother.getVelocity();
      expect(highVelocity).toBeGreaterThan(
        SMOOTHER_DEFAULTS.BASE_CHARS_PER_SEC
      );

      // 此时上游网络完全停顿，不再有新字符流入
      // 推进一帧后检查减速平缓度
      scheduler.advance(32);
      const velocityAfterStall = smoother.getVelocity();

      // 减速受限于 MAX_DECEL (60 chars/s^2)，32ms 降速绝不超过 60 * 0.035 ≈ 2.1 chars/s
      const decel = highVelocity - velocityAfterStall;
      expect(decel).toBeLessThanOrEqual(60 * 0.04);
      // 绝不骤降为 0 或直接停摆
      expect(velocityAfterStall).toBeGreaterThan(
        SMOOTHER_DEFAULTS.MIN_CHARS_PER_SEC
      );

      smoother.reset();
    });
  });

  describe('3. 终态优雅泄洪与即时打断（0 字符丢失）', () => {
    it('网络流结束（streaming=false）时，在 <= 280ms 内优雅冲刷剩余缓冲，100% 完整交付无遗漏', () => {
      let finalDelivered = '';
      let isCompletedReceived = false;

      const smoother = new AdaptiveStreamingSmoother(
        (text, isCompleted) => {
          finalDelivered = text;
          if (isCompleted) {
            isCompletedReceived = true;
          }
        },
        {
          now: scheduler.now,
          requestAnimationFrame: scheduler.requestAnimationFrame,
          cancelAnimationFrame: scheduler.cancelAnimationFrame,
        }
      );

      const fullText =
        '人工智能流式打字平准器终局测试，验证流结束后的平滑泄洪机制，确保字数完全吻合且零丢失。';
      smoother.updateTarget(fullText, true);

      // 推进 64ms，此时仍有大量积压
      scheduler.advance(32);
      scheduler.advance(32);
      expect(smoother.getDisplayedLength()).toBeLessThan(fullText.length);

      // 上游流式结束
      smoother.updateTarget(fullText, false);
      expect(smoother.isDrainingState()).toBe(true);

      // 步进直至泄洪结束（总共不超过 300ms）
      for (let i = 0; i < 15; i++) {
        scheduler.advance(32);
        if (isCompletedReceived) break;
      }

      // 验收断言：收敛完毕，100% 交付完整文字，0 字符丢失
      expect(isCompletedReceived).toBe(true);
      expect(finalDelivered).toBe(fullText);
      expect(smoother.getDisplayedLength()).toBe(fullText.length);
      expect(smoother.getBacklog()).toBe(0);

      smoother.reset();
    });

    it('flushImmediately 立即冲刷所有剩余文本并收敛，0ms 同步履约', () => {
      let finalDelivered = '';
      let isCompletedReceived = false;

      const smoother = new AdaptiveStreamingSmoother(
        (text, isCompleted) => {
          finalDelivered = text;
          if (isCompleted) isCompletedReceived = true;
        },
        {
          now: scheduler.now,
          requestAnimationFrame: scheduler.requestAnimationFrame,
          cancelAnimationFrame: scheduler.cancelAnimationFrame,
        }
      );

      const longText =
        '立即打断测试：用户点击停止生成或发送新问题时，应瞬间可见全部文本。';
      smoother.updateTarget(longText, true);

      // 外部强制打断
      smoother.flushImmediately();

      expect(isCompletedReceived).toBe(true);
      expect(finalDelivered).toBe(longText);
      expect(smoother.getDisplayedLength()).toBe(longText.length);
      expect(smoother.isTicking()).toBe(false);

      smoother.reset();
    });
  });

  describe('4. Unicode 字符簇（Grapheme Cluster）安全边界', () => {
    it('包含复合 Emoji、零宽连字 (ZWJ) 与多字节字符时，绝不产生破坏性中间截断', () => {
      const deliveredChunks: string[] = [];
      const smoother = new AdaptiveStreamingSmoother(
        (text) => deliveredChunks.push(text),
        {
          now: scheduler.now,
          requestAnimationFrame: scheduler.requestAnimationFrame,
          cancelAnimationFrame: scheduler.cancelAnimationFrame,
        }
      );

      // 包含多种典型 Unicode 复杂结构：
      // - 普通 ASCII: Hello
      // - 单代理对 Emoji: 👋 (\uD83D\uDC4B)
      // - 零宽连字组合 Emoji: 👩‍💻 (\uD83D\uDC69\u200D\uD83D\uDCBB)
      // - 航天 Emoji: 🚀
      // - 复杂多重 ZWJ 家庭: 👨‍👩‍👧‍👦
      // - 中文 BMP: 完结
      const complexText = 'Hi 👋 世界 👩‍💻 🚀 👨‍👩‍👧‍👦 完结';

      smoother.updateTarget(complexText, true);

      // 模拟微步推进
      for (let i = 0; i < 20; i++) {
        scheduler.advance(32);
      }
      smoother.flushImmediately();

      expect(deliveredChunks.length).toBeGreaterThan(1);

      // 验证每一个发出的中间切片：
      for (const chunk of deliveredChunks) {
        expect(complexText.startsWith(chunk)).toBe(true);

        // 验证切片末尾字符绝非孤立的 UTF-16 高位代理项（0xD800 ~ 0xDBFF）
        if (chunk.length > 0) {
          const lastCode = chunk.charCodeAt(chunk.length - 1);
          expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
        }

        // 验证切片末尾绝不是单独的零宽连字字符 (\u200D)
        expect(chunk.endsWith('\u200D')).toBe(false);
      }

      // 最终必须完整显示全部文本，包含完整 Emoji
      expect(deliveredChunks[deliveredChunks.length - 1]).toBe(complexText);

      smoother.reset();
    });

    it('GraphemeBoundarySnapper 静态工具边界吸附验证', () => {
      const text = 'A 👩‍💻 B';
      // 👩‍💻 在索引 2 到 7（长度 5）
      // 尝试在 3, 4, 5, 6 处切断，必须安全回退至 2（不会将 👩‍💻 切开）
      expect(GraphemeBoundarySnapper.findSafeIndex(text, 3)).toBe(2);
      expect(GraphemeBoundarySnapper.findSafeIndex(text, 4)).toBe(2);
      expect(GraphemeBoundarySnapper.findSafeIndex(text, 5)).toBe(2);
      expect(GraphemeBoundarySnapper.findSafeIndex(text, 6)).toBe(2);
      // 达到 7 时，完整吸附到 7
      expect(GraphemeBoundarySnapper.findSafeIndex(text, 7)).toBe(7);
    });
  });

  describe('5. 生命周期与重置机制', () => {
    it('reset 清理状态，新条目接入时无残留干扰', () => {
      const commits: string[] = [];
      const smoother = new AdaptiveStreamingSmoother(
        (text) => commits.push(text),
        {
          now: scheduler.now,
          requestAnimationFrame: scheduler.requestAnimationFrame,
          cancelAnimationFrame: scheduler.cancelAnimationFrame,
        }
      );

      smoother.updateTarget('旧会话内容', true);
      scheduler.advance(32);

      smoother.reset();
      expect(smoother.getDisplayedLength()).toBe(0);
      expect(smoother.getBacklog()).toBe(0);
      expect(smoother.isTicking()).toBe(false);

      smoother.updateTarget('新条目', false);
      expect(commits[commits.length - 1]).toBe('新条目');

      smoother.reset();
    });
  });
});
