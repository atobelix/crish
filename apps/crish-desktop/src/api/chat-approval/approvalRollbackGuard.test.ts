import { describe, expect, it } from 'vitest';
import {
  shouldSkipApprovalRollback,
  shouldSkipDenyRollback,
} from './approvalRollbackGuard';
import type { MessageToolCall } from '../../store/types';

describe('approvalRollbackGuard (A-04)', () => {
  describe('shouldSkipApprovalRollback', () => {
    it('null 或 undefined 返回 false', () => {
      expect(shouldSkipApprovalRollback(null)).toBe(false);
      expect(shouldSkipApprovalRollback(undefined)).toBe(false);
    });

    it('status 为 success 时返回 true，跳过回滚', () => {
      const tc: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'success',
        arguments: '',
      };
      expect(shouldSkipApprovalRollback(tc)).toBe(true);
    });

    it('status 为 running 且有实质输出时返回 true，跳过回滚', () => {
      const tc: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'running',
        arguments: '',
        output: '真实结果已返回',
      };
      expect(shouldSkipApprovalRollback(tc)).toBe(true);
    });

    it('status 为 running 且 output 为 "执行中…" 时返回 false，执行回滚', () => {
      const tc: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'running',
        arguments: '',
        output: '执行中…',
      };
      expect(shouldSkipApprovalRollback(tc)).toBe(false);
    });

    it('status 为 pending_approval 时返回 false', () => {
      const tc: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'pending_approval',
        arguments: '',
      };
      expect(shouldSkipApprovalRollback(tc)).toBe(false);
    });
  });

  describe('shouldSkipDenyRollback', () => {
    it('null 或 undefined 返回 false', () => {
      expect(shouldSkipDenyRollback(null)).toBe(false);
      expect(shouldSkipDenyRollback(undefined)).toBe(false);
    });

    it('status 为 running 或 success 时返回 true', () => {
      const tcRunning: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'running',
        arguments: '',
      };
      const tcSuccess: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'success',
        arguments: '',
      };
      expect(shouldSkipDenyRollback(tcRunning)).toBe(true);
      expect(shouldSkipDenyRollback(tcSuccess)).toBe(true);
    });

    it('status 为 error 或 pending_approval 时返回 false', () => {
      const tcError: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'error',
        arguments: '',
      };
      const tcPending: MessageToolCall = {
        id: 't1',
        name: 'shell',
        status: 'pending_approval',
        arguments: '',
      };
      expect(shouldSkipDenyRollback(tcError)).toBe(false);
      expect(shouldSkipDenyRollback(tcPending)).toBe(false);
    });
  });
});
