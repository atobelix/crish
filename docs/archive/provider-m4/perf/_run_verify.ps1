# R3 perf verification runner — writes results to docs/perf/_verify_out.txt
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
$out = Join-Path $PSScriptRoot '_verify_out.txt'
$log = @()

function Run-Step([string]$name, [string]$cmd) {
  $log = $script:log
  $log += "===== $name ====="
  $log += "CMD: $cmd"
  $log += "START: $(Get-Date -Format o)"
  try {
    $output = Invoke-Expression $cmd 2>&1 | Out-String
    $code = $LASTEXITCODE
    $log += $output
    $log += "EXIT: $code"
  } catch {
    $log += "EXCEPTION: $_"
    $code = 1
  }
  $log += "END: $(Get-Date -Format o)"
  $log += ""
  $script:log = $log
  return $code
}

$code1 = Run-Step 'typecheck' 'npm --workspace @crish/crish-desktop run typecheck'
$code2 = Run-Step 'perf-units' 'npx vitest run apps/crish-desktop/src/api/StreamRenderBuffer.test.ts apps/crish-desktop/src/api/VirtualScrollManager.test.ts apps/crish-desktop/src/store/autoIndexMiddleware.test.ts apps/crish-desktop/src/store/streamingStore.test.ts apps/crish-desktop/src/api/streamTextBatcher.test.ts packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts apps/crish-desktop/tests/fuzz/stream-buffer.test.ts apps/crish-desktop/tests/fuzz/virtual-scroll.test.ts'

$log += "===== SUMMARY ====="
$log += "typecheck_exit=$code1"
$log += "vitest_exit=$code2"
$log | Set-Content -Path $out -Encoding utf8
Write-Host "Wrote $out"
exit ([Math]::Max($code1, $code2))
