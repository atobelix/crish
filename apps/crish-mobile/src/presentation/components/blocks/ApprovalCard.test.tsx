// ApprovalCard 组件测试（R2UX-04-04/06 断言 + F2 §4.2 卡字段 + 打码纪律）：
// 渲染（工具名/风险徽标/参数摘要打码/倒计时/会话 run 上下文）、决策状态行、纯函数（打码/摘要/倒计时格式）
// 注：@testing-library/react-native v14 render/fireEvent 为异步 API，全部 await
import { render, screen } from '@testing-library/react-native';
import type { ApprovalItem } from '@/domain/types/domain';
import type { PermissionRequest } from '../../../../../../packages/shared-types/src/generated/engine/types';
import ApprovalCard, {
  COUNTDOWN_WARNING_MS,
  decisionStatusText,
  formatRemainingMs,
  maskCommandSecrets,
  maskSensitiveParamValue,
  summarizeParameters,
} from './ApprovalCard';

const NOW = 1_800_000_000_000;

function makeRequest(
  overrides: Partial<PermissionRequest> = {}
): PermissionRequest {
  return {
    id: 'approval-call-1',
    sessionId: 's-1',
    cwd: 'C:\\work',
    toolCallId: 'call-1',
    toolName: 'write_file',
    parameters: { path: 'a.ts' },
    summary: 'write a.ts',
    toolMetadata: {},
    ...overrides,
  };
}

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    request: makeRequest(),
    runId: null,
    arbiter: 'user',
    dangerLevel: 1,
    receivedAtMs: NOW,
    expiresAt: NOW + 120_000,
    status: 'pending',
    decisionStatus: 'idle',
    decisionBusy: false,
    ...overrides,
  };
}

