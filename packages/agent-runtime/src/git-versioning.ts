// Re-export all public types, errors and functions from sub-modules
export type * from "./git-versioning/git-types";
export { GitCliVersioningService } from "./git-versioning/git-service";
export { GitCommandError } from "./git-versioning/git-commit-ops";
export {
  parseStatus,
  parseNameStatus,
  parseCheckpointMetadata,
  isCheckpointMetadata,
  isWorkspaceStatus,
  normalizeRefNamespace,
  safeRefSegment,
  normalizeRepositoryPath,
  normalizeGitPath
} from "./git-versioning/git-patch-ops";
