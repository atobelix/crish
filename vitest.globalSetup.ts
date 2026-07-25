/**
 * Outer isolation layer for all vitest test suites.
 * Clears all Provider API key environment variables to prevent
 * accidental real API calls during testing.
 *
 * This runs once per worker process before any test file is loaded.
 */

const PROVIDER_API_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'GROQ_API_KEY',
  'DEEPSEEK_API_KEY',
  'PERPLEXITY_API_KEY',
  'OPENROUTER_API_KEY',
  'CUSTOM_PROVIDER_API_KEY',
  'CRISH_API_KEY',
  'FLOWBIT_API_KEY',
];

export async function setup(): Promise<void> {
  for (const key of PROVIDER_API_KEYS) {
    if (process.env[key]) {
      process.env[`__TEST_BACKUP_${key}__`] = process.env[key]!;
      delete process.env[key];
    }
  }
  for (const envKey of Object.keys(process.env)) {
    if (envKey.startsWith('CONEX_API_KEY_')) {
      const backupKey = `__TEST_BACKUP_${envKey}__`;
      process.env[backupKey] = process.env[envKey]!;
      delete process.env[envKey];
    }
  }
}

export async function teardown(): Promise<void> {
  for (const key of PROVIDER_API_KEYS) {
    const backupKey = `__TEST_BACKUP_${key}__`;
    if (process.env[backupKey]) {
      process.env[key] = process.env[backupKey];
      delete process.env[backupKey];
    }
  }
  for (const backupKey of Object.keys(process.env)) {
    if (backupKey.startsWith('__TEST_BACKUP_CONEX_API_KEY_')) {
      const originalKey = backupKey.slice('__TEST_BACKUP_'.length, -'__'.length);
      process.env[originalKey] = process.env[backupKey]!;
      delete process.env[backupKey];
    }
  }
}
