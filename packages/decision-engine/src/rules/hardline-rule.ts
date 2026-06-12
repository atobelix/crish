import type { PermissionRequest, PermissionDecision, PermissionRule } from "@crish/shared-types";
import { HardlinePatternRegistry, DEFAULT_HARDLINE_REGISTRY } from "../hardline-patterns";

export class HardlineBlockRule implements PermissionRule {
  readonly name = "hardline-block";

  constructor(private readonly registry: HardlinePatternRegistry = DEFAULT_HARDLINE_REGISTRY) {}

  evaluate(request: PermissionRequest): PermissionDecision | null {
    const command = commandFromRequest(request);
    if (!command) return null;

    const hardline = this.registry.isHardline(command);
    if (hardline) {
      return {
        behavior: "deny",
        reason: `Hardline command blocked: ${hardline.reason}`,
        metadata: { matchedRule: this.name, hardlineReason: hardline.reason },
      };
    }

    return null;
  }
}

function commandFromRequest(request: PermissionRequest): string | undefined {
  const input = request.parameters as Record<string, unknown>;
  if (typeof input.command === "string" && input.command.trim().length > 0) return input.command;
  if (typeof input.cmd === "string") return input.cmd;
  if (typeof input.script === "string") return input.script;
  if (typeof input.shell === "string") return input.shell;
  if (request.toolName === "Bash" || request.toolName === "PowerShell" || request.toolName === "shell") {
    return request.summary;
  }
  return undefined;
}
