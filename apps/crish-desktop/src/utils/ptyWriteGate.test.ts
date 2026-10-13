/* eslint-disable no-control-regex */
import { describe, expect, it, vi } from 'vitest';
import {
  ANSI_RESET,
  CHUNK_FLUSH_BYTES,
  FRAME_BUDGET_MS,
  MAX_PENDING_BYTES,
  OVERFLOW_WARNING,
  createPtyWriteGate,
  createSotaPtyWriteGate,
  findSafeSliceIndex,
  healHeadSliceIndex,
} from './ptyWriteGate';

describe('findSafeSliceIndex 边界感知与零步长死锁防护 (Zero-Progress Watchdog)', () => {
  it('识别未闭合的 ANSI CSI 24 位真彩色序列并回退至 \\x1b 之前', () => {
    const prefix = 'Normal text before color ';
    const incompleteCsi = '\x1b[38;2;255;128;0mColored';
    const full = prefix + incompleteCsi;

    // 切分点恰好落在 "\x1b[38;2;255;" 处
    const cutPoint = prefix.length + '\x1b[38;2;255;'.length;
    const safeIdx = findSafeSliceIndex(full, cutPoint);
    expect(safeIdx).toBe(prefix.length);
    expect(full.slice(0, safeIdx)).toBe(prefix);
    expect(full.slice(safeIdx)).toBe(incompleteCsi);
  });

  it('识别已闭合的 CSI 序列时不发生误回退', () => {
    const str = 'Hello \x1b[32mGreen\x1b[0m World';
    const cutPoint = 'Hello \x1b[32mGr'.length;
    expect(findSafeSliceIndex(str, cutPoint)).toBe(cutPoint);
  });

  it('识别未闭合的 ANSI OSC 序列 (\\x1b]0;Title\\x07) 并回退至 \\x1b 之前', () => {
    const prefix = 'Prompt$ ';
    const osc = '\x1b]0;Conex Terminal Session\x07After';
    const full = prefix + osc;

    const cutPoint = prefix.length + '\x1b]0;Conex Term'.length;
    const safeIdx = findSafeSliceIndex(full, cutPoint);
    expect(safeIdx).toBe(prefix.length);
  });

  it('识别切分点恰好落在裸 \\x1b 字节时的安全回退', () => {
    const prefix = 'Line output ';
    const full = `${prefix}\x1b[31mRed`;
    // 切分点恰好只包含单个 \x1b
    const cutPoint = prefix.length + 1;
    expect(full.slice(prefix.length, cutPoint)).toBe('\x1b');
    const safeIdx = findSafeSliceIndex(full, cutPoint);
    expect(safeIdx).toBe(prefix.length);
  });

  it('识别 UTF-16 高位代理对 (0xD800..0xDBFF) 并回退 1 位防止 Emoji 腰斩乱码', () => {
    // '🚀' 的 UTF-16 长度为 2 (0xD83D, 0xDE80)
    const str = 'Rocket 🚀 Launch';
    const rocketStart = 'Rocket '.length;
    // 在 🚀 的第一个 code unit 处切分
    const safeIdx = findSafeSliceIndex(str, rocketStart + 1);
    expect(safeIdx).toBe(rocketStart);
  });

  it('内置 Zero-Progress Watchdog：当 maxLen 极小且开头即为未闭合 CSI 时前向寻踪闭合点，绝不返回 0 导致死循环', () => {
    const str = '\x1b[38;2;255;128;64mHello World';
    // maxLen = 4 落在 "\x1b[38" 处，回退至 escIndex 会得到 0；Watchdog 应前向寻踪至 'm' 之后 (长度 18)
    const safeIdx = findSafeSliceIndex(str, 4);
    expect(safeIdx).toBeGreaterThan(0);
    expect(str.slice(0, safeIdx)).toBe('\x1b[38;2;255;128;64m');
  });

  it('healHeadSliceIndex 在头部截断时自动跳过被腰斩的 CSI 残片与低位代理项', () => {
    const str = 'OldText\x1b[48;2;12;34;56mNewText';
    const rawCut = 'OldText\x1b[48;2;'.length;
    const healedIdx = healHeadSliceIndex(str, rawCut);
    expect(str.slice(healedIdx)).toBe('NewText');
  });
});

