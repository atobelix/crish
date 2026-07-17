import { describe, expect, it } from 'vitest';
import {
  APPROVAL_RISK_LEVEL_LABELS,
  APPROVAL_RISK_LEVELS,
  APPROVAL_TRUST_ZONE_LABELS,
  APPROVAL_TRUST_ZONES,
  EMPTY_APPROVAL_RISK_META,
  approvalRiskBadgeLabel,
  approvalRiskKindLabel,
  approvalRiskLevelHint,
  approvalRiskLevelLabel,
  approvalRiskSummary,
  approvalRiskTone,
  approvalTrustZoneHint,
  approvalTrustZoneLabel,
  approvalZoneHint,
  coerceApprovalRiskMeta,
  coerceMetaText,
  hasApprovalRiskFacts,
  isEmptyApprovalRiskMeta,
  isKnownTrustZone,
  normalizeRiskLevel,
  normalizeTrustZone,
  parseApprovalRiskMeta,
  rememberPrefixFromToolArgs,
  type ApprovalRiskMeta,
} from './approvalMeta';
import { extractCommandForMatch } from './commandPermissions';

describe('parseApprovalRiskMeta', () => {
  it('reads backend trustZone + requiresDoubleConfirm from nested metadata', () => {
    const meta = parseApprovalRiskMeta({
      type: 'approval-requested',
      toolCallId: 't1',
      risk: 'destructive',
      riskReason: 'rm -rf',
      requiresDoubleConfirm: true,
      metadata: { trustZone: 'T3', riskLevel: 'high' },
    });
    expect(meta).toMatchObject({
      trustZone: 'T3',
      risk: 'destructive',
      riskReason: 'rm -rf',
      requiresDoubleConfirm: true,
      riskLevel: 'high',
      source: 'backend',
    });
  });

  it('derives double-confirm from T4 hardline when flags omitted', () => {
    const meta = parseApprovalRiskMeta({
      request: {
        toolCallId: 't2',
        toolName: 'shell_command',
        metadata: { trustZone: 'T4', hardline: true, risk: 'hardline' },
      },
    });
    expect(meta.requiresDoubleConfirm).toBe(true);
    expect(meta.riskLevel).toBe('critical');
    expect(meta.recommendSnapshot).toBe(true);
  });

  it('returns unknown source when no backend facts', () => {
    const meta = parseApprovalRiskMeta({ toolCallId: 'x', toolName: 'edit' });
    expect(meta.source).toBe('unknown');
    expect(meta.riskLevel).toBe('unknown');
    expect(isEmptyApprovalRiskMeta(meta)).toBe(true);
  });

  it('never throws on null / primitive / empty event', () => {
    for (const bad of [null, undefined, '', 0, true, [], 'oops']) {
      const meta = parseApprovalRiskMeta(bad);
      expect(meta.riskLevel).toBe('unknown');
      expect(meta.source).toBe('unknown');
      expect(meta.requiresDoubleConfirm).toBe(false);
      expect(isEmptyApprovalRiskMeta(meta)).toBe(true);
    }
  });

  it('normalizes lowercase trustZone and riskLevel from mixed shapes', () => {
    const meta = parseApprovalRiskMeta({
      request: {
        trustZone: 't4',
        riskLevel: 'CRITICAL',
        risk: 'Hardline',
      },
    });
    expect(meta.trustZone).toBe('T4');
    expect(meta.riskLevel).toBe('critical');
    expect(meta.requiresDoubleConfirm).toBe(true);
    expect(meta.recommendSnapshot).toBe(true);
    expect(meta.source).toBe('backend');
  });

  it('treats riskReason-only as backend fact (not empty)', () => {
    const meta = parseApprovalRiskMeta({ riskReason: '  可能删除生产数据  ' });
    expect(meta.riskReason).toBe('可能删除生产数据');
    expect(meta.source).toBe('backend');
    expect(isEmptyApprovalRiskMeta(meta)).toBe(false);
    expect(hasApprovalRiskFacts(meta)).toBe(true);
  });

  it('derives medium from T1/T2 and recommends snapshot on T1', () => {
    const t1 = parseApprovalRiskMeta({ metadata: { trustZone: 'T1' } });
    expect(t1.riskLevel).toBe('medium');
    expect(t1.recommendSnapshot).toBe(true);
    expect(t1.requiresDoubleConfirm).toBe(false);

    const t2 = parseApprovalRiskMeta({ metadata: { trustZone: 't2' } });
    expect(t2.trustZone).toBe('T2');
    expect(t2.riskLevel).toBe('medium');
    expect(t2.recommendSnapshot).toBe(false);
  });

  it('explicit false flags win over zone defaults', () => {
    const meta = parseApprovalRiskMeta({
      metadata: {
        trustZone: 'T4',
        requiresDoubleConfirm: false,
        recommendSnapshot: false,
      },
    });
    expect(meta.riskLevel).toBe('critical');
    expect(meta.requiresDoubleConfirm).toBe(false);
    expect(meta.recommendSnapshot).toBe(false);
  });

  it('ignores whitespace-only zone / risk fields', () => {
    const meta = parseApprovalRiskMeta({
      trustZone: '   ',
      risk: '\t',
      riskReason: '\n',
      metadata: { trustZone: '  ', riskLevel: '  ' },
    });
    expect(meta.trustZone).toBeUndefined();
    expect(meta.risk).toBeUndefined();
    expect(meta.riskReason).toBeUndefined();
    expect(meta.riskLevel).toBe('unknown');
    expect(isEmptyApprovalRiskMeta(meta)).toBe(true);
  });
});

