import { z } from 'zod';
import { configService } from './ConfigService';

export function registerConfigSchemas(): void {
  configService.define('shortcuts.overrides', z.record(z.string(), z.string()), {}, 'localStorage');

  configService.define('ui.size', z.enum(['small', 'medium', 'large']), 'medium');
  configService.define('ui.sidebarCollapsed', z.boolean(), false);

  configService.define('theme.mode', z.enum(['light', 'dark', 'system']), 'system');

  configService.define('permission.mode', z.enum(['accept', 'reject', 'plan']), 'plan', 'localStorage');

  configService.define('providers', z.array(z.object({
    id: z.string(),
    name: z.string(),
    profileId: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    enabled: z.boolean(),
    models: z.array(z.string()).optional(),
  })), [], 'localStorage');

  configService.define('workspace.layout', z.object({
    columns: z.array(z.object({
      id: z.string(),
      widthRatio: z.number().min(0).max(1),
      cards: z.array(z.object({
        id: z.string(),
        type: z.string(),
        visible: z.boolean(),
      })),
    })),
    sidebarWidth: z.number().min(220).max(360).optional(),
  }), { columns: [] }, 'localStorage');
}