describe('SotaPtyWriteGate 512KB 有界流控与魔鬼用例验证', () => {
  it('溢出颜色复位断言：向 512KB 门闩注入超过 600KB 数据，头部丢弃后首字符为 \\x1b[0m 且包含 OVERFLOW_WARNING', () => {
    const chunks: string[] = [];
    const gate = createSotaPtyWriteGate({
      write: (d) => chunks.push(d),
    });

    // 注入 620KB 带颜色的日志数据
    const line =
      '\x1b[31m[ERROR] Memory dump line 0123456789abcdef0123456789abcdef\r\n';
    const count = Math.ceil((620 * 1024) / line.length);
    for (let i = 0; i < count; i++) {
      gate.write(line);
    }

    expect(gate.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
    expect(gate.hasOverflowWarning()).toBe(true);

    gate.flushAllPending();
    const combined = chunks.join('');
    expect(combined.startsWith(ANSI_RESET)).toBe(true);
    expect(combined.startsWith(OVERFLOW_WARNING)).toBe(true);
  });

  it('【DEVIL-07-1】ANSI CSI 序列超长参数在 32KB 帧边界与跨分片处断裂自愈（0 乱码、0 背景色污染）', () => {
    const writtenFrames: string[] = [];
    const gate = createPtyWriteGate({
      write: (d) => writtenFrames.push(d),
    });

    // 1. 构造在 32KB (32768) 边界处恰好切入 "\x1b[48;2;12;34;56;38;2;78;90;12mText\x1b[0m" 中间的大缓冲
    const colorSeq = '\x1b[48;2;12;34;56;38;2;78;90;12mText\x1b[0m';
    const padLen = CHUNK_FLUSH_BYTES - '\x1b[48;2;12;34;56;38;2;'.length;
    const prefix = 'A'.repeat(padLen);
    const payload = prefix + colorSeq + 'B'.repeat(1024);

    gate.write(payload);

    // 第一帧排空：必须在 \x1b 之前安全停下，严禁把半截 "\x1b[48;2;12;34;56;38;2;" 写入终端
    const frame1 = gate.flushFrame();
    expect(frame1.bytesWritten).toBe(padLen);
    expect(writtenFrames[0]).toBe(prefix);
    expect(writtenFrames[0]!.endsWith('\x1b[48;2;12;34;56;38;2;')).toBe(false);

    // 第二帧排空：完整的 colorSeq 在第二帧开头被原子写入
    gate.flushFrame();
    expect(writtenFrames[1]!.startsWith(colorSeq)).toBe(true);

    // 2. 验证两次独立 write() 调用人为制造的跨片切割："\x1b[48;2;12;34;56;38;2;" | "78;90;12mText\x1b[0m"
    writtenFrames.length = 0;
    gate.reset();
    gate.write('Header:' + '\x1b[48;2;12;34;56;38;2;');
    gate.write('78;90;12mText\x1b[0m');
    gate.flushAllPending();

    // 断言没有任何一次 sink.write 包含未闭合的半截 CSI 残片
    for (const frame of writtenFrames) {
      expect(frame).not.toMatch(/\x1b\[[0-9;]*$/);
      expect(frame).not.toMatch(/^[0-9;]+m/);
    }
    expect(writtenFrames.join('')).toBe(
      'Header:\x1b[48;2;12;34;56;38;2;78;90;12mText\x1b[0m'
    );
  });

  it('【DEVIL-07-2】5MB/s PTY 持续轰炸与隐藏窗格切换（隐藏期 write=0，单帧耗时 <= 8ms，内存峰值 <= 512KB）', () => {
    let writeCallsWhileHidden = 0;
    let totalBytesReceived = 0;
    const gate = createSotaPtyWriteGate(
      {
        write: (d) => {
          if (gate.isHidden()) {
            writeCallsWhileHidden++;
          }
          totalBytesReceived += d.length;
        },
      },
      true // 初始处于后台隐藏 Tab
    );

    expect(gate.getState()).toBe('Buffering');

    // 模拟 5MB 高速彩色日志持续轰炸
    const chunk64k =
      '\x1b[38;2;80;200;120m[BUILD] Compiling crate conex-engine...\x1b[0m\r\n'.repeat(
        960
      );
    const totalToPump = 5 * 1024 * 1024; // 5MB
    let pumped = 0;
    while (pumped < totalToPump) {
      gate.write(chunk64k);
      pumped += chunk64k.length;
      // 隐藏期间内存缓冲严格受控于 512KB 上限
      expect(gate.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);
    }

    // 隐藏期间尝试调用 flushFrame 也必须保持 write === 0
    const hiddenFlush = gate.flushFrame();
    expect(hiddenFlush.bytesWritten).toBe(0);
    expect(writeCallsWhileHidden).toBe(0);

    // 切换回前台显现，分帧排空并验证每帧耗时与单帧字节上限
    gate.setHidden(false);
    expect(gate.getState()).toBe('Draining');

    let frameCount = 0;
    while (gate.pendingLength() > 0) {
      const t0 = performance.now();
      const { bytesWritten } = gate.flushFrame();
      const elapsed = performance.now() - t0;
      frameCount++;
      expect(bytesWritten).toBeLessThanOrEqual(CHUNK_FLUSH_BYTES);
      expect(elapsed).toBeLessThanOrEqual(FRAME_BUDGET_MS * 2);
      if (frameCount > 32) break;
    }

    expect(gate.pendingLength()).toBe(0);
    expect(gate.getState()).toBe('PassThrough');
    expect(totalBytesReceived).toBeGreaterThan(0);
    expect(writeCallsWhileHidden).toBe(0);
  });

  it('当 xterm 实例在 dispose 期间抛出异常时，门闩自动捕获并清空队列实现零死锁自愈', () => {
    const brokenSink = {
      write: vi.fn(() => {
        throw new Error('Terminal disposed');
      }),
    };
    const gate = createSotaPtyWriteGate(brokenSink);
    gate.write('some terminal output');
    expect(gate.pendingLength()).toBeGreaterThan(0);

    expect(() => gate.flushFrame()).not.toThrow();
    expect(gate.pendingLength()).toBe(0);
    expect(gate.pendingCount()).toBe(0);
  });
});