describe('ApprovalCard 渲染（F2 §4.2 卡字段）', () => {
  it('展示工具名/高风险徽标/打码参数摘要/倒计时/会话与 run 上下文', async () => {
    const item = makeItem({
      request: makeRequest({
        toolName: 'delete_file',
        parameters: { path: '/src/deprecated/a.ts', apiKey: 'sk-abcdef123456' },
      }),
      dangerLevel: 2,
      runId: 'run-42',
    });
    await render(<ApprovalCard item={item} remainingMs={102_000} />);

    expect(screen.getByText('delete_file')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();
    // 敏感参数打码（保留末 4 位），普通参数原样展示
    expect(
      screen.getByText('path=/src/deprecated/a.ts · apiKey=****3456')
    ).toBeTruthy();
    expect(screen.getByText('1:42')).toBeTruthy();
    expect(screen.getByText('会话 s-1 · run run-42')).toBeTruthy();
  });

  it('L1 条目显示灰色「需确认」徽标，普通参数不打码', async () => {
    const item = makeItem({
      request: makeRequest({
        toolName: 'git push',
        parameters: { branch: 'main' },
      }),
      dangerLevel: 1,
    });
    await render(<ApprovalCard item={item} remainingMs={58_000} />);

    expect(screen.getByText('需确认')).toBeTruthy();
    expect(screen.getByText('branch=main')).toBeTruthy();
    expect(screen.queryByText('高风险')).toBeNull();
  });

  it('命令类条目以命令行摘要展示（含脱敏）', async () => {
    const item = makeItem({
      request: makeRequest({
        toolName: 'command',
        parameters: {
          command:
            'curl -H "Authorization: Bearer abcdEFGH" https://example.com',
        },
      }),
      riskMeta: {
        command: 'curl -H "Authorization: Bearer abcdEFGH" https://example.com',
      },
    });
    await render(<ApprovalCard item={item} remainingMs={120_000} />);

    expect(
      screen.getByText(
        '$ curl -H "Authorization: Bearer ****FGH" https://example.com'
      )
    ).toBeTruthy();
  });
});

describe('ApprovalCard 倒计时（R2UX-04-06 / F2 §4.2-4）', () => {
  it('剩余 15 秒内显示红色「即将过期」警示', async () => {
    const item = makeItem();
    await render(
      <ApprovalCard item={item} remainingMs={COUNTDOWN_WARNING_MS} />
    );

    expect(screen.getByText('0:15')).toBeTruthy();
    expect(screen.getByTestId('countdown-warning').children).toEqual([
      '即将过期',
    ]);
  });

  it('剩余时间归零显示 0:00', async () => {
    const item = makeItem();
    await render(<ApprovalCard item={item} remainingMs={0} />);
    expect(screen.getByText('0:00')).toBeTruthy();
  });
});

describe('ApprovalCard 决策状态行（R2UX-04-04 / F2 §3.3 状态机）', () => {
  it.each([
    ['deciding', '处理中…'],
    ['queued', '待发送 · 网络恢复后自动发送'],
    ['conflict', '状态可能已变化，点击查看'],
    ['expired', '已过期（超过 120 秒），决策未生效'],
    ['approved', '已允许'],
    ['denied', '已拒绝'],
  ] as const)('status=%s 显示「%s」', async (status, text) => {
    const item = makeItem({ status });
    await render(<ApprovalCard item={item} remainingMs={90_000} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('发送通道失败回滚（pending + failed）显示「决策未送达，将自动重试」', async () => {
    const item = makeItem({ status: 'pending', decisionStatus: 'failed' });
    await render(<ApprovalCard item={item} remainingMs={90_000} />);
    expect(screen.getByText('决策未送达，将自动重试')).toBeTruthy();
  });

  it('pending 空闲态不显示状态行', async () => {
    const item = makeItem({ status: 'pending', decisionStatus: 'idle' });
    await render(<ApprovalCard item={item} remainingMs={90_000} />);
    expect(screen.queryByTestId('decision-status')).toBeNull();
  });

  it('main-agent 只读条目显示「等待 Agent 裁决」（F2 §4.4）', async () => {
    const item = makeItem({ arbiter: 'main-agent', status: 'pending' });
    await render(<ApprovalCard item={item} remainingMs={90_000} />);
    expect(screen.getByText('等待 Agent 裁决')).toBeTruthy();
  });
});

describe('ApprovalCard 纯函数', () => {
  it('formatRemainingMs：mm:ss 口径（F2 §4.2）', () => {
    expect(formatRemainingMs(0)).toBe('0:00');
    expect(formatRemainingMs(15_000)).toBe('0:15');
    expect(formatRemainingMs(58_000)).toBe('0:58');
    expect(formatRemainingMs(102_000)).toBe('1:42');
    expect(formatRemainingMs(120_000)).toBe('2:00');
    expect(formatRemainingMs(-5_000)).toBe('0:00');
  });

  it('maskSensitiveParamValue：敏感键打码保留末 4 位，普通键原样', () => {
    expect(maskSensitiveParamValue('apiKey', 'sk-abcdef123456')).toBe(
      '****3456'
    );
    expect(maskSensitiveParamValue('API_KEY', 'sk-abcdef123456')).toBe(
      '****3456'
    );
    expect(maskSensitiveParamValue('providerToken', 'a1b2c3d4e5f6')).toBe(
      '****e5f6'
    );
    expect(maskSensitiveParamValue('password', 'hunter2')).toBe('****ter2');
    expect(maskSensitiveParamValue('path', 'a.ts')).toBe('a.ts');
    expect(maskSensitiveParamValue('command', 'ls -la')).toBe('ls -la');
  });

  it('maskSensitiveParamValue：短值整体打码，非字符串值字符串化后打码', () => {
    expect(maskSensitiveParamValue('token', 'abc')).toBe('****');
    expect(maskSensitiveParamValue('secret', 12345)).toBe('****2345');
    expect(maskSensitiveParamValue('secret', true)).toBe('****true');
    expect(maskSensitiveParamValue('path', true)).toBe('true');
  });

  it('maskCommandSecrets：--flag 值 / Bearer 令牌脱敏保留末 4 位', () => {
    expect(
      maskCommandSecrets('git push --api-key sk-abcdef123456 --force')
    ).toBe('git push --api-key=****3456 --force');
    expect(
      maskCommandSecrets('curl -H "Authorization: Bearer abcdEFGH" url')
    ).toContain('Bearer ****FGH');
    expect(maskCommandSecrets('ls -la')).toBe('ls -la');
  });

  it('summarizeParameters：拼接打码键值对并截断超长', () => {
    const params = { path: 'a.ts', recursive: true, apiKey: 'sk-abcdef123456' };
    expect(summarizeParameters(params)).toBe(
      'path=a.ts · recursive=true · apiKey=****3456'
    );
    const long = summarizeParameters({ path: 'x'.repeat(200) }, 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('…')).toBe(true);
  });

  it('summarizeParameters：非对象参数兜底字符串化', () => {
    expect(summarizeParameters('just-a-string')).toBe('just-a-string');
    expect(summarizeParameters([1, 2, 3])).toBe('[1,2,3]');
  });

  it('decisionStatusText 状态映射覆盖全状态', () => {
    expect(decisionStatusText(makeItem({ status: 'deciding' }))?.text).toBe(
      '处理中…'
    );
    expect(decisionStatusText(makeItem({ status: 'queued' }))?.text).toContain(
      '待发送'
    );
    expect(decisionStatusText(makeItem({ status: 'expired' }))?.text).toContain(
      '已过期'
    );
    expect(
      decisionStatusText(
        makeItem({ status: 'pending', decisionStatus: 'idle' })
      )
    ).toBeNull();
  });
});
