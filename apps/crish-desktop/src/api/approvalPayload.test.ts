import { describe, expect, it } from 'vitest';
import {
  approverLabel,
  DELETE_UNKNOWN_IMPACT_HINT,
  deleteImpactSummary,
  extractDeleteTargets,
  formatBytes,
  formatRefAge,
  parseApprovalPayload,
  parseDeleteApprovalPayload,
  parseRevertGatePayload,
  revertGateSummary,
  shortPath,
} from './approvalPayload';

const revertGateRaw = {
  type: 'approval-requested',
  sessionId: 's1',
  timestamp: '2026-08-03T00:00:00.000Z',
  request: {
    id: 'approval-tc1',
    sessionId: 's1',
    cwd: '/ws',
    toolCallId: 'tc1',
    toolName: 'shell_command',
    parameters: { command: 'git checkout abc1234' },
    summary: 'call shell_command',
    toolMetadata: {},
    metadata: {
      revertGate: {
        form: 'git checkout abc1234',
        targetRef: 'abc1234',
        target: 'abc1234',
        area: {
          fileCount: 25,
          lineCount: 1200,
          crossDirectory: true,
          refAgeSeconds: 129600,
        },
        thresholds: { maxFiles: 10, maxLines: 300, maxRefAgeHours: 24 },
        approver: 'user',
        guidance: '请缩小回退范围或改用单文件修复',
      },
    },
  },
};

describe('parseRevertGatePayload 宽容解析', () => {
  it('嵌套 request.metadata.revertGate：完整载荷保真', () => {
    const p = parseRevertGatePayload(revertGateRaw);
    expect(p).not.toBeNull();
    expect(p?.targetRef).toBe('abc1234');
    expect(p?.area).toMatchObject({
      fileCount: 25,
      lineCount: 1200,
      crossDirectory: true,
      refAgeSeconds: 129600,
    });
    expect(p?.thresholds?.maxFiles).toBe(10);
    expect(p?.approver).toBe('user');
    expect(p?.guidance).toContain('单文件修复');
  });

  it('平铺 metadata.revertGate 与顶层 revertGate 均命中', () => {
    const flat = {
      metadata: { revertGate: { targetRef: 'x', area: { fileCount: 3 } } },
    };
    expect(parseRevertGatePayload(flat)?.targetRef).toBe('x');
    const top = { revertGate: { targetRef: 'y' } };
    expect(parseRevertGatePayload(top)?.targetRef).toBe('y');
  });

  it('缺失 / 非对象 → null（降级不报错）', () => {
    expect(parseRevertGatePayload(null)).toBeNull();
    expect(parseRevertGatePayload({})).toBeNull();
    expect(
      parseRevertGatePayload({ request: { metadata: { revertGate: 'x' } } })
    ).toBeNull();
  });

  it('字段类型错乱宽容：非法数字 → null（未知），字符串数字可用', () => {
    const p = parseRevertGatePayload({
      revertGate: { area: { fileCount: '12', lineCount: 'abc' } },
    });
    expect(p?.area?.fileCount).toBe(12);
    expect(p?.area?.lineCount).toBeNull();
  });
});

describe('parseDeleteApprovalPayload 删除确认载荷', () => {
  it('delete_dir + paths 数组：目标清单 + S8 impact', () => {
    const raw = {
      request: {
        toolName: 'delete_dir',
        parameters: { paths: ['src/old', 'dist/tmp'] },
        metadata: {
          impact: {
            fileCount: 12,
            directoryCount: 2,
            totalSizeBytes: 2048,
            crossDirectory: true,
            flagged: true,
          },
        },
      },
    };
    const p = parseDeleteApprovalPayload(raw);
    expect(p?.targets).toEqual(['src/old', 'dist/tmp']);
    expect(p?.impact).toMatchObject({
      fileCount: 12,
      directoryCount: 2,
      flagged: true,
    });
  });

  it('delete_file 单 path 字符串 + 顶层 impact 同样命中', () => {
    const raw = {
      request: { toolName: 'delete_file', parameters: { path: 'a.txt' } },
      impact: { fileCount: 1, totalSizeBytes: 300 },
    };
    const p = parseDeleteApprovalPayload(raw);
    expect(p?.targets).toEqual(['a.txt']);
    expect(p?.impact?.totalSizeBytes).toBe(300);
  });

  it('无目标 → null（不误判删除类）', () => {
    expect(
      parseDeleteApprovalPayload({
        request: { toolName: 'delete_file', parameters: {} },
      })
    ).toBeNull();
    expect(
      parseDeleteApprovalPayload({
        request: { toolName: 'delete_file', parameters: { paths: [] } },
      })
    ).toBeNull();
  });

  it('无 impact → 载荷仅目标清单（前端降级提示）', () => {
    const p = parseDeleteApprovalPayload({
      request: { toolName: 'delete_dir', parameters: { paths: ['x'] } },
    });
    expect(p).toEqual({ targets: ['x'] });
  });
});

