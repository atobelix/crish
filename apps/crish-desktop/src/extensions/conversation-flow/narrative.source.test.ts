/**
 * S3 源码锁：无竖轨、无 innerHTML 清空、无 rail token、无原生 title。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

function collect(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
      continue;
    }
    if (extname(name) === '.ts' || extname(name) === '.tsx' || extname(name) === '.css') {
      out.push(full);
    }
  }
  return out;
}

describe('conversation-flow 叙事块源码锁', () => {
  const files = collect(DIR).filter((p) => !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'));

  it('无 FlowTimelineRail / getBoundingClientRect / innerHTML 清空', () => {
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/FlowTimelineRail/);
      expect(src, file).not.toMatch(/getBoundingClientRect/);
      expect(src, file).not.toMatch(/innerHTML\s*=\s*['"]{2}/);
    }
  });

  it('CSS 无 --brand / rail / --accent-blue', () => {
    for (const file of files.filter((p) => p.endsWith('.css'))) {
      const src = readFileSync(file, 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/--brand/);
      expect(code, file).not.toMatch(/--accent-blue/);
      expect(code, file).not.toMatch(/--rail/);
    }
  });

  it('组件不写原生 title 属性', () => {
    for (const file of files.filter((p) => p.endsWith('.tsx'))) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/\btitle=["']/);
    }
  });

  it('MessageContent 消费可选 renderTools / renderThought', () => {
    const src = readFileSync(
      join(DIR, '../../components/chat-message/MessageContent.tsx'),
      'utf8'
    );
    expect(src).toMatch(/useNarrativeRenderSlots/);
    expect(src).toMatch(/renderTools/);
    expect(src).toMatch(/renderThought/);
    expect(src).toMatch(/TimelineThoughtSection/);
    expect(src).toMatch(/MessageToolCallsSection/);
  });

  it('activate 仍默认关', () => {
    const src = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(src).toMatch(/return officialOverride \?\? false/);
  });

  it('PermissionBar 无 5 分钟老虎机 / 无倒计时槽', () => {
    const src = readFileSync(join(DIR, 'PermissionBar.tsx'), 'utf8');
    expect(src).not.toMatch(/slot-timer/);
    expect(src).not.toMatch(/secondsLeft\s*=\s*300/);
    expect(src).not.toMatch(/secondsLeft/);
    expect(src).not.toMatch(/\btitle=/);
  });

  it('S8：计划模式不自动开插件；无演示 Hub / 五步剧本 / 竖轨 ::after', () => {
    const activateSrc = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(activateSrc).not.toMatch(/selectPlanModeEnabled|planModeEnabled|inPlanMode/);

    const demo =
      /摸清 crates\/session-loop|IPC 通道瓶颈|虚拟流式渲染管线|cargo test --workspace|IPC 性能优化评审/;
    const hub = /plan-progress-bar|plan-collapsed|plan-mode-badge|FlowTimelineRail/;
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(demo);
      expect(src, file).not.toMatch(hub);
    }

    const css = readFileSync(join(DIR, 'narrative.module.css'), 'utf8');
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/::after/);
  });
});
