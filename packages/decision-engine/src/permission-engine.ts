import type { PermissionRequest, PermissionDecision, PermissionRule } from "@crish/shared-types";
import { HardlineBlockRule } from "./rules/hardline-rule";

export class PermissionEngine {
  private readonly rules: readonly PermissionRule[];

  constructor(rules?: PermissionRule[]) {
    this.rules = Object.freeze([...(rules ?? defaultRules())]);
  }

  decide(request: PermissionRequest): PermissionDecision {
    for (const rule of this.rules) {
      const decision = rule.evaluate(request);
      if (decision !== null) return decision;
    }
    return { behavior: "deny", reason: "No matching permission rule" };
  }

  getRules(): readonly PermissionRule[] {
    return this.rules;
  }
}

function defaultRules(): PermissionRule[] {
  return [
    new HardlineBlockRule(),
    { name: "default-allow", evaluate: () => ({ behavior: "allow", reason: "Default allow" }) },
  ];
}

export const DEFAULT_PERMISSION_ENGINE = new PermissionEngine();
