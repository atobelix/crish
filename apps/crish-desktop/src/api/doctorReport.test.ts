import { describe, expect, it } from 'vitest';
import {
  doctorCapabilitiesFromSnapshot,
  doctorStatusFromEngine,
  extractCapabilityEntries,
  formatDoctorReport,
} from './doctorReport';

describe('formatDoctorReport', () => {
  it('marks fully missing status/capabilities as 未提供', () => {
    const md = formatDoctorReport(null, null);
    expect(md).toContain('## 诊断报告');
    expect(md).toContain('### 引擎状态');
    expect(md).toContain('- 状态快照：未提供');
    expect(md).toContain('### 能力');
    expect(md).toContain('- 能力快照：未提供');
    expect(md).toContain('不表示检查通过');
  });

  it('is honest about partial status fields (unknown / 未提供)', () => {
    const md = formatDoctorReport(
      { ok: true, connected: false, error: 'timeout' },
      undefined,
    );
    expect(md).toContain('- 可用（ok）：是');
    expect(md).toContain('- 已连接：否');
    expect(md).toContain('- 模型：未提供');
    expect(md).toContain('- Base URL：未提供');
    expect(md).toContain('- API Key：未知');
    expect(md).toContain('- 凭证模式：未提供');
    expect(md).toContain('- 错误：timeout');
    expect(md).toContain('- 能力快照：未提供');
    // 未给出 reconnecting / counts 时不伪造行
    expect(md).not.toContain('重连中');
    expect(md).not.toContain('活动 runs');
  });

  it('renders capability list and lifecycle honestly', () => {
    const md = formatDoctorReport(
      {
        ok: true,
        connected: true,
        reconnecting: false,
        model: 'gpt-test',
        baseUrl: 'https://api.example',
        hasApiKey: true,
        credentialMode: 'direct',
        activeRuns: 1,
        pendingApprovals: 0,
      },
      {
        mcp: 'ready',
        lifecycle: {
          state: 'ready',
          reason: 'ok',
          configuredHint: true,
        },
        capabilities: [
          { id: 'mcp.lifecycle', state: 'ready', reason: 'ok' },
          { id: 'binary-frame', state: 'unsupported' },
          {},
        ],
      },
    );
    expect(md).toContain('- 模型：gpt-test');
    expect(md).toContain('- Base URL：https://api.example');
    expect(md).toContain('- API Key：已配置');
    expect(md).toContain('- 活动 runs：1');
    expect(md).toContain('- 待审批：0');
    expect(md).toContain('- MCP：ready');
    expect(md).toContain('- mcp.lifecycle.state：ready');
    expect(md).toContain('`mcp.lifecycle`: ready — ok');
    expect(md).toContain('`binary-frame`: unsupported');
    expect(md).toContain('`(无 id)`: 未知');
  });

  it('distinguishes empty cap list vs missing vs lifecycle null', () => {
    expect(
      formatDoctorReport({ ok: true }, { mcp: undefined, capabilities: [] }),
    ).toContain('- 能力列表：空');
    expect(
      formatDoctorReport({ ok: true }, { mcp: 'x' }),
    ).toContain('- 能力列表：未提供');
    expect(
      formatDoctorReport({ ok: true }, { lifecycle: null, capabilities: [] }),
    ).toContain('- mcp.lifecycle：无');
    expect(
      formatDoctorReport(
        { ok: true },
        { lifecycle: undefined, capabilities: [] },
      ),
    ).toContain('- mcp.lifecycle：未提供');
  });

  it('optional fetchedAt ISO line; pure / stable', () => {
    const a = formatDoctorReport(
      { ok: false, hasApiKey: false },
      { error: 'caps_failed' },
      { fetchedAt: 0 },
    );
    const b = formatDoctorReport(
      { ok: false, hasApiKey: false },
      { error: 'caps_failed' },
      { fetchedAt: 0 },
    );
    expect(a).toEqual(b);
    expect(a).toContain('时间：1970-01-01T00:00:00.000Z');
    expect(a).toContain('- API Key：未配置');
    expect(a).toContain('- 错误：caps_failed');
  });
});

describe('extractCapabilityEntries / mappers', () => {
  it('extracts from root or snapshot.capabilities', () => {
    expect(extractCapabilityEntries(null)).toBeUndefined();
    expect(extractCapabilityEntries({})).toBeUndefined();
    expect(
      extractCapabilityEntries({
        capabilities: [{ id: 'a', state: 'on' }],
      }),
    ).toEqual([{ id: 'a', state: 'on', reason: undefined }]);
    expect(
      extractCapabilityEntries({
        snapshot: {
          capabilities: [{ id: 'b', state: 'off', reason: 'x' }],
        },
      }),
    ).toEqual([{ id: 'b', state: 'off', reason: 'x' }]);
  });

  it('doctorStatusFromEngine maps arrays to counts without inventing', () => {
    expect(doctorStatusFromEngine(null)).toBeNull();
    expect(
      doctorStatusFromEngine({
        ok: true,
        activeRuns: [{ runId: 'r1' }, { runId: 'r2' }],
        pendingApprovals: [],
      }),
    ).toMatchObject({
      ok: true,
      activeRuns: 2,
      pendingApprovals: 0,
    });
    expect(
      doctorStatusFromEngine({ ok: true, activeRuns: 3, pendingApprovals: 1 }),
    ).toMatchObject({ activeRuns: 3, pendingApprovals: 1 });
    // 无 runs 字段 → 不出现在切片中
    const thin = doctorStatusFromEngine({ ok: false, error: 'e' });
    expect(thin).toEqual({
      ok: false,
      connected: undefined,
      reconnecting: undefined,
      model: undefined,
      baseUrl: undefined,
      hasApiKey: undefined,
      credentialMode: undefined,
      error: 'e',
    });
  });

  it('doctorCapabilitiesFromSnapshot wires raw + lifecycle', () => {
    expect(doctorCapabilitiesFromSnapshot(null)).toBeNull();
    const slice = doctorCapabilitiesFromSnapshot({
      mcp: 'ready',
      lifecycle: { state: 'ready' },
      raw: { capabilities: [{ id: 'x', state: 'ready' }] },
    });
    expect(slice?.mcp).toBe('ready');
    expect(slice?.lifecycle).toEqual({ state: 'ready' });
    expect(slice?.capabilities).toEqual([
      { id: 'x', state: 'ready', reason: undefined },
    ]);
  });
});
