/**
 * Stream F 基准：1k 行代码高亮
 *
 * 目标：测量当前 JS 代码高亮管线（highlight.js）处理 1k 行代码的耗时，
 * 建立 Stream A（Rust syntect）切换前的基线。
 *
 * 测试矩阵：
 *   - TypeScript（真实项目代码样本，含类型、泛型、装饰器、async/await）
 *   - Python（含 dataclass、type hints、async）
 *   - Rust（含 trait、impl、生命周期、宏）
 *   - JSON（结构化数据，大量字符串与嵌套）
 *
 * 可重复执行：npx tsx scripts/bench-highlight-code.ts
 * 输出：perf-report/bench-highlight-code.json
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

async function loadHighlighter(): Promise<
  (code: string, langHint?: string) => string
> {
  const mod = await import('../apps/crish-desktop/src/api/codeHighlight');
  return mod.highlightCode;
}

function buildTypeScriptSample(lineCount: number): string {
  const lines: string[] = [];
  lines.push('// Auto-generated TypeScript benchmark sample');
  lines.push('import { Component, inject, signal, computed } from "@angular/core";');
  lines.push('import { HttpClient } from "@angular/common/http";');
  lines.push('import { Observable, forkJoin, of, from } from "rxjs";');
  lines.push('import { map, switchMap, catchError, debounceTime } from "rxjs/operators";');
  lines.push('');
  lines.push('export interface UserRecord {');
  lines.push('  id: string;');
  lines.push('  name: string;');
  lines.push('  email: string;');
  lines.push('  roles: ReadonlyArray<"admin" | "editor" | "viewer">;');
  lines.push('  metadata?: Record<string, unknown>;');
  lines.push('  createdAt: number;');
  lines.push('}');
  lines.push('');
  lines.push('@Component({');
  lines.push('  selector: "app-user-list",');
  lines.push('  template: `<div *ngFor="let u of users()">{{ u.name }}</div>`,');
  lines.push('})');
  lines.push('export class UserListComponent {');
  lines.push('  private readonly http = inject(HttpClient);');
  lines.push('  private readonly refresh = signal(0);');
  lines.push('');
  lines.push('  readonly users = computed(() => {');
  lines.push('    this.refresh();');
  lines.push('    return this.cachedUsers;');
  lines.push('  });');
  lines.push('');
  lines.push('  private cachedUsers: UserRecord[] = [];');
  lines.push('');
  lines.push('  constructor() {');
  lines.push('    this.loadUsers().subscribe((list) => {');
  lines.push('      this.cachedUsers = list;');
  lines.push('    });');
  lines.push('  }');
  lines.push('');
  lines.push('  async updateUser(id: string, patch: Partial<UserRecord>): Promise<void> {');
  lines.push('    await firstValueFrom(');
  lines.push('      this.http.patch<UserRecord>(`/api/users/${id}`, patch).pipe(');
  lines.push('        debounceTime(200),');
  lines.push('        catchError((err) => {');
  lines.push('          console.error("update failed", err);');
  lines.push('          return of(null as unknown as UserRecord);');
  lines.push('        }),');
  lines.push('      ),');
  lines.push('    );');
  lines.push('    this.refresh.update((n) => n + 1);');
  lines.push('  }');
  lines.push('');
  lines.push('  private loadUsers(): Observable<UserRecord[]> {');
  lines.push('    return this.http.get<UserRecord[]>("/api/users").pipe(');
  lines.push('      map((arr) => arr.filter((u) => u.roles.includes("admin"))),');
  lines.push('    );');
  lines.push('  }');
  lines.push('}');

  // 重复扩展到目标行数
  while (lines.length < lineCount) {
    const base = lines.length;
    for (let i = 0; i < base && lines.length < lineCount; i++) {
      const src = lines[i]!;
      // 在注释中插入行号避免完全相同（缓存命中）
      if (src.startsWith('//')) {
        lines.push(`// dup-${lines.length}: ${src.slice(2)}`);
      } else {
        lines.push(src);
      }
    }
  }
  return lines.slice(0, lineCount).join('\n');
}

function buildPythonSample(lineCount: number): string {
  const lines: string[] = [];
  lines.push('"""Auto-generated Python benchmark sample."""');
  lines.push('from __future__ import annotations');
  lines.push('import asyncio');
  lines.push('import dataclasses');
  lines.push('from typing import Any, Awaitable, Callable, Generic, TypeVar');
  lines.push('');
  lines.push('T = TypeVar("T")');
  lines.push('');
  lines.push('@dataclasses.dataclass');
  lines.push('class Result(Generic[T]):');
  lines.push('    value: T | None = None');
  lines.push('    error: Exception | None = None');
  lines.push('');
  lines.push('    def is_ok(self) -> bool:');
  lines.push('        return self.error is None');
  lines.push('');
  lines.push('    def unwrap(self) -> T:');
  lines.push('        if self.error is not None:');
  lines.push('            raise self.error');
  lines.push('        assert self.value is not None');
  lines.push('        return self.value');
  lines.push('');
  lines.push('async def gather_all(tasks: list[Awaitable[T]]) -> list[Result[T]]:');
  lines.push('    results: list[Result[T]] = []');
  lines.push('    for coro in asyncio.as_completed(tasks):');
  lines.push('        try:');
  lines.push('            value = await coro');
  lines.push('            results.append(Result(value=value))');
  lines.push('        except Exception as exc:');
  lines.push('            results.append(Result(error=exc))');
  lines.push('    return results');
  lines.push('');
  lines.push('def main() -> None:');
  lines.push('    async def task(n: int) -> int:');
  lines.push('        await asyncio.sleep(0.001)');
  lines.push('        return n * 2');
  lines.push('    loop = asyncio.new_event_loop()');
  lines.push('    try:');
  lines.push('        outcomes = loop.run_until_complete(');
  lines.push('            gather_all([task(i) for i in range(100)])');
  lines.push('        )');
  lines.push('        print(f"completed={len(outcomes)} ok={sum(1 for o in outcomes if o.is_ok())}")');
  lines.push('    finally:');
  lines.push('        loop.close()');
  lines.push('');
  lines.push('if __name__ == "__main__":');
  lines.push('    main()');

  while (lines.length < lineCount) {
    const base = lines.length;
    for (let i = 0; i < base && lines.length < lineCount; i++) {
      lines.push(`# dup-${lines.length}: ${lines[i]!}`);
    }
  }
  return lines.slice(0, lineCount).join('\n');
}

function buildRustSample(lineCount: number): string {
  const lines: string[] = [];
  lines.push('// Auto-generated Rust benchmark sample');
  lines.push('use std::collections::HashMap;');
  lines.push('use std::sync::Arc;');
  lines.push('use tokio::sync::RwLock;');
  lines.push('');
  lines.push('pub trait Repository<T>: Send + Sync {');
  lines.push('    async fn get(&self, id: &str) -> Option<Arc<T>>;');
  lines.push('    async fn put(&self, id: &str, value: T) -> Result<(), RepoError>;');
  lines.push('    async fn delete(&self, id: &str) -> Result<(), RepoError>;');
  lines.push('}');
  lines.push('');
  lines.push('#[derive(Debug, thiserror::Error)]');
  lines.push('pub enum RepoError {');
  lines.push('    #[error("not found: {0}")]');
  lines.push('    NotFound(String),');
  lines.push('    #[error("io: {0}")]');
  lines.push('    Io(#[from] std::io::Error),');
  lines.push('}');
  lines.push('');
  lines.push('pub struct InMemoryRepo<T: Clone + Send + Sync + \'static> {');
  lines.push('    inner: Arc<RwLock<HashMap<String, Arc<T>>>>,');
  lines.push('}');
  lines.push('');
  lines.push('impl<T: Clone + Send + Sync + \'static> InMemoryRepo<T> {');
  lines.push('    pub fn new() -> Self {');
  lines.push('        Self { inner: Arc::new(RwLock::new(HashMap::new())) }');
  lines.push('    }');
  lines.push('}');
  lines.push('');
  lines.push('impl<T: Clone + Send + Sync + \'static> Repository<T> for InMemoryRepo<T> {');
  lines.push('    async fn get(&self, id: &str) -> Option<Arc<T>> {');
  lines.push('        let guard = self.inner.read().await;');
  lines.push('        guard.get(id).cloned()');
  lines.push('    }');
  lines.push('    async fn put(&self, id: &str, value: T) -> Result<(), RepoError> {');
  lines.push('        let mut guard = self.inner.write().await;');
  lines.push('        guard.insert(id.to_string(), Arc::new(value));');
  lines.push('        Ok(())');
  lines.push('    }');
  lines.push('    async fn delete(&self, id: &str) -> Result<(), RepoError> {');
  lines.push('        let mut guard = self.inner.write().await;');
  lines.push('        guard.remove(id)');
  lines.push('        Ok(())');
  lines.push('    }');
  lines.push('}');

  while (lines.length < lineCount) {
    const base = lines.length;
    for (let i = 0; i < base && lines.length < lineCount; i++) {
      lines.push(`// dup-${lines.length}: ${lines[i]!}`);
    }
  }
  return lines.slice(0, lineCount).join('\n');
}

function buildJsonSample(lineCount: number): string {
  const lines: string[] = [];
  lines.push('{');
  lines.push('  "version": "2.0.0",');
  lines.push('  "metadata": {');
  lines.push('    "generatedAt": "2026-07-27T12:00:00Z",');
  lines.push('    "generator": "bench-highlight-code",');
  lines.push('    "tags": ["benchmark", "highlight", "json"]');
  lines.push('  },');
  lines.push('  "entries": [');
  for (let i = 0; i < lineCount - 10; i++) {
    const isLast = i === lineCount - 11;
    lines.push(
      `    { "id": ${i}, "name": "entry-${i}", "active": ${i % 3 === 0}, "score": ${(i * 0.37).toFixed(4)} }${isLast ? '' : ','}`,
    );
  }
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n');
}

interface LangBenchSample {
  index: number;
  elapsedMs: number;
  htmlLength: number;
}

interface LangBenchResult {
  lang: string;
  inputLines: number;
  inputChars: number;
  samples: LangBenchSample[];
  warmupSamples: LangBenchSample[];
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  ops: number;
  htmlLength: number;
}

interface BenchReport {
  name: string;
  timestamp: string;
  targetLines: number;
  iterations: number;
  warmupIterations: number;
  results: LangBenchResult[];
}

function percentile(sorted: number[], rank: number): number {
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * rank) - 1),
  );
  return Math.round(sorted[i]! * 100) / 100;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

async function benchLang(
  highlightCode: (code: string, lang?: string) => string,
  code: string,
  lang: string,
  iterations: number,
  warmupIterations: number,
): Promise<LangBenchResult> {
  const samples: LangBenchSample[] = [];
  const warmupSamples: LangBenchSample[] = [];

  // Warmup（让 highlight.js 注册语言并填充缓存）
  for (let i = 0; i < warmupIterations; i++) {
    // 追加唯一注释避免缓存命中
    const input =
      lang === 'json'
        ? code.replace('"generator"', `"warmup-${i}-${Date.now()}"`)
        : code + `\n// warmup-${i}-${Date.now()}-${Math.random()}\n`;
    const start = performance.now();
    const html = highlightCode(input, lang);
    const elapsed = performance.now() - start;
    warmupSamples.push({ index: i, elapsedMs: elapsed, htmlLength: html.length });
  }

  for (let i = 0; i < iterations; i++) {
    const input =
      lang === 'json'
        ? code.replace('"generator"', `"bench-${i}-${Date.now()}"`)
        : code + `\n// bench-${i}-${Date.now()}-${Math.random()}\n`;
    const start = performance.now();
    const html = highlightCode(input, lang);
    const elapsed = performance.now() - start;
    samples.push({ index: i, elapsedMs: elapsed, htmlLength: html.length });
  }

  const values = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const avgMs = values.reduce((a, b) => a + b, 0) / values.length;

  return {
    lang,
    inputLines: code.split('\n').length,
    inputChars: code.length,
    samples,
    warmupSamples,
    avgMs: round2(avgMs),
    minMs: round2(values[0]!),
    maxMs: round2(values[values.length - 1]!),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    ops: avgMs > 0 ? Math.round(1000 / avgMs) : 0,
    htmlLength: samples[samples.length - 1]!.htmlLength,
  };
}

async function main(): Promise<void> {
  const highlightCode = await loadHighlighter();
  const targetLines = 1000;
  const iterations = 20;
  const warmupIterations = 3;

  console.log('='.repeat(60));
  console.log('基准：highlight.code.1k');
  console.log('='.repeat(60));
  console.log(`目标行数: ${targetLines}`);

  const samples: Array<{ lang: string; code: string }> = [
    { lang: 'typescript', code: buildTypeScriptSample(targetLines) },
    { lang: 'python', code: buildPythonSample(targetLines) },
    { lang: 'rust', code: buildRustSample(targetLines) },
    { lang: 'json', code: buildJsonSample(targetLines) },
  ];

  const results: LangBenchResult[] = [];
  for (const { lang, code } of samples) {
    console.log(`\n[${lang}] ${code.length} 字符 / ${code.split('\n').length} 行`);
    const result = await benchLang(highlightCode, code, lang, iterations, warmupIterations);
    results.push(result);
    console.log(
      `  平均: ${result.avgMs}ms  P95: ${result.p95Ms}ms  吞吐: ${result.ops} ops/s`,
    );
  }

  const report: BenchReport = {
    name: 'highlight.code.1k',
    timestamp: new Date().toISOString(),
    targetLines,
    iterations,
    warmupIterations,
    results,
  };

  console.log('\n' + '-'.repeat(60));
  console.log('汇总:');
  for (const r of results) {
    console.log(
      `  ${r.lang.padEnd(12)} avg=${r.avgMs}ms p95=${r.p95Ms}ms ops=${r.ops}`,
    );
  }

  const reportPath = 'perf-report/bench-highlight-code.json';
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已保存到 ${reportPath}`);
}

main().catch((err) => {
  console.error('基准测试失败:', err);
  process.exitCode = 1;
});
