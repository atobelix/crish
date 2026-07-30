import {
  validateProviderFile,
  validateProviderDirectory,
} from './provider-validate';
import { testProviderConnection } from './provider-test';
import { listProviders } from './provider-list';
import { runDev, parseDevArgs } from './provider-dev';
import { ProviderRegistryV2Impl } from '../registry-v2';
import { registerBuiltinProviders } from '../builtin';

function printHelp(): void {
  console.log(`
Usage: crish provider <command> [options]

Commands:
  validate <file>              Validate a provider JSON definition
  validate --dir <directory>   Validate all JSON files in a directory
  test <id>                    Test a provider connection
  list [filter]                List all providers (optional text filter)
  dev                          Developer REPL mode

Options:
  --provider <id>     Provider ID (dev mode)
  --model <id>        Model ID (dev mode, optional)
  --prompt "text"     Single prompt (dev mode)
  --stream            Enable streaming (dev mode)
`);
}

async function cmdValidate(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: crish provider validate <file>');
    process.exit(1);
  }

  if (args[0] === '--dir' && args[1]) {
    const reports = validateProviderDirectory(args[1]!);
    for (const r of reports) {
      const icon = r.valid ? '✓' : '✗';
      console.log(`${icon} ${r.filePath}`);
      for (const e of r.errors) console.log(`   error: ${e}`);
      for (const w of r.warnings) console.log(`   warn:  ${w}`);
    }
    return;
  }

  const report = validateProviderFile(args[0]!);
  const icon = report.valid ? '✓' : '✗';
  console.log(`${icon} ${report.filePath}`);
  for (const e of report.errors) console.log(`   error: ${e}`);
  for (const w of report.warnings) console.log(`   warn:  ${w}`);
}

async function cmdTest(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error('Usage: crish provider test <id>');
    process.exit(1);
  }

  const providerId = args[0]!;
  const registry = new ProviderRegistryV2Impl();
  registerBuiltinProviders(registry);

  const entry = registry.getDeclarativeEntry(providerId);
  if (!entry) {
    console.error(`Unknown provider: ${providerId}`);
    process.exit(1);
  }

  const apiKey = process.env[entry.declarative.auth.defaultEnvVar] ?? '';
  if (!apiKey) {
    console.error(
      `API key not found. Set ${entry.declarative.auth.defaultEnvVar}`
    );
    process.exit(1);
  }

  const result = await testProviderConnection(registry, providerId, apiKey);
  const icon = result.success ? '✓' : '✗';
  console.log(`${icon} ${result.providerId} (${result.duration}ms)`);
  console.log(`   Base URL: ${result.baseUrl}`);
  console.log(`   Model: ${result.model}`);
  if (result.error) console.log(`   Error: ${result.error}`);
  if (result.details) {
    console.log(
      `   Model list:  ${result.details.modelListAvailable ? '✓' : '✗'}`
    );
    console.log(`   Streaming:   ${result.details.streamingWorks ? '✓' : '✗'}`);
    console.log(`   Tool calls:  ${result.details.toolCallWorks ? '✓' : '✗'}`);
  }
}

async function cmdList(args: string[]): Promise<void> {
  const registry = new ProviderRegistryV2Impl();
  registerBuiltinProviders(registry);

  const filter = args[0];
  const providers = listProviders(registry, {
    ...(filter !== undefined ? { filter } : {}),
  });

  if (providers.length === 0) {
    console.log('No providers found');
    return;
  }

  const rows = providers.map(
    (p) =>
      `${p.id.padEnd(20)} ${p.name.padEnd(18)} ${p.engine.padEnd(22)} ${String(p.models).padStart(3)} models  ${p.capabilities}`
  );
  console.log(
    'ID                    Name               Engine                  Models  Capabilities'
  );
  console.log('-'.repeat(90));
  for (const r of rows) console.log(r);
}

async function cmdDev(args: string[]): Promise<void> {
  const devArgs = parseDevArgs(args);
  await runDev(devArgs);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printHelp();
    return;
  }

  const subArgs = process.argv.slice(3);

  switch (subcommand) {
    case 'validate':
      await cmdValidate(subArgs);
      break;
    case 'test':
      await cmdTest(subArgs);
      break;
    case 'list':
      await cmdList(subArgs);
      break;
    case 'dev':
      await cmdDev(subArgs);
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
