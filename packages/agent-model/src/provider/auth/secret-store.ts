import { spawnSync } from 'node:child_process';
import { createSecret, type SecretValue } from './types';
import { EncryptedFileSecretStore } from './encrypted-file-store';

export type SecretStoreLayer = 'keychain' | 'encrypted-file' | 'env-var';

export interface SecretStore {
  store(key: string, value: SecretValue): Promise<SecretStoreLayer>;
  load(key: string): Promise<SecretValue | null>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

const ENV_PREFIX = 'CONEX_SECRET_';

type WindowWithTauri = typeof globalThis & {
  __TAURI_INTERNALS__?: {
    invoke?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  };
};

function isTauriContext(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof (window as WindowWithTauri).__TAURI_INTERNALS__ !== 'undefined'
    );
  } catch {
    return false;
  }
}

async function tauriInvoke(
  cmd: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const invoke = (window as WindowWithTauri).__TAURI_INTERNALS__?.invoke;
  if (!invoke) throw new Error('Tauri IPC not available');
  return invoke(cmd, args);
}

/**
 * macOS Keychain via `security` CLI
 * Windows Credential Manager via PowerShell P/Invoke (CredWriteW / CredReadW)
 * Linux via `secret-tool` (libsecret)
 */
class OSKeychainStore implements SecretStore {
  private readonly serviceName = 'crish-agent-runtime';

  async store(key: string, value: SecretValue): Promise<SecretStoreLayer> {
    const keychainKey = this.keychainKey(key);
    if (isTauriContext()) {
      await tauriInvoke('workbench_profile_secret_set', {
        profileId: key,
        apiKey: value,
      });
    } else if (process.platform === 'darwin') {
      this.macOSSecurity('add-generic-password', [
        '-a',
        this.serviceName,
        '-s',
        keychainKey,
        '-w',
        value,
        '-U',
      ]);
    } else if (process.platform === 'win32') {
      this.windowsCredWrite(keychainKey, value);
    } else {
      this.linuxSecretTool('store', [
        '--label',
        this.serviceName,
        'service',
        this.serviceName,
        'key',
        keychainKey,
        'value',
        value,
      ]);
    }
    return 'keychain';
  }

  async load(key: string): Promise<SecretValue | null> {
    const keychainKey = this.keychainKey(key);
    try {
      if (isTauriContext()) {
        const result = (await tauriInvoke('workbench_profile_secret_get', {
          profileId: key,
        })) as { apiKey?: string } | null | undefined;
        const apiKey: string | undefined = result?.apiKey;
        return apiKey ? createSecret(apiKey) : null;
      } else if (process.platform === 'darwin') {
        const stdout = this.macOSSecurity('find-generic-password', [
          '-a',
          this.serviceName,
          '-s',
          keychainKey,
          '-w',
        ]);
        return stdout ? createSecret(stdout.trim()) : null;
      } else if (process.platform === 'win32') {
        const value = this.windowsCredRead(keychainKey);
        return value ? createSecret(value) : null;
      } else {
        const stdout = this.linuxSecretTool('lookup', [
          'service',
          this.serviceName,
          'key',
          keychainKey,
        ]);
        return stdout ? createSecret(stdout.trim()) : null;
      }
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const keychainKey = this.keychainKey(key);
    try {
      if (isTauriContext()) {
        await tauriInvoke('workbench_profile_secret_clear', { profileId: key });
      } else if (process.platform === 'darwin') {
        this.macOSSecurity('delete-generic-password', [
          '-a',
          this.serviceName,
          '-s',
          keychainKey,
        ]);
      } else if (process.platform === 'win32') {
        this.windowsCredDelete(keychainKey);
      } else {
        this.linuxSecretTool('clear', [
          'service',
          this.serviceName,
          'key',
          keychainKey,
        ]);
      }
    } catch {
      // best effort
    }
  }

  async list(): Promise<string[]> {
    try {
      if (isTauriContext()) {
        return [];
      } else if (process.platform === 'darwin') {
        // `security dump-keychain` is too verbose; fall through to encrypted file store
        return [];
      } else if (process.platform === 'win32') {
        return this.windowsCredList();
      }
      return [];
    } catch {
      return [];
    }
  }

  private keychainKey(key: string): string {
    return `crish:${key}`;
  }

  // ── macOS `security` CLI ────────────────────────────────────────────
  private macOSSecurity(command: string, args: string[]): string {
    const fullArgs = [command, ...args];
    try {
      const result = spawnSync('security', fullArgs, {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status !== 0) {
        if (result.stderr?.includes('The specified item could not be found')) {
          return '';
        }
        throw new Error(result.stderr || `security ${command} failed`);
      }
      return result.stdout ?? '';
    } catch (err: any) {
      if (err.message?.includes('The specified item could not be found')) {
        return '';
      }
      throw err;
    }
  }

  // ── Windows PowerShell P/Invoke (CredWriteW / CredReadW) ────────────
  private runPowerShell(script: string): string {
    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf-8',
      timeout: 10000,
      windowsHide: true,
    });
    if (result.status !== 0 && result.status !== null) {
      throw new Error(
        result.stderr || `PowerShell exited with code ${result.status}`
      );
    }
    return result.stdout ?? '';
  }