describe('approvalRiskBadgeLabel + zone/level labels', () => {
  it('prefers trustZone labels', () => {
    expect(
      approvalRiskBadgeLabel(
        parseApprovalRiskMeta({ metadata: { trustZone: 'T3' } }),
      ),
    ).toBe('高风险');
    expect(
      approvalRiskBadgeLabel(
        parseApprovalRiskMeta({ metadata: { trustZone: 'T1' } }),
      ),
    ).toBe('写操作');
  });

  it('covers all known zones and levels in Chinese', () => {
    expect(approvalTrustZoneLabel('t0')).toBe('只读');
    expect(approvalTrustZoneLabel('T1')).toBe('写操作');
    expect(approvalTrustZoneLabel('T2')).toBe('网络/进程');
    expect(approvalTrustZoneLabel('T3')).toBe('高风险');
    expect(approvalTrustZoneLabel('T4')).toBe('极危');
    expect(approvalTrustZoneLabel('')).toBe('');
    expect(approvalTrustZoneLabel(null)).toBe('');
    expect(approvalTrustZoneLabel('custom')).toBe('CUSTOM');

    expect(approvalRiskLevelLabel('low')).toBe('低风险');
    expect(approvalRiskLevelLabel('MEDIUM')).toBe('中风险');
    expect(approvalRiskLevelLabel('high')).toBe('高风险');
    expect(approvalRiskLevelLabel('critical')).toBe('极危');
    expect(approvalRiskLevelLabel('nope')).toBe('需确认');
    expect(approvalRiskLevelLabel(undefined)).toBe('需确认');

    expect(approvalRiskBadgeLabel(parseApprovalRiskMeta({ metadata: { trustZone: 'T0' } }))).toBe(
      '只读',
    );
    expect(approvalRiskBadgeLabel(parseApprovalRiskMeta({ metadata: { trustZone: 'T4' } }))).toBe(
      '极危',
    );
    // badge：medium 保持历史「需确认」；等级表仍为「中风险」
    expect(
      approvalRiskBadgeLabel({
        riskLevel: 'medium',
        requiresDoubleConfirm: false,
        recommendSnapshot: false,
        source: 'backend',
      }),
    ).toBe('需确认');
    expect(approvalRiskLevelLabel('medium')).toBe('中风险');
  });

  it('null-safe badge falls back to 需确认', () => {
    expect(approvalRiskBadgeLabel(null)).toBe('需确认');
    expect(approvalRiskBadgeLabel(undefined)).toBe('需确认');
    expect(approvalRiskBadgeLabel(EMPTY_APPROVAL_RISK_META as ApprovalRiskMeta)).toBe('需确认');
  });

  it('exports complete label tables for T0–T4 and all levels', () => {
    expect([...APPROVAL_TRUST_ZONES]).toEqual(['T0', 'T1', 'T2', 'T3', 'T4']);
    for (const z of APPROVAL_TRUST_ZONES) {
      expect(APPROVAL_TRUST_ZONE_LABELS[z].trim().length).toBeGreaterThan(0);
      expect(approvalTrustZoneHint(z).length).toBeGreaterThan(2);
    }
    for (const lv of APPROVAL_RISK_LEVELS) {
      expect(APPROVAL_RISK_LEVEL_LABELS[lv].trim().length).toBeGreaterThan(0);
      expect(approvalRiskLevelHint(lv).length).toBeGreaterThan(2);
    }
  });
});

