/**
 * Factory: mount PermissionMiddleware on the main tool path.
 *
 * Session loop historically used resolvePermission + DaemonApprovalHandler only.
 * This helper builds a MiddlewarePipeline that includes PermissionMiddleware so
 * daemon / runtime factory can share one permission entrypoint.
 */
import type { ApprovalHandler } from '@crish/shared-types';
import type { RuntimePermissionPolicy } from '../types';
import {
  MiddlewarePipeline,
  PermissionMiddleware,
  type ToolMiddleware,
} from './tool-middleware';

export interface CreatePermissionPipelineOptions {
  permissionPolicy: RuntimePermissionPolicy;
  sessionId: string;
  cwd: string;
  approvalHandler?: ApprovalHandler;
  /** Extra middlewares after permission (checkpoint, materialization, …) */
  extra?: ToolMiddleware[];
}

/**
 * Build a MiddlewarePipeline with PermissionMiddleware first.
 */
export function createPermissionMiddlewarePipeline(
  options: CreatePermissionPipelineOptions
): MiddlewarePipeline {
  const permission = new PermissionMiddleware({
    permissionPolicy: options.permissionPolicy,
    sessionId: options.sessionId,
    cwd: options.cwd,
    ...(options.approvalHandler
      ? { approvalHandler: options.approvalHandler }
      : {}),
  });
  return new MiddlewarePipeline([permission, ...(options.extra ?? [])]);
}
