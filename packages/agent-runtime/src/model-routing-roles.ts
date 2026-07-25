import type { ModelProfile } from "./model-routing";

/**
 * Model role identifiers for multi-model task routing.
 * - `primary`: main model for the task
 * - `fast`: lightweight model for quick/cheap operations
 * - `editor`: model for editing/refinement
 * - `embedding`: model for text embedding
 * - `summarizer`: model for summarization
 */
export type ModelRole = "primary" | "fast" | "editor" | "embedding" | "summarizer";

/**
 * Result of assigning model roles for a task.
 * At minimum `primary` is always assigned; other roles are populated
 * when the task type defines constraints for them.
 */
export interface MultiModelAssignment {
  primary: ModelProfile;
  fast?: ModelProfile;
  editor?: ModelProfile;
  embedding?: ModelProfile;
  summarizer?: ModelProfile;
}

/**
 * Task kind for model-role-based routing.
 * Broader than the existing ModelTaskKind in model-routing.ts;
 * includes audio, embedding, classify, extract, etc.
 */
export type ModelTaskKind =
  | "chat"
  | "code"
  | "code-review"
  | "planning"
  | "vision"
  | "audio"
  | "embedding"
  | "tool-use"
  | "workflow"
  | "search"
  | "summarize"
  | "classify"
  | "extract";

/**
 * Capability constraints for a single model role assignment.
 * - `required`: tags the profile MUST have (hard filter)
 * - `preferred`: tags that improve the profile's rank (soft scoring)
 * - `requiredFlags` / `preferredFlags`: boolean capability flags
 * - `minContextWindow`: minimum context window tokens required
 * - `maxCostPer1KInput`: maximum cost per 1K input tokens
 * - `preferredRole`: hint for which ModelRole this constraint targets
 */
export interface RoleCapabilityConstraints {
  required: string[];
  preferred: string[];
  requiredFlags?: Record<string, boolean>;
  preferredFlags?: Record<string, boolean>;
  minContextWindow?: number;
  maxCostPer1KInput?: number;
  preferredRole?: ModelRole;
}

// ---------------------------------------------------------------------------
// Task → role constraints mapping
// ---------------------------------------------------------------------------

const TASK_ROLE_MAP: Record<
  ModelTaskKind,
  {
    primary: RoleCapabilityConstraints;
    fast?: RoleCapabilityConstraints;
    editor?: RoleCapabilityConstraints;
    embedding?: RoleCapabilityConstraints;
    summarizer?: RoleCapabilityConstraints;
  }
