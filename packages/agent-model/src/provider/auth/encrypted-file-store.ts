import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createSecret, type SecretValue } from './types';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 64;
const PBKDF2_ITERATIONS = 600000;
const PBKDF2_DIGEST = 'sha512';

interface VaultContent {
  format: 1;
  salt: string;
  vault: Record<string, string>;
}

export class EncryptedFileSecretStore {
  private filePath: string;
  private cipherKey?: Buffer;
  private salt?: Buffer;
  private masterKeyFilePath: string;

  constructor(
    basePath: string,
    private masterKey?: string
  ) {
    this.filePath = path.join(basePath, '.crish-secrets.enc');
    this.masterKeyFilePath = path.join(
      process.platform === 'win32'
        ? process.env.APPDATA
          ? path.join(process.env.APPDATA, 'Crish', 'AgentWorkbench')
          : path.join(
              os.homedir(),
              'AppData',
              'Roaming',
              'Crish',
              'AgentWorkbench'
            )
        : process.platform === 'darwin'
          ? path.join(
              os.homedir(),
              'Library',
              'Application Support',
              'Crish',
              'AgentWorkbench'
            )
          : path.join(os.homedir(), '.config', 'crish', 'agent-workbench'),
      '.crish-master-key'
    );
  }

  private loadOrGenerateMasterKey(): string {
    try {
      if (fs.existsSync(this.masterKeyFilePath)) {
        return fs.readFileSync(this.masterKeyFilePath, 'utf-8').trim();
      }
    } catch (err) {
      console.warn(
        '[EncryptedFileStore] loadOrGenerateMasterKey read failed:',
        err
      );
    }
    const key = crypto.randomBytes(32).toString('hex');
    try {
      const dir = path.dirname(this.masterKeyFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.masterKeyFilePath, key, 'utf-8');
      try {
        fs.chmodSync(this.masterKeyFilePath, 0o600);
      } catch {
        try {
          execSync(
            `icacls "${this.masterKeyFilePath}" /inheritance:r /grant "${process.env.USERNAME ?? 'Users'}:(R,W)"`,
            { timeout: 5000, windowsHide: true }
          );
        } catch {
          /* best effort */
        }
      }
    } catch (err) {
      console.warn('[EncryptedFileStore] master key write failed:', err);
    }
    return key;
  }

  private get password(): string {
    if (this.masterKey) return this.masterKey;
    const masterKey = this.loadOrGenerateMasterKey();
    return `${masterKey}${process.env.COMPUTERNAME ?? ''}${process.env.USERNAME ?? ''}${os.hostname()}`;
  }

  private get oldPasswordFallback(): string {
    return `${process.env.COMPUTERNAME ?? ''}${process.env.USERNAME ?? ''}${os.hostname()}`;
  }

  private async deriveKey(salt: Buffer): Promise<Buffer> {
    return crypto.pbkdf2Sync(
      this.password,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      PBKDF2_DIGEST
    );
  }

  private async ensureKey(): Promise<{ key: Buffer; salt: Buffer }> {
    if (this.cipherKey && this.salt) {
      return { key: this.cipherKey, salt: this.salt };
    }
    const content = this.readVault();
    if (content) {
      this.salt = Buffer.from(content.salt, 'base64');
      this.cipherKey = await this.deriveKey(this.salt);
    } else {
      this.salt = crypto.randomBytes(SALT_LENGTH);
      this.cipherKey = await this.deriveKey(this.salt);
    }
    return { key: this.cipherKey, salt: this.salt };
  }

  private vaultPath(): string {
    return this.filePath;
  }

  private readVault(): VaultContent | null {
    try {
      const raw = fs.readFileSync(this.vaultPath(), 'utf-8');
      const parsed = JSON.parse(raw) as VaultContent;
      if (parsed.format === 1 && parsed.salt && parsed.vault) {
        return parsed;
      }
      return null;
    } catch (err) {
      console.warn('[EncryptedFileStore] readVault failed:', err);
      return null;
    }
  }

  private writeVault(salt: Buffer, vault: Record<string, string>): void {
    const dir = path.dirname(this.vaultPath());
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content: VaultContent = {
      format: 1,
      salt: salt.toString('base64'),
      vault,
    };
    fs.writeFileSync(this.vaultPath(), JSON.stringify(content), 'utf-8');
    try {
      fs.chmodSync(this.vaultPath(), 0o600);
    } catch (err) {
      console.warn('[EncryptedFileStore] chmod failed:', err);
    }
  }

  async store(key: string, value: SecretValue): Promise<void> {
    const { key: derivedKey, salt } = await this.ensureKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, 'utf-8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const record = Buffer.concat([iv, tag, encrypted]);
    const encoded = record.toString('base64');

    const content = this.readVault() ?? {
      format: 1 as const,
      salt: salt.toString('base64'),
      vault: {},
    };
    content.vault[key] = encoded;
    this.writeVault(this.salt ?? salt, content.vault);
  }

  async load(key: string): Promise<SecretValue | null> {
    const content = this.readVault();
    if (!content) return null;

    const encoded = content.vault[key];
    if (!encoded) return null;

    try {
      const { key: derivedKey } = await this.ensureKey();
      const record = Buffer.from(encoded, 'base64');
      const iv = record.subarray(0, IV_LENGTH);
      const tag = record.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const ciphertext = record.subarray(IV_LENGTH + TAG_LENGTH);

      const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return createSecret(decrypted.toString('utf-8'));
    } catch {
      // Fallback: try old password format for backward compatibility
      try {
        const salt = Buffer.from(content.salt, 'base64');
        const oldKey = crypto.pbkdf2Sync(
          this.oldPasswordFallback,
          salt,
          PBKDF2_ITERATIONS,
          KEY_LENGTH,
          PBKDF2_DIGEST
        );
        const record = Buffer.from(encoded, 'base64');
        const iv = record.subarray(0, IV_LENGTH);
        const tag = record.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
        const ciphertext = record.subarray(IV_LENGTH + TAG_LENGTH);
        const decipher = crypto.createDecipheriv(ALGORITHM, oldKey, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        return createSecret(decrypted.toString('utf-8'));
      } catch (fallbackErr) {
        console.warn(
          '[EncryptedFileStore] decrypt fallback failed:',
          fallbackErr
        );
        return null;
      }
    }
  }

  async delete(key: string): Promise<void> {
    const content = this.readVault();
    if (!content) return;
    if (!(key in content.vault)) return;
    delete content.vault[key];
    this.writeVault(
      this.salt ?? Buffer.from(content.salt, 'base64'),
      content.vault
    );
  }

  async list(): Promise<string[]> {
    const content = this.readVault();
    if (!content) return [];
    return Object.keys(content.vault);
  }
}