describe('risk kind / zone hint / tone / summary (Chinese copy)', () => {
  it('maps known risk kinds and passes through unknown', () => {
    expect(approvalRiskKindLabel('hardline')).toBe('极危硬线');
    expect(approvalRiskKindLabel('DESTRUCTIVE')).toBe('破坏性');
    expect(approvalRiskKindLabel('external-side-effect')).toBe('外发副作用');
    expect(approvalRiskKindLabel('  secret  ')).toBe('敏感信息');
    expect(approvalRiskKindLabel('custom-risk')).toBe('custom-risk');
    expect(approvalRiskKindLabel('')).toBe('');
    expect(approvalRiskKindLabel(null)).toBe('');
  });

  it('builds zone hint like card status line', () => {
    expect(
      approvalZoneHint(
        parseApprovalRiskMeta({
          risk: 'destructive',
          metadata: { trustZone: 'T3' },
        }),
      ),
    ).toBe('T3 · destructive');
    expect(approvalZoneHint(parseApprovalRiskMeta({ metadata: { trustZone: 't1' } }))).toBe(
      'T1',
    );
    expect(approvalZoneHint(parseApprovalRiskMeta({ risk: 'network' }))).toBe('network');
    expect(approvalZoneHint(null)).toBe('');
    expect(approvalZoneHint(EMPTY_APPROVAL_RISK_META as ApprovalRiskMeta)).toBe('');
  });

  it('assigns tone by zone / level / double-confirm', () => {
    expect(approvalRiskTone(null)).toBe('neutral');
    expect(
      approvalRiskTone(parseApprovalRiskMeta({ metadata: { trustZone: 'T4' } })),
    ).toBe('danger');
    expect(
      approvalRiskTone(parseApprovalRiskMeta({ metadata: { trustZone: 'T3' } })),
    ).toBe('danger');
    expect(
      approvalRiskTone(parseApprovalRiskMeta({ metadata: { trustZone: 'T1' } })),
    ).toBe('warn');
    expect(
      approvalRiskTone(parseApprovalRiskMeta({ metadata: { trustZone: 'T0' } })),
    ).toBe('info');
    expect(
      approvalRiskTone(
        parseApprovalRiskMeta({ requiresDoubleConfirm: true, riskLevel: 'low' }),
      ),
    ).toBe('danger');
  });

  it('summary prefers riskReason then double-confirm then zone hints', () => {
    expect(approvalRiskSummary(null)).toContain('缺少后端风险元数据');
    expect(
      approvalRiskSummary(
        parseApprovalRiskMeta({ riskReason: '将执行 rm -rf /tmp/x' }),
      ),
    ).toBe('将执行 rm -rf /tmp/x');
    expect(
      approvalRiskSummary(
        parseApprovalRiskMeta({
          requiresDoubleConfirm: true,
          riskLevel: 'high',
        }),
      ),
    ).toContain('二次确认');
    expect(
      approvalRiskSummary(parseApprovalRiskMeta({ metadata: { trustZone: 'T4' } })),
    ).toMatch(/极危|快照/);
    expect(approvalRiskLevelHint('critical')).toContain('极危');
  });
});

