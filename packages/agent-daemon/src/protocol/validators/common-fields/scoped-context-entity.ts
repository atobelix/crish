import { CORRELATION_FIELDS } from './shared.js';

export const GET_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'scope',
  'kind',
] as const;
export const UPSERT_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'record',
] as const;
export const DELETE_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'recordId',
] as const;
export const RESOLVE_SCOPED_CONTEXT_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'cwd',
  'workspaceRoot',
  'projectRoot',
  'projectMarkers',
  'projectFiles',
  'projectTags',
  'packageNames',
  'userEnabledIds',
  'userDisabledIds',
  'scopedContextConfig',
] as const;
export const SCOPED_CONTEXT_RUNTIME_CONFIG_FIELDS = [
  'userEnabledIds',
  'userDisabledIds',
  'includeRecommendationHints',
  'includeAncestorContextFiles',
  'includeProjectSkillDirs',
  'includeWorkspaceSkillDirs',
  'includeGlobalSkillDirs',
  'globalSkillDirs',
  'workspaceSkillDirs',
  'projectSkillDirs',
  'globalRuleFiles',
  'workspaceRuleFiles',
  'projectRuleFiles',
  'globalRuleDirs',
  'workspaceRuleDirs',
  'projectRuleDirs',
] as const;
export const SCOPED_CONTEXT_RESPONSE_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'records',
  'diagnostic',
] as const;
export const SCOPED_CONTEXT_UPSERTED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'record',
  'persisted',
  'diagnostic',
] as const;
export const SCOPED_CONTEXT_DELETED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'recordId',
  'deleted',
  'diagnostic',
] as const;
export const SCOPED_CONTEXT_RESOLVED_FIELDS = [
  'type',
  ...CORRELATION_FIELDS,
  'status',
  'stableContext',
  'recommended',
  'items',
  'diagnostics',
  'stableContextHash',
  'storeRecordCount',
  'resourceRecordCount',
  'resourceDiagnostics',
  'storeDiagnostic',
] as const;
export const SCOPED_CONTEXT_RECORD_FIELDS = [
  'id',
  'kind',
  'title',
  'content',
  'description',
  'scope',
  'activation',
  'appliesTo',
  'tags',
  'source',
  'sourceMetadata',
  'order',
  'updatedAt',
] as const;
export const SCOPED_CONTEXT_SOURCE_FIELDS = ['type', 'path', 'label'] as const;
export const SCOPED_CONTEXT_DIAGNOSTIC_FIELDS = [
  'code',
  'message',
  'updatedAt',
  'path',
  'detail',
] as const;
export const SCOPED_CONTEXT_CANDIDATE_FIELDS = [
  'id',
  'kind',
  'title',
  'description',
  'scope',
  'activation',
  'appliesTo',
  'tags',
  'source',
  'reason',
] as const;
export const SCOPED_CONTEXT_ITEM_FIELDS = [
  ...SCOPED_CONTEXT_CANDIDATE_FIELDS,
  'status',
] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_FIELDS = [
  'severity',
  'id',
  'code',
  'message',
] as const;
export const SCOPED_CONTEXT_RESOURCE_DIAGNOSTIC_FIELDS = [
  'severity',
  'path',
  'message',
] as const;
export const PROMPT_CONTEXT_BLOCK_FIELDS = [
  'id',
  'kind',
  'label',
  'content',
] as const;
export const SCOPED_CONTEXT_KINDS = ['rule', 'skill'] as const;
export const SCOPED_CONTEXT_SCOPES = [
  'global',
  'project',
  'workspace',
] as const;
export const SCOPED_CONTEXT_ACTIVATIONS = [
  'enabled',
  'recommended',
  'disabled',
] as const;
export const SCOPED_CONTEXT_STORE_STATUSES = ['ok', 'degraded'] as const;
export const SCOPED_CONTEXT_SOURCE_TYPES = [
  'global-rule',
  'project-rule',
  'workspace-rule',
  'skill-file',
  'user',
  'system',
] as const;
export const SCOPED_CONTEXT_ITEM_STATUSES = [
  'active',
  'recommended',
  'disabled',
  'inapplicable',
] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_SEVERITIES = [
  'info',
  'warning',
] as const;
export const SCOPED_CONTEXT_RESOLVER_DIAGNOSTIC_CODES = [
  'disabled',
  'scope-mismatch',
  'applies-to-mismatch',
  'empty-content',
] as const;
export const PROMPT_CONTEXT_BLOCK_KINDS = [
  'project-profile',
  'runtime-profile',
  'skills-hook',
  'memory-hook',
  'plan-hook',
  'custom-stable',
  'custom-volatile',
] as const;
