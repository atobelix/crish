import type { ToolCategory } from '@crish/shared-types';
import type { AgentTool } from '@crish/shared-types';

export type ToolMode = 'plan' | 'ask' | 'auto' | 'full-access' | 'unattended';

export interface ToolPreset {
  toolIds: string[];
  autoApproved: string[];
  categoryFilter?: ToolCategory[];
}

const DEFAULT_PRESETS: Record<ToolMode, ToolPreset> = {
  plan: {
    toolIds: ['read_files', 'search_codebase', 'glob', 'grep', 'list_files'],
    autoApproved: [
      'read_files',
      'search_codebase',
      'glob',
      'grep',
      'list_files',
    ],
    categoryFilter: ['filesystem'],
  },
  ask: {
    toolIds: [],
    autoApproved: [
      'read_files',
      'search_codebase',
      'glob',
      'grep',
      'list_files',
    ],
  },
  auto: {
    toolIds: [],
    autoApproved: ['*'],
  },
  'full-access': {
    toolIds: [],
    autoApproved: ['*'],
  },
  unattended: {
    toolIds: [],
    autoApproved: ['*'],
  },
};

export class ToolPresetRegistry {
  private static presets: Record<string, ToolPreset> = { ...DEFAULT_PRESETS };

  static getPreset(mode: ToolMode): ToolPreset {
    return this.presets[mode] ?? this.presets['full-access']!;
  }

  static registerPreset(name: string, preset: ToolPreset): void {
    this.presets[name] = preset;
  }

  static filterTools(tools: AgentTool[], mode: ToolMode): AgentTool[] {
    const preset = ToolPresetRegistry.getPreset(mode);
    if (preset.toolIds.length > 0) {
      return tools.filter((t) => preset.toolIds.includes(t.name));
    }
    if (preset.categoryFilter) {
      return tools.filter((t) => preset.categoryFilter!.includes(t.category));
    }
    return tools;
  }

  static resetToDefaults(): void {
    this.presets = { ...DEFAULT_PRESETS };
  }
}