  private windowsCredWrite(target: string, value: string): void {
    const script = `
Add-Type -Name 'CredMan' -Namespace 'Win32' -MemberDefinition @'
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWriteW(ref CREDENTIALW credential, uint flags);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredReadW(string target, uint type, uint flags, out System.IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool CredFree(System.IntPtr buffer);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIALW {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public long LastWritten; public uint CredentialBlobSize; public System.IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public System.IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
'@ -PassThru 2>NUL | Out-Null
$target = '${target.replace(/'/g, "''")}'
$value = '${value.replace(/'/g, "''")}'
$cred = New-Object Win32.CredMan+CREDENTIALW
$cred.Type = 1
$cred.TargetName = $target
$cred.CredentialBlobSize = [System.Text.Encoding]::Unicode.GetByteCount($value)
$ptr = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($value)
$cred.CredentialBlob = $ptr
$cred.Persist = 2
$cred.UserName = 'crish'
$ok = [Win32.CredMan]::CredWriteW([ref]$cred, 0)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
if (-not $ok) { exit 1 }
`;
    this.runPowerShell(script);
  }

  private windowsCredRead(target: string): string | null {
    try {
      const script = `
Add-Type -Name 'CredMan' -Namespace 'Win32' -MemberDefinition @'
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredReadW(string target, uint type, uint flags, out System.IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool CredFree(System.IntPtr buffer);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIALW {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public long LastWritten; public uint CredentialBlobSize; public System.IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public System.IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
'@ -PassThru 2>NUL | Out-Null
$target = '${target.replace(/'/g, "''")}'
$ptr = [System.IntPtr]::Zero
$ok = [Win32.CredMan]::CredReadW($target, 1, 0, [ref]$ptr)
if (-not $ok) { exit 1 }
$cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][Win32.CredMan+CREDENTIALW])
$size = $cred.CredentialBlobSize
$blob = New-Object byte[] $size
[System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $blob, 0, $size)
[Win32.CredMan]::CredFree($ptr)
$value = [System.Text.Encoding]::Unicode.GetString($blob).TrimEnd("\\0")
Write-Output $value
`;
      return this.runPowerShell(script).trim();
    } catch {
      return null;
    }
  }

  private windowsCredDelete(target: string): void {
    try {
      const script = `
Add-Type -Name 'CredMan' -Namespace 'Win32' -MemberDefinition @'
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDeleteW(string target, uint type, uint flags);
'@ -PassThru 2>NUL | Out-Null
$target = '${target.replace(/'/g, "''")}'
[Win32.CredMan]::CredDeleteW($target, 1, 0) | Out-Null
`;
      this.runPowerShell(script);
    } catch {
      // best effort
    }
  }

  private windowsCredList(): string[] {
    try {
      const result = spawnSync('cmdkey', ['/list'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status !== 0) return [];
      const stdout = result.stdout ?? '';
      const keys: string[] = [];
      for (const line of stdout.split('\n')) {
        const m = line.match(/^.*Target:\s*(crish:.+)$/i);
        if (m && m[1]) keys.push(m[1].replace(/^crish:/, ''));
      }
      return keys;
    } catch {
      return [];
    }
  }

  // ── Linux `secret-tool` (libsecret) ─────────────────────────────────
  private linuxSecretTool(command: string, args: string[]): string {
    const fullArgs = [command, ...args];
    try {
      const result = spawnSync('secret-tool', fullArgs, {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status !== 0) {
        if (result.stderr?.includes('not found')) return '';
        throw new Error(result.stderr || `secret-tool ${command} failed`);
      }
      return result.stdout ?? '';
    } catch (err: any) {
      if (err.message?.includes('not found')) return '';
      throw err;
    }
  }
}

class EnvVarStore implements SecretStore {
  private envKey(key: string): string {
    const normalized = key.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    return `${ENV_PREFIX}${normalized}`;
  }

  async store(_key: string, _value: SecretValue): Promise<SecretStoreLayer> {
    throw new Error('Cannot store secrets via environment variables');
  }

  async load(key: string): Promise<SecretValue | null> {
    const val = process.env[this.envKey(key)];
    return val ? createSecret(val) : null;
  }

  async delete(key: string): Promise<void> {
    const envKey = this.envKey(key);
    if (envKey in process.env) {
      delete process.env[envKey];
    }
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    for (const name of Object.keys(process.env)) {
      if (name.startsWith(ENV_PREFIX)) {
        keys.push(name.slice(ENV_PREFIX.length));
      }
    }
    return keys;
  }
}

export function wipeSecret(secret: SecretValue): void {
  (secret as SecretValue & { __wiped?: boolean }).__wiped = true;
}

export class AutoSecretStore implements SecretStore {
  private layers: SecretStore[] = [];

  constructor(basePath: string) {
    this.layers.push(new OSKeychainStore());
    this.layers.push(
      new EncryptedFileSecretStore(basePath) as unknown as SecretStore
    );
    this.layers.push(new EnvVarStore());
  }

  async store(key: string, value: SecretValue): Promise<SecretStoreLayer> {
    for (const layer of this.layers) {
      try {
        await layer.store(key, value);
        const layerName =
          layer.constructor.name === 'OSKeychainStore'
            ? ('keychain' as SecretStoreLayer)
            : layer.constructor.name === 'EnvVarStore'
              ? ('env-var' as SecretStoreLayer)
              : ('encrypted-file' as SecretStoreLayer);
        for (const lower of this.layers) {
          if (lower !== layer) {
            await lower.delete(key).catch(() => {});
          }
        }
        return layerName;
      } catch {
        // continue to next layer
      }
    }
    throw new Error('No available secret store layer');
  }

  async load(key: string): Promise<SecretValue | null> {
    for (const layer of this.layers) {
      try {
        const val = await layer.load(key);
        if (val !== null) return val;
      } catch {
        // continue to next layer
      }
    }
    return null;
  }

  async delete(key: string): Promise<void> {
    for (const layer of this.layers) {
      await layer.delete(key).catch(() => {});
    }
  }

  async list(): Promise<string[]> {
    const keys = new Set<string>();
    for (const layer of this.layers) {
      const layerKeys = await layer.list().catch(() => [] as string[]);
      for (const k of layerKeys) keys.add(k);
    }
    return [...keys];
  }
}
