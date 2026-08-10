/**
 * imeBridge 纯状态机测试（P1-B2）：composition 全流程 / Esc 取消 / 悬置兜底 /
 * 乱序防御 / 提交面语义（end 事件数据为权威）。
 */
import { describe, expect, it } from 'vitest';
import {
  createImeState,
  imeBridgeStep,
  type ImeBridgeEvent,
  type ImeState,
} from './imeBridge';

/** 可控时钟（测试确定性；按毫秒递增）。 */
function makeClock() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
const clock = makeClock();
const step = (state: ImeState, evt: ImeBridgeEvent, gapMs = 0) => {
  clock.advance(gapMs);
  return imeBridgeStep(state, evt, { now: clock.now });
};

describe('imeBridge 状态机', () => {
  it('完整组合流程：start → update×2 → end 整串提交一次', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    expect(s.phase).toBe('composing');
    s = step(s, { type: 'compositionupdate', text: '你' }).state;
    expect(s.buffer).toBe('你');
    s = step(s, { type: 'compositionupdate', text: '你好' }).state;
    expect(s.buffer).toBe('你好');
    const result = step(s, { type: 'compositionend', text: '你好' });
    expect(result.committed).toBe('你好');
    expect(result.hungReset).toBe(false);
    expect(result.state.phase).toBe('idle');
    expect(result.state.buffer).toBe('');
  });

  it('Esc 取消合成：compositionend 空串 → 不注入（12 §3.7）', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    s = step(s, { type: 'compositionupdate', text: '你' }).state;
    const result = step(s, { type: 'compositionend', text: '' });
    expect(result.committed).toBeNull();
    expect(result.state.phase).toBe('idle');
  });

  it('compositioncancel（平台取消/窗口失焦）：不注入且缓冲清空', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    s = step(s, { type: 'compositionupdate', text: '你好' }).state;
    const result = step(s, { type: 'compositioncancel' });
    expect(result.committed).toBeNull();
    expect(result.state.phase).toBe('idle');
    expect(result.state.buffer).toBe('');
  });

  it('提交面以 end 事件数据为权威（缓冲不参与提交，防陈旧缓冲泄漏）', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    s = step(s, { type: 'compositionupdate', text: '陈旧缓冲' }).state;
    const result = step(s, { type: 'compositionend', text: '世界' });
    expect(result.committed).toBe('世界');
  });

  it('229 键流悬置兜底：计数超阈值且 500ms 无更新 → 缓冲清空重置', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    s = step(s, { type: 'compositionupdate', text: '你好' }).state;
    // 3 次 229（间隔 100ms < 500ms）：不触发悬置
    for (let i = 0; i < 3; i++) {
      const r = step(s, { type: 'keydown229' }, 100);
      s = r.state;
      expect(r.hungReset).toBe(false);
    }
    // 第 4 次 229 且距上次事件 600ms（≥500ms）：悬置重置
    const result = step(s, { type: 'keydown229' }, 600);
    expect(result.hungReset).toBe(true);
    expect(result.state.buffer).toBe('');
    expect(result.state.hangCount).toBe(0);
    expect(result.state.phase).toBe('composing');
  });

  it('合成期高频 229（间隔 < 500ms）不触发悬置', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    for (let i = 0; i < 10; i++) {
      const r = step(s, { type: 'keydown229' }, 30);
      s = r.state;
      expect(r.hungReset).toBe(false);
    }
    expect(s.hangCount).toBe(10);
  });

  it('悬置重置后：迟到的 compositionend 以自身数据提交（不丢真实文本）', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    s = step(s, { type: 'compositionupdate', text: '你好' }).state;
    for (let i = 0; i < 4; i++) {
      s = step(s, { type: 'keydown229' }, 100).state;
    }
    const hung = step(s, { type: 'keydown229' }, 600);
    expect(hung.hungReset).toBe(true);
    // 迟到 end：仍以事件数据提交
    const result = step(hung.state, { type: 'compositionend', text: '你好世界' });
    expect(result.committed).toBe('你好世界');
  });

  it('乱序防御：compositionupdate 无合成期 → 忽略；end 无合成期 → 忽略', () => {
    const s = createImeState();
    const upd = step(s, { type: 'compositionupdate', text: 'x' });
    expect(upd.state).toBe(s);
    const end = step(s, { type: 'compositionend', text: 'x' });
    expect(end.committed).toBeNull();
    expect(end.state).toBe(s);
  });

  it('reset（停流/强制复位）：清空一切，不注入', () => {
    let s = createImeState();
    s = step(s, { type: 'compositionstart' }).state;
    s = step(s, { type: 'compositionupdate', text: '你好' }).state;
    const result = step(s, { type: 'reset' });
    expect(result.committed).toBeNull();
    expect(result.state).toEqual(createImeState(clock.now()));
  });
});
