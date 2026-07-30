import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  normalizeDeclarativeDef,
  type DeclarativeProviderDef,
} from '../declarative-schema';

export interface AuthHeaderConfig {
  type: 'api-key' | 'bearer' | 'header' | 'none';
  placement: 'header' | 'query';
  keyHeader?: string;
  defaultEnvVar?: string;
}

export function loadProviderDef(filePath: string): DeclarativeProviderDef {
  const content = fs.readFileSync(filePath, 'utf-8');
  const raw = JSON.parse(content) as Record<string, unknown>;

  if (!raw.providerId || typeof raw.providerId !== 'string') {
    throw new Error('Missing or invalid providerId');
  }
  if (!raw.engine || typeof raw.engine !== 'string') {
    throw new Error('Missing or invalid engine');
  }

  const def = raw as unknown as DeclarativeProviderDef;
  normalizeDeclarativeDef(def);
  return def;
}

export function resolveAuthHeaders(
  auth: AuthHeaderConfig | undefined,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (!apiKey || !auth || auth.type === 'none') return headers;

  if (auth.type === 'bearer') {
    headers['Authorization'] = `Bearer ${apiKey}`;
    return headers;
  }

  if (auth.placement === 'query') return headers;

  const headerName = auth.keyHeader ?? 'Authorization';

  if (headerName.toLowerCase() === 'authorization') {
    headers[headerName] = `Bearer ${apiKey}`;
  } else {
    headers[headerName] = apiKey;
  }

  return headers;
}

export function findProviderJson(name: string): string | null {
  const searchDirs = [
    path.join(__dirname, '..', 'builtin', 'providers'),
    path.join(process.cwd(), 'providers'),
  ];

  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

      for (const file of files) {
        if (file.toLowerCase() === `${name.toLowerCase()}.json`) {
          return path.join(dir, file);
        }
      }

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          const raw = JSON.parse(content) as Record<string, unknown>;
          if (raw.providerId === name || raw.name === name) {
            return path.join(dir, file);
          }
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}