> = {
  chat: {
    primary: {
      required: [],
      preferred: ["tool-use", "json"],
      preferredFlags: { supportsFunctionCalling: true },
    },
    fast: {
      required: [],
      preferred: ["low-cost"],
    },
  },
  code: {
    primary: {
      required: ["code", "tool-use"],
      requiredFlags: { supportsFunctionCalling: true },
      preferred: ["reasoning", "long-context"],
    },
    fast: {
      required: ["code"],
      preferred: ["low-cost", "low-latency"],
    },
  },
  "code-review": {
    primary: {
      required: ["code", "reasoning", "long-context"],
      requiredFlags: { supportsFunctionCalling: true },
      minContextWindow: 64000,
      preferred: [],
    },
    fast: {
      required: ["code"],
      preferred: ["low-cost"],
    },
  },
  planning: {
    primary: {
      required: ["reasoning"],
      preferredFlags: { supportsReasoning: true },
      preferred: ["planning", "json", "long-context"],
    },
    fast: {
      required: ["json"],
      preferred: ["low-cost"],
    },
  },
  vision: {
    primary: {
      required: ["vision"],
      requiredFlags: { supportsVision: true },
      preferred: ["reasoning", "json"],
    },
  },
  audio: {
    primary: {
      required: [],
      preferred: ["low-latency"],
    },
  },
  embedding: {
    primary: {
      required: [],
      preferred: ["low-cost", "low-latency"],
    },
    embedding: {
      required: [],
      preferred: ["low-cost", "low-latency"],
    },
  },
  "tool-use": {
    primary: {
      required: ["tool-use"],
      requiredFlags: { supportsFunctionCalling: true },
      preferred: ["json", "reasoning"],
    },
  },
  workflow: {
    primary: {
      required: ["tool-use"],
      requiredFlags: { supportsFunctionCalling: true },
      preferred: ["workflow", "json", "low-cost"],
    },
    fast: {
      required: ["json"],
      preferred: ["low-cost"],
    },
  },
  search: {
    primary: {
      required: ["search"],
      preferred: ["reasoning", "json", "low-latency"],
    },
  },
  summarize: {
    primary: {
      required: [],
      preferred: ["long-context", "low-cost"],
    },
    summarizer: {
      required: [],
      preferred: ["low-cost", "low-latency"],
    },
  },
  classify: {
    primary: {
      required: ["json"],
      preferred: ["low-cost", "low-latency"],
    },
  },
  extract: {
    primary: {
      required: ["json"],
      preferred: ["reasoning", "low-cost"],
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assign model roles for a given task kind based on available profiles.
 *
 * The algorithm:
 * 1. Look up the role constraints for `taskKind` in TASK_ROLE_MAP.
 * 2. For each role defined in the constraints, run `selectBestFit`:
 *    a. Filter profiles that meet all **required** constraints.
 *    b. Sort remaining candidates by **preferred** match count (descending).
 *    c. Return the top candidate.
 * 3. If no role map exists for `taskKind`, return `availableProfiles[0]` as
 *    the primary role (or a sentinel if the list is empty).
 *
 * @param taskKind - The kind of task to route.
 * @param availableProfiles - All candidate model profiles.
 * @returns A `MultiModelAssignment` with at least `primary` populated.
 */
export function allocateModelRoles(
  taskKind: ModelTaskKind,
  availableProfiles: ModelProfile[],
): MultiModelAssignment {
  const roleMap = TASK_ROLE_MAP[taskKind];

  if (!roleMap) {
    return { primary: availableProfiles[0] ?? ({ id: "unknown" } as ModelProfile) };
  }

  const result: MultiModelAssignment = {
    primary: selectBestFit(availableProfiles, roleMap.primary) ?? availableProfiles[0] ?? ({ id: "unknown" } as ModelProfile),
  };

  if (roleMap.fast) {
    const best = selectBestFit(availableProfiles, roleMap.fast);
    if (best) result.fast = best;
  }
  if (roleMap.editor) {
    const best = selectBestFit(availableProfiles, roleMap.editor);
    if (best) result.editor = best;
  }
  if (roleMap.embedding) {
    const best = selectBestFit(availableProfiles, roleMap.embedding);
    if (best) result.embedding = best;
  }
  if (roleMap.summarizer) {
    const best = selectBestFit(availableProfiles, roleMap.summarizer);
    if (best) result.summarizer = best;
  }

  return result;
}

/**
 * Re-allocate a subset of roles for an already-assigned task.
 * Useful when a previous role assignment failed and only certain
 * roles need to be re-resolved.
 *
 * @param existing - The current assignment (will be shallow-cloned).
 * @param roles - Which roles to re-allocate.
 * @param profiles - The available model profiles.
 * @returns A new assignment with the specified roles re-resolved.
 */
export function reallocateRoles(
  existing: MultiModelAssignment,
  roles: ModelRole[],
  profiles: ModelProfile[],
): MultiModelAssignment {
  const result = { ...existing };

  for (const role of roles) {
    // Find the constraints for the role by scanning TASK_ROLE_MAP
    // Since we don't have the original taskKind, we use a best-effort approach:
    // flatten all role constraints from all task kinds into a single policy.
    const allConstraints = Object.values(TASK_ROLE_MAP)
      .map((m) => m[role as keyof typeof m])
      .filter(Boolean) as RoleCapabilityConstraints[];

    if (allConstraints.length === 0) continue;

    // Merge constraints: union required, union preferred
    const merged: RoleCapabilityConstraints = {
      required: [...new Set(allConstraints.flatMap((c) => c.required))],
      preferred: [...new Set(allConstraints.flatMap((c) => c.preferred))],
    };

    let best: ModelProfile | undefined;
    let bestScore = -1;

    for (const profile of profiles) {
      if (!meetsConstraints(profile, merged)) continue;
      const score = countPreferred(profile, merged);
      if (score > bestScore) {
        bestScore = score;
        best = profile;
      }
    }

    if (best) {
      (result as Record<string, ModelProfile | undefined>)[role] = best;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Pick the best matching profile from `profiles` for the given constraints.
 *
 * Steps:
 * 1. Filter out profiles that don't satisfy **required** constraints.
 * 2. Sort survivors by how many **preferred** constraints they satisfy.
 * 3. Return the top scorer (or `undefined` if none survive).
 */
function selectBestFit(
  profiles: ModelProfile[],
  constraints: RoleCapabilityConstraints,
): ModelProfile | undefined {
  const candidates = profiles.filter((p) => meetsConstraints(p, constraints));

  if (candidates.length === 0) {
    return undefined;
  }

  candidates.sort((a, b) => {
    const aPref = countPreferred(a, constraints);
    const bPref = countPreferred(b, constraints);
    return bPref - aPref;
  });

  return candidates[0];
}

/**
 * Check whether a single profile meets all **required** constraints.
 */
function meetsConstraints(
  profile: ModelProfile,
  constraints: RoleCapabilityConstraints,
): boolean {
  const caps: Record<string, number | boolean | undefined> =
    (profile.capabilities ?? {}) as unknown as Record<string, number | boolean | undefined>;

  // --- required capability tags ---
  for (const req of constraints.required) {
    const val = caps[req];
    if (val === undefined || val === false || val === 0) return false;
  }

  // --- required capability flags (accessed via `any` for extensibility) ---
  if (constraints.requiredFlags) {
    const anyProfile = profile as any;
    const flags: Record<string, boolean> = anyProfile.capabilityFlags ?? {};
    for (const [key, value] of Object.entries(constraints.requiredFlags)) {
      if (value) {
        // Check both the dedicated flags field and capabilities as fallback
        const flagVal = flags[key] ?? caps[key];
        if (!flagVal) return false;
      }
    }
  }

  // --- minimum context window ---
  if (
    constraints.minContextWindow !== undefined &&
    profile.contextWindowTokens !== undefined
  ) {
    if (profile.contextWindowTokens < constraints.minContextWindow) return false;
  }

  // --- maximum cost per 1K input tokens ---
  if (constraints.maxCostPer1KInput !== undefined) {
    const anyProfile = profile as any;
    const pricing = anyProfile.pricing;
    if (pricing && typeof pricing.inputCostPerToken === "number") {
      if (pricing.inputCostPerToken * 1000 > constraints.maxCostPer1KInput) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Count how many **preferred** constraints a profile satisfies.
 * Used as the sorting key in `selectBestFit`.
 */
function countPreferred(
  profile: ModelProfile,
  constraints: RoleCapabilityConstraints,
): number {
  const caps: Record<string, number | boolean | undefined> =
    (profile.capabilities ?? {}) as unknown as Record<string, number | boolean | undefined>;
  let count = 0;

  for (const pref of constraints.preferred) {
    const val = caps[pref];
    if (val !== undefined && val !== false && val !== 0) count++;
  }

  if (constraints.preferredFlags) {
    const anyProfile = profile as any;
    const flags: Record<string, boolean> = anyProfile.capabilityFlags ?? {};
    for (const [key, value] of Object.entries(constraints.preferredFlags)) {
      if (value) {
        const flagVal = flags[key] ?? caps[key];
        if (flagVal) count++;
      }
    }
  }

  return count;
}
