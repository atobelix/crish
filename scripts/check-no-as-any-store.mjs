/**
 * Store 类型/切片门禁：禁止 layout 与 domain action 重新引入 `as any`，
 * 并做 sessionsById / facade / storeAccess / 反环约定扫描。
 *
 * Run: npm run check:store-types
 * Also invoked from CI (.github/workflows/ci.yml).
 *
 * No git hooks required — prefer this script + CI over husky.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const storeDir = resolve(root, 'apps/crish-desktop/src/store');
const storeAccessPath = resolve(root, 'apps/crish-desktop/src/api/storeAccess.ts');
const storeReadmePath = resolve(storeDir, 'README.md');
const storeBarrelPath = resolve(storeDir, 'index.ts');

/** 收集 store 目录下全部 .ts（不含 .d.ts） */
function listStoreTsFiles() {
  if (!existsSync(storeDir)) return [];
  return readdirSync(storeDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(storeDir, f));
}

/**
 * Forbidden patterns（action 接线 / 类型逃逸回归）。
 * 保持足够具体，避免误伤注释里的说明文字以外的合理代码。
 */
const FORBIDDEN_LINE = [
  {
    re: /\bset\s+as\s+any\b/,
    label: 'set as any',
  },
  {
    re: /\bget\s+as\s+any\b/,
    label: 'get as any',
  },
  {
    re: /createSessionActions\s*\(\s*set\s+as\s+any/,
    label: 'createSessionActions(set as any',
  },
  {
    re: /createWorkspaceActions\s*\(\s*set\s+as\s+any/,
    label: 'createWorkspaceActions(set as any',
  },
  {
    // 代码中的 `as any`（允许出现在 // 或 /* 注释）
    re: /(?<![\w$])as\s+any\b/,
    label: 'as any cast',
    skipIfComment: true,
  },
  {
    // store 域内禁止 : any 注解（含 let x: any）
    re: /:\s*any\b/,
    label: ': any annotation',
    skipIfComment: true,
  },
  {
    // 双层 any 逃逸
    re: /as\s+unknown\s+as\s+any\b/,
    label: 'as unknown as any',
    skipIfComment: true,
  },
  {
    // 禁止用 @ts-* 掩盖类型问题
    re: /@ts-(?:ignore|expect-error|nocheck)\b/,
    label: '@ts-ignore / @ts-expect-error / @ts-nocheck',
  },
  {
    // 禁止关闭 any 相关 lint
    re: /eslint-disable(?:-next-line)?\s+[^\n]*\bno-explicit-any\b/,
    label: 'eslint-disable no-explicit-any',
    skipIfComment: false,
  },
];

/** 文件级：须存在 sessionsById 同步约定相关导出（sessionIndex） */
const SESSION_INDEX_REQUIRED = [
  { re: /export\s+function\s+buildSessionsById\b/, label: 'buildSessionsById' },
  { re: /export\s+function\s+reindexSessionsById\b/, label: 'reindexSessionsById' },
  { re: /export\s+function\s+getSessionById\b/, label: 'getSessionById' },
  { re: /export\s+function\s+checkSessionsIndex\b/, label: 'checkSessionsIndex' },
  { re: /export\s+function\s+isSessionsIndexConsistent\b/, label: 'isSessionsIndexConsistent' },
  { re: /export\s+function\s+assertSessionsIndexConsistent\b/, label: 'assertSessionsIndexConsistent' },
];

/** layoutStore 须用泛型切片接线，禁止 any 遥测入参 */
const LAYOUT_REQUIRED = [
  {
    re: /createSessionActions\s*\(\s*set\s*,\s*get\s*\)/,
    label: 'createSessionActions(set, get) without cast',
  },
  {
    re: /createWorkspaceActions\s*\(\s*set\s*,\s*get\s*\)/,
    label: 'createWorkspaceActions(set, get) without cast',
  },
  {
    re: /syncTelemetryData:\s*\(data:\s*TelemetrySyncPayload\)/,
    label: 'syncTelemetryData typed as TelemetrySyncPayload',
  },
  {
    re: /export\s+type\s+TelemetrySyncPayload\b/,
    label: 'export type TelemetrySyncPayload',
  },
];

/**
 * 域 actions：必须有切片接口 + 泛型 create*，且禁止 import layoutStore（反环）。
 */
const ACTION_MODULE_REQUIRED = [
  {
    file: 'sessionActions.ts',
    patterns: [
      { re: /export\s+interface\s+SessionStoreSlice\b/, label: 'SessionStoreSlice interface' },
      {
        re: /export\s+function\s+createSessionActions\s*<\s*T\s+extends\s+SessionStoreSlice\s*>/,
        label: 'createSessionActions<T extends SessionStoreSlice>',
      },
    ],
    forbidImport: [
      { re: /from\s+['\"]\.\/layoutStore['\"]/, label: 'must not import ./layoutStore (cycle)' },
      { re: /from\s+['\"]\.\/sessionStore['\"]/, label: 'must not import ./sessionStore (cycle)' },
    ],
  },
  {
    file: 'workspaceActions.ts',
    patterns: [
      { re: /export\s+interface\s+WorkspaceStoreSlice\b/, label: 'WorkspaceStoreSlice interface' },
      {
        re: /export\s+function\s+createWorkspaceActions\s*<\s*T\s+extends\s+WorkspaceStoreSlice\s*>/,
        label: 'createWorkspaceActions<T extends WorkspaceStoreSlice>',
      },
    ],
    forbidImport: [
      { re: /from\s+['\"]\.\/layoutStore['\"]/, label: 'must not import ./layoutStore (cycle)' },
      { re: /from\s+['\"]\.\/workspaceStore['\"]/, label: 'must not import ./workspaceStore (cycle)' },
    ],
  },
];

/**
 * 三门面对齐：同引用 alias + 命令式 get*State + 域 helper。
 * 防止 Phase 1 facade 退回「只 re-export 无 getState」。
 */
const FACADE_REQUIRED = [
  {
    file: 'sessionStore.ts',
    patterns: [
      { re: /export\s+const\s+useSessionStore\s*=\s*useLayoutStore\b/, label: 'useSessionStore = useLayoutStore' },
      { re: /export\s+function\s+getSessionStoreState\b/, label: 'getSessionStoreState' },
      { re: /export\s+function\s+getSessionById\b/, label: 'getSessionById' },
      { re: /export\s+function\s+getActiveSession\b/, label: 'getActiveSession' },
      { re: /export\s+function\s+getActiveSessionId\b/, label: 'getActiveSessionId' },
      { re: /export\s+function\s+getSessionAgent\b/, label: 'getSessionAgent' },
      { re: /export\s+function\s+useSessionField\b/, label: 'useSessionField' },
    ],
    // 门面互不 import，避免 multi-store 前形成假依赖
    forbidImport: [
      { re: /from\s+['\"]\.\/workspaceStore['\"]/, label: 'sessionStore must not import workspaceStore' },
      { re: /from\s+['\"]\.\/settingsUiStore['\"]/, label: 'sessionStore must not import settingsUiStore' },
    ],
    getStateCast: {
      re: /as\s+unknown\s+as\s+SessionFacade\b/,
      label: 'getSessionStoreState as unknown as SessionFacade',
      max: 1,
    },
  },
  {
    file: 'workspaceStore.ts',
    patterns: [
      { re: /export\s+const\s+useWorkspaceStore\s*=\s*useLayoutStore\b/, label: 'useWorkspaceStore = useLayoutStore' },
      { re: /export\s+function\s+getWorkspaceStoreState\b/, label: 'getWorkspaceStoreState' },
      { re: /export\s+function\s+getActiveWorkspace\b/, label: 'getActiveWorkspace' },
      { re: /export\s+function\s+getDropPreview\b/, label: 'getDropPreview' },
      { re: /export\s+function\s+setGroupActiveCard\b/, label: 'setGroupActiveCard' },
      { re: /export\s+function\s+focusExistingPanelCard\b/, label: 'focusExistingPanelCard' },
      { re: /export\s+function\s+setDropPreview\b/, label: 'setDropPreview' },
      { re: /export\s+function\s+useWorkspaceField\b/, label: 'useWorkspaceField' },
    ],
    forbidImport: [
      { re: /from\s+['\"]\.\/sessionStore['\"]/, label: 'workspaceStore must not import sessionStore' },
      { re: /from\s+['\"]\.\/settingsUiStore['\"]/, label: 'workspaceStore must not import settingsUiStore' },
    ],
    getStateCast: {
      re: /as\s+unknown\s+as\s+WorkspaceFacade\b/,
      label: 'getWorkspaceStoreState as unknown as WorkspaceFacade',
      max: 1,
    },
  },
  {
    file: 'settingsUiStore.ts',
    patterns: [
      { re: /export\s+const\s+useSettingsUiStore\s*=\s*useLayoutStore\b/, label: 'useSettingsUiStore = useLayoutStore' },
      { re: /export\s+function\s+getSettingsUiState\b/, label: 'getSettingsUiState' },
      { re: /export\s+function\s+getPermissionMode\b/, label: 'getPermissionMode' },
      { re: /export\s+function\s+openSettings\b/, label: 'openSettings' },
      { re: /export\s+function\s+closeSettings\b/, label: 'closeSettings' },
      { re: /export\s+function\s+toggleSettingsOverlay\b/, label: 'toggleSettingsOverlay' },
      { re: /export\s+function\s+setPermissionMode\b/, label: 'setPermissionMode' },
      { re: /export\s+function\s+setSettingsActiveTab\b/, label: 'setSettingsActiveTab' },
      { re: /export\s+function\s+useSettingsUiField\b/, label: 'useSettingsUiField' },
    ],
    forbidImport: [
      { re: /from\s+['\"]\.\/sessionStore['\"]/, label: 'settingsUiStore must not import sessionStore' },
      { re: /from\s+['\"]\.\/workspaceStore['\"]/, label: 'settingsUiStore must not import workspaceStore' },
    ],
    getStateCast: {
      re: /as\s+unknown\s+as\s+SettingsUiFacade\b/,
      label: 'getSettingsUiState as unknown as SettingsUiFacade',
      max: 1,
    },
  },
];

/** barrel 须 re-export 三门面入口 */
const BARREL_REQUIRED = [
  { re: /export\s+\{[^}]*\buseSessionStore\b[^}]*\}\s+from\s+['\"]\.\/sessionStore['\"]/, label: 're-export useSessionStore' },
  { re: /export\s+\{[^}]*\buseWorkspaceStore\b[^}]*\}\s+from\s+['\"]\.\/workspaceStore['\"]/, label: 're-export useWorkspaceStore' },
  { re: /export\s+\{[^}]*\buseSettingsUiStore\b[^}]*\}\s+from\s+['\"]\.\/settingsUiStore['\"]/, label: 're-export useSettingsUiStore' },
  { re: /export\s+\{[^}]*\buseLayoutStore\b[^}]*\}\s+from\s+['\"]\.\/layoutStore['\"]/, label: 're-export useLayoutStore' },
];

function isCommentOnlyLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

/** 去掉行内 // 注释后再匹配，减少误报 */
function codePart(line) {
  // 粗略：字符串内 // 不管；store 代码几乎无此模式
  const idx = line.indexOf('//');
  if (idx === -1) return line;
  // 忽略 URL 中的 //
  if (line.slice(0, idx).includes('http:') || line.slice(0, idx).includes('https:')) {
    return line;
  }
  return line.slice(0, idx);
}

/** 统计非注释行中正则命中次数 */
function countInCode(src, re) {
  let n = 0;
  for (const line of src.split(/\r?\n/)) {
    if (isCommentOnlyLine(line)) continue;
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    const globalRe = new RegExp(re.source, flags);
    const part = codePart(line);
    const m = part.match(globalRe);
    if (m) n += m.length;
  }
  return n;
}

let failed = false;

function fail(msg) {
  console.error(`[check-no-as-any-store] ${msg}`);
  failed = true;
}

function scanForbidden(abs, rel) {
  const src = readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  for (const rule of FORBIDDEN_LINE) {
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (rule.skipIfComment && isCommentOnlyLine(raw)) continue;
      const part = rule.skipIfComment ? codePart(raw) : raw;
      if (rule.re.test(part)) {
        fail(`forbidden pattern "${rule.label}" in ${rel}:${i + 1}`);
        console.error(`  ${raw.trim()}`);
      }
    }
  }
  return src;
}

const files = listStoreTsFiles();
if (files.length === 0) {
  fail(`missing store dir or empty: ${relative(root, storeDir)}`);
}

// store/README 须存在（架构约定文档；内容最小即可）
if (!existsSync(storeReadmePath)) {
  fail('missing apps/crish-desktop/src/store/README.md');
}

for (const abs of files) {
  const rel = relative(root, abs).replace(/\\/g, '/');
  const src = scanForbidden(abs, rel);

  // 非 facade 生产文件禁止散落 as unknown as（测试文件除外）
  const base = basename(abs);
  const isFacade = /^(session|workspace|settingsUi)Store\.ts$/.test(base);
  const isTest = /\.test\.ts$/.test(base);
  if (!isFacade && !isTest) {
    const unknownCasts = countInCode(src, /as\s+unknown\s+as\b/);
    if (unknownCasts > 0) {
      fail(
        `${rel}: forbidden \`as unknown as\` outside facade get*StoreState (found ${unknownCasts})`,
      );
    }
  }
}

// sessionIndex 必须导出一致性检查
{
  const abs = resolve(storeDir, 'sessionIndex.ts');
  const rel = 'apps/crish-desktop/src/store/sessionIndex.ts';
  if (!existsSync(abs)) {
    fail(`missing file: ${rel}`);
  } else {
    const src = readFileSync(abs, 'utf8');
    for (const { re, label } of SESSION_INDEX_REQUIRED) {
      if (!re.test(src)) {
        fail(`${rel} missing required export/symbol: ${label}`);
      }
    }
  }
}

// layoutStore 接线约定
{
  const abs = resolve(storeDir, 'layoutStore.ts');
  const rel = 'apps/crish-desktop/src/store/layoutStore.ts';
  if (!existsSync(abs)) {
    fail(`missing file: ${rel}`);
  } else {
    const src = readFileSync(abs, 'utf8');
    for (const { re, label } of LAYOUT_REQUIRED) {
      if (!re.test(src)) {
        fail(`${rel} missing required pattern: ${label}`);
      }
    }
  }
}

// 域 actions：泛型切片 + 反环
for (const mod of ACTION_MODULE_REQUIRED) {
  const abs = resolve(storeDir, mod.file);
  const rel = `apps/crish-desktop/src/store/${mod.file}`;
  if (!existsSync(abs)) {
    fail(`missing action module: ${rel}`);
    continue;
  }
  const src = readFileSync(abs, 'utf8');
  for (const { re, label } of mod.patterns) {
    if (!re.test(src)) {
      fail(`${rel} missing required pattern: ${label}`);
    }
  }
  for (const { re, label } of mod.forbidImport) {
    if (re.test(src)) {
      fail(`${rel} forbidden: ${label}`);
    }
  }
}

// 三门面对齐约定 + 反交叉 import + cast 纪律
for (const facade of FACADE_REQUIRED) {
  const abs = resolve(storeDir, facade.file);
  const rel = `apps/crish-desktop/src/store/${facade.file}`;
  if (!existsSync(abs)) {
    fail(`missing facade file: ${rel}`);
    continue;
  }
  const src = readFileSync(abs, 'utf8');
  for (const { re, label } of facade.patterns) {
    if (!re.test(src)) {
      fail(`${rel} missing required facade symbol: ${label}`);
    }
  }
  if (facade.forbidImport) {
    for (const { re, label } of facade.forbidImport) {
      if (re.test(src)) {
        fail(`${rel} forbidden: ${label}`);
      }
    }
  }
  if (facade.getStateCast) {
    const hits = countInCode(src, facade.getStateCast.re);
    if (hits === 0) {
      fail(`${rel} missing required cast: ${facade.getStateCast.label}`);
    } else if (hits > facade.getStateCast.max) {
      fail(
        `${rel}: expected at most ${facade.getStateCast.max} \`${facade.getStateCast.label}\`; found ${hits}`,
      );
    }
    // 其它 as unknown as 形态一律禁止（只允许门面 getState 那一处）
    const allUnknown = countInCode(src, /as\s+unknown\s+as\b/);
    if (allUnknown > hits) {
      fail(
        `${rel}: extra \`as unknown as\` beyond get*StoreState narrowing (found ${allUnknown}, allowed ${hits})`,
      );
    }
  }
}

// barrel re-export 三门面
{
  const rel = 'apps/crish-desktop/src/store/index.ts';
  if (!existsSync(storeBarrelPath)) {
    fail(`missing barrel: ${rel}`);
  } else {
    const src = readFileSync(storeBarrelPath, 'utf8');
    for (const { re, label } of BARREL_REQUIRED) {
      if (!re.test(src)) {
        fail(`${rel} missing required pattern: ${label}`);
      }
    }
  }
}

// storeAccess 须编排三域 + 禁止 as any / : any；跨域写走 getLayoutState
{
  const accessRel = 'apps/crish-desktop/src/api/storeAccess.ts';
  if (!existsSync(storeAccessPath)) {
    fail(`missing file: ${accessRel}`);
  } else {
    let src = scanForbidden(storeAccessPath, accessRel);
    const storeAccessSubDir = resolve(dirname(storeAccessPath), 'store-access');
    if (existsSync(storeAccessSubDir)) {
      for (const subFile of readdirSync(storeAccessSubDir)) {
        if (subFile.endsWith('.ts')) {
          const subPath = join(storeAccessSubDir, subFile);
          src += '\n' + scanForbidden(subPath, `apps/crish-desktop/src/api/store-access/${subFile}`);
        }
      }
    }
    const accessRequired = [
      { re: /export\s+function\s+getLayoutState\b/, label: 'getLayoutState' },
      { re: /export\s+function\s+focusOrOpenPanel\b/, label: 'focusOrOpenPanel' },
      { re: /export\s+(?:function|\{[^}]*\b)getActiveSession\b/, label: 'getActiveSession' },
      { re: /export\s+(?:function|\{[^}]*\b)getActiveSessionId\b/, label: 'getActiveSessionId' },
      { re: /export\s+(?:function|\{[^}]*\b)getSessionAgent\b/, label: 'getSessionAgent' },
      { re: /export\s+(?:function|\{[^}]*\b)getPermissionMode\b/, label: 'getPermissionMode' },
      { re: /export\s+(?:function|\{[^}]*\b)getDropPreview\b/, label: 'getDropPreview' },
      { re: /export\s+(?:function|\{[^}]*\b)setGroupActiveCard\b/, label: 'setGroupActiveCard' },
      { re: /export\s+function\s+unarchiveSession\b/, label: 'unarchiveSession' },
      { re: /export\s+function\s+setActiveAgentId\b/, label: 'setActiveAgentId' },
      { re: /export\s+function\s+addMessageToolCall\b/, label: 'addMessageToolCall' },
      { re: /export\s+function\s+pushDiffFile\b/, label: 'pushDiffFile' },
      { re: /export\s+function\s+setAppSettings\b/, label: 'setAppSettings' },
      { re: /export\s+function\s+getAppSettings\b/, label: 'getAppSettings' },
      { re: /export\s+function\s+getCommandPermissions\b/, label: 'getCommandPermissions' },
      { re: /export\s+function\s+addCommandPermission\b/, label: 'addCommandPermission' },
      { re: /export\s+function\s+setPlanApproved\b/, label: 'setPlanApproved' },
      { re: /export\s+function\s+updateMessageToolCall\b/, label: 'updateMessageToolCall' },
      { re: /export\s+function\s+updateMessageThinking\b/, label: 'updateMessageThinking' },
      { re: /export\s+function\s+createSession\b/, label: 'createSession' },
      { re: /export\s+function\s+archiveSession\b/, label: 'archiveSession' },
      { re: /export\s+function\s+setScheduledTasks\b/, label: 'setScheduledTasks' },
      { re: /export\s+function\s+syncTelemetryData\b/, label: 'syncTelemetryData' },
      // 跨域写须经 getLayoutState，避免散落 useLayoutStore.getState()
      {
        re: /getLayoutState\(\)\.(?:pushDiffFile|setActiveDiffSource|syncTelemetryData|setAppSettings|setScheduledTasks|addCommandPermission)\b/,
        label: 'cross-domain writes via getLayoutState()',
      },
      { re: /from\s+['\"]\.\.\/store\/sessionStore['\"]/, label: 'import sessionStore facade' },
      { re: /from\s+['\"]\.\.\/store\/workspaceStore['\"]/, label: 'import workspaceStore facade' },
      { re: /from\s+['\"]\.\.\/store\/settingsUiStore['\"]/, label: 'import settingsUiStore facade' },
    ];
    for (const { re, label } of accessRequired) {
      if (!re.test(src)) {
        fail(`${accessRel} missing required pattern: ${label}`);
      }
    }
    // 禁止 storeAccess 内再散落 useLayoutStore.getState()（跨域以外）
    // 允许 getLayoutState 内部那一次；注释不计。
    let getStateHits = 0;
    for (const line of src.split(/\r?\n/)) {
      if (isCommentOnlyLine(line)) continue;
      if (/useLayoutStore\.getState\s*\(/.test(codePart(line))) getStateHits += 1;
    }
    if (getStateHits > 1) {
      fail(
        `${accessRel}: expected at most 1 useLayoutStore.getState() (inside getLayoutState); found ${getStateHits}`,
      );
    }
    if (getStateHits < 1) {
      fail(`${accessRel}: expected 1 useLayoutStore.getState() inside getLayoutState; found 0`);
    }
    // 禁止 import 组件层（编排层只依赖 store）
    if (/from\s+['\"]\.\.\/components\//.test(src) || /from\s+['\"]\.\/components\//.test(src)) {
      fail(`${accessRel}: must not import from components/`);
    }
    // storeAccess 自身禁止 as unknown as（跨域编排应已类型化）
    const accessUnknown = countInCode(src, /as\s+unknown\s+as\b/);
    if (accessUnknown > 0) {
      fail(`${accessRel}: forbidden \`as unknown as\` (found ${accessUnknown})`);
    }
  }
}

if (failed) {
  console.error(
    '[check-no-as-any-store] FAIL: use generic SessionStoreSlice / WorkspaceStoreSlice wiring; no `as any` / `: any` / @ts-ignore in store/ + storeAccess; keep sessionsById helpers + typed telemetry + facade alignment + anti-cycle + barrel.',
  );
  process.exit(1);
}

console.log(
  `[check-no-as-any-store] OK — scanned ${files.length} store files + storeAccess; no as-any / :any / @ts-ignore; sessionIndex + layout + actions + facade + barrel + storeAccess + anti-cycle checks passed`,
);