describe('parseApprovalPayload 判别', () => {
  it('revertGate 优先于工具名判别', () => {
    const p = parseApprovalPayload(revertGateRaw);
    expect(p?.kind).toBe('revert-gate');
  });

  it('delete_file / delete_dir → delete 载荷', () => {
    const p = parseApprovalPayload({
      request: { toolName: 'delete_file', parameters: { paths: ['a'] } },
    });
    expect(p?.kind).toBe('delete');
  });

  it('无载荷 → null（既有卡行为不变）', () => {
    expect(
      parseApprovalPayload({
        request: { toolName: 'shell_command', parameters: { command: 'ls' } },
      })
    ).toBeNull();
    expect(parseApprovalPayload(null)).toBeNull();
    expect(parseApprovalPayload('x')).toBeNull();
  });
});

describe('中文文案格式化', () => {
  it('formatRefAge：天/小时/分钟/未知', () => {
    expect(formatRefAge(3 * 24 * 3600)).toBe('3 天');
    expect(formatRefAge(129600)).toBe('36.0 小时');
    expect(formatRefAge(600)).toBe('10 分钟');
    expect(formatRefAge(null)).toBe('未知');
  });

  it('formatBytes：B / KB / MB / 未知', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(undefined)).toBe('未知');
  });

  it('revertGateSummary：文件/行/ref 年代/跨目录/目标', () => {
    const s = revertGateSummary({
      targetRef: 'abc1234',
      area: {
        fileCount: 25,
        lineCount: 1200,
        crossDirectory: true,
        refAgeSeconds: 129600,
      },
    });
    expect(s).toContain('影响 25 个文件');
    expect(s).toContain('1200 行');
    expect(s).toContain('36.0 小时');
    expect(s).toContain('跨目录');
    expect(s).toContain('目标 abc1234');
    expect(revertGateSummary({ area: { fileCount: null } })).toBe('');
  });

  it('approverLabel：user → 用户（我）；其它原样', () => {
    expect(approverLabel('user')).toBe('审批人：用户（我）');
    expect(approverLabel('admin')).toBe('审批人：admin');
    expect(approverLabel(null)).toBe('');
  });

  it('deleteImpactSummary 与降级提示', () => {
    expect(
      deleteImpactSummary({
        fileCount: 12,
        directoryCount: 2,
        totalSizeBytes: 2048,
        crossDirectory: true,
        flagged: true,
      })
    ).toContain('12 个文件');
    expect(deleteImpactSummary(undefined)).toBe('');
    expect(DELETE_UNKNOWN_IMPACT_HINT).toContain('回收站恢复');
  });

  it('extractDeleteTargets 容错：数组/单值/非法项', () => {
    expect(extractDeleteTargets({ paths: ['a', 1, '', null] })).toEqual(['a']);
    expect(extractDeleteTargets({ path: 'b' })).toEqual(['b']);
    expect(extractDeleteTargets({})).toEqual([]);
  });

  it('shortPath：超长截尾', () => {
    expect(shortPath('a.txt')).toBe('a.txt');
    expect(shortPath('x'.repeat(100)).length).toBeLessThanOrEqual(49);
    expect(shortPath('')).toBe('');
  });
});
