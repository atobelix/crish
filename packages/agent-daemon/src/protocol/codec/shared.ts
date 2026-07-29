import type { ProtocolValidationError } from '../validators/common.js';

export function formatProtocolValidationError(
  error: ProtocolValidationError
): string {
  const issueSummary = error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');

  if (!issueSummary) return error.message;

  const suffix = error.issues.length > 3 ? ' ...' : '';
  return `${error.message}: ${issueSummary}${suffix}`;
}
