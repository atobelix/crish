import type { AgentTool } from './types';

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Tool "${tool.name}" already registered, overwriting`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  listByCategory(): Record<string, AgentTool[]> {
    const byCategory: Record<string, AgentTool[]> = {};
    for (const tool of this.tools.values()) {
      const cat = tool.category ?? 'uncategorized';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(tool);
    }
    return byCategory;
  }

  discover(): void {
    // Tools register themselves via defineTool() calls
  }

  get size(): number { return this.tools.size; }
}

export const globalToolRegistry = new ToolRegistry();