describe('empty meta guards + coerce', () => {
  it('isEmpty / hasFacts cover null and partial shapes', () => {
    expect(isEmptyApprovalRiskMeta(null)).toBe(true);
    expect(isEmptyApprovalRiskMeta(undefined)).toBe(true);
    expect(isEmptyApprovalRiskMeta(EMPTY_APPROVAL_RISK_META as ApprovalRiskMeta)).toBe(
      true,
    );
    expect(hasApprovalRiskFacts(null)).toBe(false);

    expect(
      isEmptyApprovalRiskMeta({
        riskLevel: 'unknown',
        requiresDoubleConfirm: false,
        recommendSnapshot: false,
        source: 'unknown',
      }),
    ).toBe(true);

    expect(
      isEmptyApprovalRiskMeta({
        trustZone: 'T0',
        riskLevel: 'low',
        requiresDoubleConfirm: false,
        recommendSnapshot: false,
        source: 'backend',
      }),
    ).toBe(false);

    expect(
      isEmptyApprovalRiskMeta({
        riskLevel: 'high',
        requiresDoubleConfirm: false,
        recommendSnapshot: false,
        source: 'backend',
      }),
    ).toBe(false);

    expect(
      isEmptyApprovalRiskMeta({
        riskLevel: 'unknown',
        requiresDoubleConfirm: true,
        recommendSnapshot: false,
        source: 'unknown',
      }),
    ).toBe(false);
  });

  it('coerceApprovalRiskMeta normalizes partial store meta', () => {
    expect(coerceApprovalRiskMeta(null)).toMatchObject({
      riskLevel: 'unknown',
      source: 'unknown',
      requiresDoubleConfirm: false,
    });
    expect(coerceApprovalRiskMeta(undefined).source).toBe('unknown');

    const c = coerceApprovalRiskMeta({
      trustZone: ' t3 ',
      risk: '  destructive ',
      riskLevel: 'HIGH' as ApprovalRiskMeta['riskLevel'],
      requiresDoubleConfirm: 1 as unknown as boolean,
      source: 'nope' as ApprovalRiskMeta['source'],
    });
    expect(c.trustZone).toBe('T3');
    expect(c.risk).toBe('destructive');
    expect(c.riskLevel).toBe('high');
    expect(c.requiresDoubleConfirm).toBe(true);
    expect(c.source).toBe('unknown');
    expect(hasApprovalRiskFacts(c)).toBe(true);
  });

  it('normalizeTrustZone / normalizeRiskLevel / isKnownTrustZone edges', () => {
    expect(normalizeTrustZone(' t2 ')).toBe('T2');
    expect(normalizeTrustZone('')).toBeUndefined();
    expect(normalizeTrustZone(null)).toBeUndefined();
    expect(normalizeTrustZone(12)).toBe('12');
    expect(isKnownTrustZone('t4')).toBe(true);
    expect(isKnownTrustZone('T9')).toBe(false);
    expect(normalizeRiskLevel(' High ')).toBe('high');
    expect(normalizeRiskLevel('')).toBeUndefined();
    expect(normalizeRiskLevel(42)).toBeUndefined();
    expect(coerceMetaText(null)).toBe('');
    expect(coerceMetaText(7)).toBe('7');
    expect(coerceMetaText({ a: 1 })).toBe('');
  });
});

describe('rememberPrefixFromToolArgs', () => {
  it('digs command out of JSON and takes up to 3 tokens', () => {
    expect(
      rememberPrefixFromToolArgs(
        'shell_command',
        JSON.stringify({ command: 'git push origin main' }),
        extractCommandForMatch,
      ),
    ).toBe('git push origin');
  });

  it('rejects raw JSON without command field as prefix', () => {
    expect(
      rememberPrefixFromToolArgs(
        'edit',
        JSON.stringify({ path: 'a.ts', content: 'x' }),
        extractCommandForMatch,
      ),
    ).toBe('');
  });

  it('normalizes $ prompt and only remembers first shell segment', () => {
    expect(
      rememberPrefixFromToolArgs(
        'shell_command',
        '$  git   status  --short',
        extractCommandForMatch,
      ),
    ).toBe('git status --short');
    expect(
      rememberPrefixFromToolArgs(
        'shell_command',
        'git status && rm -rf /',
        extractCommandForMatch,
      ),
    ).toBe('git status');
  });

  it('null-safe args and extractCommand throw → empty prefix', () => {
    expect(
      rememberPrefixFromToolArgs(
        null as unknown as string,
        null as unknown as string,
        extractCommandForMatch,
      ),
    ).toBe('');
    expect(
      rememberPrefixFromToolArgs('shell_command', 'git status', () => {
        throw new Error('boom');
      }),
    ).toBe('');
    expect(
      rememberPrefixFromToolArgs('shell_command', 'echo a | cat', extractCommandForMatch),
    ).toBe('echo a');
  });
});
