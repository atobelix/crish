// 领域组合类型（M5 §1.3 组合纪律：契约类型 & 本地附加字段，禁止复制契约字段定义）
// 契约类型变化时组合类型自动继承，编译期暴露不匹配
import type { PermissionRequest } from '@crish/shared-types';

// 审批条目：shared-types 的 PermissionRequest 之上叠加移动端本地附加字段
export interface ApprovalItem {
  request: PermissionRequest;
  runId: string | null;
  requestedAt: number;
  expiresAt: number;
  status:
    | 'pending'
    | 'deciding'
    | 'queued'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'conflict';
  decision?: 'approved' | 'denied';
}
