# CI/CD æµæ°´çº¿ç°çŠ¶åˆ†æä¸å·®è·è¯†åˆ«

## 1 æ‰§è¡Œæ‘˜è¦

æœ¬æ–‡ä»¶å¯¹ conex é¡¹ç›®å½“å‰çš„ CI/CD æµæ°´çº¿è¿›è¡Œç³»ç»Ÿæ€§è¯„ä¼°ï¼Œè¯†åˆ«ä»æ„å»ºã€æµ‹è¯•ã€è´¨é‡é—¨ç¦åˆ°å‘å¸ƒäº¤ä»˜å…¨é“¾è·¯çš„ç°çŠ¶ä¸ç†æƒ³çŠ¶æ€ä¹‹é—´çš„å·®è·ã€‚åˆ†æåŸºäºå¯¹é¡¹ç›®æ ¹ç›®å½• `package.json`ã€`turbo.json`ã€`tsconfig.base.json`ã€`vitest.config.ts`ã€`eslint.config.js`ã€`.lintstagedrc.json`ã€`.husky/pre-commit`ã€`.husky/pre-push`ã€å…¨éƒ¨ 10 ä¸ªå·¥ä½œç©ºé—´å­åŒ… `package.json`ã€Rust å·¥ä½œç©ºé—´ `Cargo.toml`ï¼ˆå« 12 ä¸ª crateï¼‰ã€ä»¥åŠ `.github/workflows/` ä¸‹ç°æœ‰ 4 ä¸ª workflow æ–‡ä»¶çš„æ·±åº¦ä»£ç å®¡æŸ¥ã€‚

**æ ¸å¿ƒç»“è®º**ï¼šé¡¹ç›®å·²æœ‰åˆæ­¥çš„ CI åŸºç¡€è®¾æ–½ï¼ˆ4 ä¸ª workflowï¼‰ï¼Œä½†å­˜åœ¨ 7 å¤§ç±»ç³»ç»Ÿæ€§ç¼ºé™·â€”â€”ç¢ç‰‡åŒ–æ‰§è¡Œï¼ˆä»…è¦†ç›– 40% çš„åŒ…ï¼‰ã€æ— çŸ©é˜µæµ‹è¯•ã€æ— è·¨å¹³å°æ„å»ºï¼ˆTS éƒ¨åˆ†ä»… linuxï¼‰ã€æ— å‘å¸ƒæµæ°´çº¿ï¼ˆnpm publish å®Œå…¨ç¼ºå¤±ï¼‰ã€æ— è´¨é‡é—¨ç¦ç¡¬æ€§é˜ˆå€¼ã€æ— å®‰å…¨å®¡è®¡è‡ªåŠ¨åŒ–è°ƒåº¦ã€æ— ç›‘æ§ä¸åº¦é‡åé¦ˆã€‚ä¸€ä¸ª `pre-push` hook æ‰§è¡Œ `npm run typecheck && npm test`ï¼Œä½†ç”±äº TypeScript check åªè¦†ç›– `crish-desktop` çš„ tsconfigï¼Œè€Œ `npm test` è¿è¡Œå…¨éƒ¨ vitest å¥—ä»¶ï¼ˆå« e2eï¼‰ï¼Œå¼€å‘è€…ä½“éªŒè„†å¼±ä¸”ä¸å¯é ã€‚

## 2 å½“å‰ CI/CD çŠ¶æ€è¯„ä¼°

### 2.1 æ„å»ºæµç¨‹ç°çŠ¶

**è¯„åˆ†ï¼š2/10**

å½“å‰æ„å»ºå®Œå…¨ä¾èµ–æœ¬åœ°æ‰‹åŠ¨æ‰§è¡Œæˆ– `pre-push` hook çš„éšå¼è§¦å‘ã€‚æ ¹ `package.json`ï¼ˆ`package.json:17-67`ï¼‰å®šä¹‰äº†åˆ†å±‚æ„å»ºè„šæœ¬ï¼š

```
build:shared-types â†’ build:packages â†’ build:runtime â†’ build:orchestrator â†’ build:daemon â†’ build:product
```

æ¯ä¸ªå­åŒ…çš„æ„å»ºç”± `clean` â†’ `build:types`ï¼ˆtsc --emitDeclarationOnly + tsc-aliasï¼‰ â†’ `build:js`ï¼ˆesbuildï¼‰ä¸‰æ­¥ç»„æˆï¼Œè§ `packages/agent-daemon/package.json:25-28`ã€`packages/shared-types/package.json:25-28` ç­‰ã€‚

ç°æœ‰ `.github/workflows/ci.yml` çš„ `ts-check` job åªå¯¹ `packages/agent-runtime` æ‰§è¡Œäº† `npx tsc --noEmit`ï¼ˆ`ci.yml:79`ï¼‰ï¼Œå®Œå…¨å¿½ç•¥äº†ï¼š
- `@crish/shared-types` â€” ç±»å‹å®šä¹‰çš„åŸºç¡€
- `@crish/shared-utils` â€” å·¥å…·å‡½æ•°åº“ï¼ˆå« browser/node åŒå…¥å£ï¼‰
- `@crish/decision-engine` â€” å†³ç­–å¼•æ“
- `@crish/agent-orchestrator` â€” ç¼–æ’å™¨
- `@crish/agent-daemon` â€” å®ˆæŠ¤è¿›ç¨‹
- `@crish/agent-workbench` â€” å·¥ä½œå° CLI
- `@crish/crish-desktop` â€” æ¡Œé¢åº”ç”¨

`turbo.json`ï¼ˆ`turbo.json:3-30`ï¼‰å®šä¹‰äº† `pipeline` åŒ…å« `build`ã€`build:types`ã€`build:js`ã€`test`ã€`lint`ã€`typecheck`ã€`clean` ä¸ƒä¸ªä»»åŠ¡ï¼Œä½† CI ä¸­**å®Œå…¨æ²¡æœ‰ä½¿ç”¨ turbo**ã€‚`ci.yml` ä¸­ç›´æ¥è°ƒç”¨ `npx tsc --noEmit` å’Œ `npx vitest run`ï¼Œç»•è¿‡äº† turbo çš„ä¾èµ–å›¾ç¼“å­˜å’Œå¢é‡æ„å»ºèƒ½åŠ›ã€‚

Rust éƒ¨åˆ†çŠ¶å†µè¾ƒå¥½ï¼š`ci.yml` çš„ `rust-check` jobï¼ˆ`ci.yml:13-42`ï¼‰åœ¨ ubuntu/windows/macos ä¸‰å¹³å°æ‰§è¡Œ `cargo check`ã€`cargo clippy`ã€`cargo test`ã€`cargo fmt`ï¼Œä½¿ç”¨äº† `Swatinem/rust-cache@v2`ã€‚ä½† `cargo test --workspace` ä¸åŒ…å« `crates/conex-stream` çš„ `--all-features` æµ‹è¯•ï¼ˆè¯¥ crate æœ‰ç‹¬ç«‹çš„ `rust-stream-test` jobï¼‰ã€‚

### 2.2 æµ‹è¯•æ‰§è¡Œç°çŠ¶

**è¯„åˆ†ï¼š4/10**

æ ¹ `package.json` å®šä¹‰äº†å¤šæ¡æµ‹è¯•å‘½ä»¤ï¼ˆ`package.json:57-61`ï¼‰ï¼š
- `test:core` â€” è¿è¡Œ runtime/orchestrator/daemon æµ‹è¯•
- `test:desktop-helpers` â€” è¿è¡Œ desktop API/store æµ‹è¯•
- `test` â€” è¿è¡Œå…¨éƒ¨ vitest æµ‹è¯•
- `test:coverage` â€” å¸¦è¦†ç›–ç‡è¿è¡Œ
- `test:integration` â€” ä½¿ç”¨ç‹¬ç«‹é›†æˆæµ‹è¯•é…ç½®

`vitest.config.ts`ï¼ˆ`vitest.config.ts:1-18`ï¼‰çš„ include æ¨¡å¼è¦†ç›–äº† `packages/**` å’Œ `apps/**` ç›®å½•ä¸‹çš„ `*.test.ts` æ–‡ä»¶ã€‚

`apps/crish-desktop/vitest.config.ts`ï¼ˆ`apps/crish-desktop/vitest.config.ts:1-28`ï¼‰ç‹¬ç«‹é…ç½®äº† jsdom ç¯å¢ƒã€React æ’ä»¶å’Œè¦†ç›–ç‡é˜ˆå€¼ã€‚

ç°æœ‰ CI æµ‹è¯•è¦†ç›–ï¼š
- `ci.yml:81-82` â€” Provider æµ‹è¯• `npx vitest run packages/agent-runtime/src/provider/__tests__/`
- `ci.yml:84-85` â€” Model catalog æµ‹è¯•ï¼ˆ`2>/dev/null || true`ï¼Œé™é»˜åå™¬å¤±è´¥ï¼‰
- `ci.yml:87-88` â€” Fallback chain æµ‹è¯•ï¼ˆ`2>/dev/null || true`ï¼Œé™é»˜åå™¬å¤±è´¥ï¼‰
- `ci.yml:161-162` â€” Provider è¦†ç›–ç‡æµ‹è¯•
- `ci.yml:180-181` â€” E2E æµ‹è¯•ï¼ˆprovider e2eï¼‰
- `ci.yml:209` â€” Provider lifecycle åŸºå‡†æµ‹è¯•

**ä¸¥é‡é—®é¢˜**ï¼š
1. æµ‹è¯•è¦†ç›–ä¸¥é‡ç¢ç‰‡åŒ–â€”â€”åªæ‰§è¡Œ agent-runtime çš„ provider å­ç›®å½•æµ‹è¯•
2. ä¸¤ä¸ª test suite ä½¿ç”¨ `|| true` æ¨¡å¼é™é»˜åå™¬å¤±è´¥ï¼ˆ`ci.yml:85,88`ï¼‰
3. æ—  `test:core`ã€`test:desktop-helpers`ã€`test:integration` çš„ CI æ‰§è¡Œ
4. æ— ä»»ä½• Rust crate çš„åŸºå‡†æµ‹è¯•ç»“æœæ–­è¨€
5. æ— æµ‹è¯•è€—æ—¶åŸºçº¿ç›‘æ§
6. æ¡Œé¢åº”ç”¨çš„ Playwright è§†è§‰æµ‹è¯•ï¼ˆ`apps/crish-desktop/package.json:16-17`ï¼‰åœ¨ CI ä¸­å®Œå…¨æœªæ‰§è¡Œ
7. `apps/crish-desktop/package.json:13` å®šä¹‰çš„ `qa:check` è„šæœ¬åŒ…å« hook safetyã€chat invariantsã€stress fuzzingã€full scenario flow å››é¡¹å…³é”®è´¨é‡æ£€æŸ¥ï¼Œä½† CI ä¸­å®Œå…¨æ²¡æœ‰è§¦å‘

### 2.3 ä»£ç è´¨é‡é—¨ç¦ç°çŠ¶

**è¯„åˆ†ï¼š3/10**

å½“å‰è´¨é‡é—¨ç¦åˆ†å¸ƒåœ¨ä¸‰ä¸ªå±‚é¢ï¼š

**æœ¬åœ°ï¼ˆgit hooksï¼‰**ï¼š
- `.husky/pre-commit`ï¼š`npx lint-staged` â€” å¯¹ staged æ–‡ä»¶æ‰§è¡Œ eslint --fix + prettier --write
- `.husky/pre-push`ï¼š`npm run typecheck && npm test`

`.lintstagedrc.json`ï¼ˆ`.lintstagedrc.json:1-5`ï¼‰å®šä¹‰äº†ï¼š
- `*.{ts,tsx}` â†’ eslint --fix + prettier --write
- `*.css` â†’ stylelint --fix + prettier --write
- `*.{json,md}` â†’ prettier --write

**CI å±‚é¢**ï¼š
- `ci.yml:136-148` â€” ESLint jobï¼Œä½†åªå¯¹ `packages/agent-runtime/src/provider/` æ‰§è¡Œï¼Œä¸” `2>/dev/null || echo "ESLint check skipped"`â€”â€”é™é»˜è·³è¿‡é”™è¯¯
- `ci.yml:163-167` â€” Coverage jobï¼Œä½†åªæœ‰ `Write-Host "Coverage check completed"`ï¼Œ**æœªå®é™…éªŒè¯è¦†ç›–ç‡é˜ˆå€¼**
- `ci.yml:117-134` â€” Security audit jobï¼Œä½¿ç”¨ `continue-on-error: true`ï¼Œnpm audit å’Œ cargo audit çš„å¤±è´¥**ä¸ä¼šé˜»æ–­æµæ°´çº¿**
- `ci.yml:90-114` â€” provider-json-validate jobï¼Œæ ¼å¼éªŒè¯

**å…³é”®ç¼ºå¤±**ï¼š
1. è¦†ç›–ç‡é˜ˆå€¼**å·²å®šä¹‰**ï¼ˆ`apps/crish-desktop/vitest.config.ts:13-18`ï¼šstatements 70%, branches 60%, functions 65%, lines 70%ï¼‰ï¼Œä½† CI ä»æœªéªŒè¯
2. `npm run lint:all` å®šä¹‰äº† `--max-warnings 0` ä¸¥æ ¼æ¨¡å¼ï¼ˆ`package.json:62`ï¼‰ï¼Œä½† CI åªç”¨å®½æ¾çš„ `eslint .`ï¼ˆ`package.json:64`ï¼‰
3. `npm run check:all`ï¼ˆ`package.json:65`ï¼štypecheck + lint:all + test:coverageï¼‰æ˜¯å®Œæ•´è´¨é‡é—¨ç¦ï¼Œä½† CI ä»æœªè°ƒç”¨
4. `npm run format`ï¼ˆprettier --checkï¼‰åœ¨ CI ä¸­å®Œå…¨æœªæ‰§è¡Œ
5. æ ¹ `eslint.config.js` çš„ ignores åˆ—è¡¨ï¼ˆ`eslint.config.js:9-21`ï¼‰æ’é™¤äº† 11 ç§ç›®å½•æ¨¡å¼ï¼Œä½† CI ä¸­ eslint æ‰§è¡ŒèŒƒå›´è¿‡çª„ä¸”é™é»˜åé”™

### 2.4 å‘å¸ƒæµç¨‹ç°çŠ¶

**è¯„åˆ†ï¼š1/10**

`.github/workflows/release.yml` æ˜¯å”¯ä¸€çš„å‘å¸ƒæµæ°´çº¿ï¼Œè§¦å‘æ¡ä»¶ä¸º `v*` æ ‡ç­¾æ¨é€ã€‚å®ƒï¼š
- åœ¨ä¸‰å¹³å°æ„å»º Tauri æ¡Œé¢åº”ç”¨ï¼ˆ`release.yml:13-45`ï¼‰
- ä½¿ç”¨ `softprops/action-gh-release@v2` åˆ›å»º GitHub Releaseï¼ˆè‰ç¨¿æ¨¡å¼ï¼‰ï¼ˆ`release.yml:58-67`ï¼‰
- ä¸Šä¼  `.msi`ã€`.dmg`ã€`.AppImage`ã€`.deb` å®‰è£…åŒ…

**å®Œå…¨ç¼ºå¤±**ï¼š
1. **npm å‘å¸ƒ**â€”â€”æ²¡æœ‰ä»»ä½•ç”¨äº `@crish/*` åŒ…ï¼ˆshared-types, shared-utils, agent-runtime, agent-orchestrator, agent-daemon, decision-engineï¼‰çš„ npm publish pipeline
2. **daemon äºŒè¿›åˆ¶åˆ†å‘**â€”â€”æ ¹ `package.json:29` å®šä¹‰äº† `build:daemon-binary`ï¼ˆ`node scripts/bundle-daemon.mjs`ï¼‰ï¼Œä½† release.yml æœªå°†å…¶çº³å…¥å‘å¸ƒ
3. **ç‰ˆæœ¬ç®¡ç†è‡ªåŠ¨åŒ–**â€”â€”æ—  `changeset`ã€æ—  `standard-version`ã€æ— çº¿ä¸‹ç‰ˆæœ¬ bump è„šæœ¬
4. **Changelog ç”Ÿæˆ**â€”â€”æ— ä»»ä½•åŒ…æœ‰ CHANGELOG.mdï¼Œä¹Ÿæ— è‡ªåŠ¨ç”Ÿæˆæœºåˆ¶
5. **å‘å¸ƒå‰è´¨é‡éªŒè¯**â€”â€”release.yml çš„ build job åªæ‰§è¡Œ `build:packages` + Tauri buildï¼Œæœªè¿è¡Œå®Œæ•´ `check:all`
6. **Docker é•œåƒ**â€”â€”é¡¹ç›®æ”¯æŒ Tauri æ¡Œé¢ + daemon ä¸¤ç§äº¤ä»˜å½¢æ€ï¼Œä½†æ—  Docker é•œåƒæ„å»º/å‘å¸ƒ
7. **Nightly å‘å¸ƒé€šé“**â€”â€”æ—  nightly/next é¢„è§ˆå‘å¸ƒèƒ½åŠ›

### 2.5 å…¶ä»–é—®é¢˜

**å¹¶å‘æ§åˆ¶**ï¼šåªæœ‰ `release.yml` å®šä¹‰äº† `concurrency` ç»„ï¼ˆ`release.yml:8-10`ï¼‰ï¼Œ`ci.yml` å’Œ `perf-test.yml` å‡æ— å¹¶å‘æ§åˆ¶ï¼Œå¯èƒ½å¯¼è‡´åŒä¸€ PR çš„å¤šæ¬¡æ¨é€äº§ç”Ÿå†—ä½™æ‰§è¡Œã€‚

**ä¾èµ–æ›´æ–°**ï¼š`.github/dependabot.yml` å·²é…ç½® npm å’Œ cargo çš„æ¯å‘¨æ›´æ–°ï¼Œnpm é™åˆ¶ 10 ä¸ªå¹¶å‘ PRã€cargo é™åˆ¶ 5 ä¸ªã€‚ä½† cargo é…ç½® `ignore` äº† `conex-stream`ï¼ˆ`dependabot.yml:25`ï¼‰ï¼Œç¼ºå°‘åŸå› è¯´æ˜ã€‚

**å¯†é’¥æ‰«æ**ï¼šæ— ä»»ä½• secrets æ‰«æå·¥ä½œæµã€‚

**Workflow æƒé™**ï¼š`ci.yml` å„ job æœªæ˜¾å¼å£°æ˜ `permissions`ï¼Œä½¿ç”¨é»˜è®¤çš„ GITHUB_TOKEN æƒé™ï¼ˆè¯»å†™å…¨éƒ¨ï¼‰ï¼Œè¿åæœ€å°æƒé™åŸåˆ™ã€‚

## 3 å·®è·æ·±åº¦åˆ†æ

### 3.1 æ„å»ºå·®è·

| å·®è·é¡¹ | ç°çŠ¶ | ç†æƒ³çŠ¶æ€ | å½±å“ |
|--------|------|----------|------|
| **å¤šå¹³å°æ„å»º** | Rust ä¸‰å¹³å° OKï¼›TS åŒ…ä»… linux | æ‰€æœ‰ TS åŒ…åº”åœ¨ linux/windows/macos æ„å»º | è·¨å¹³å°å…¼å®¹æ€§ä¸å¯è§ï¼ŒWindows ç”¨æˆ·å¯èƒ½é‡åˆ° esbuild/target å·®å¼‚ |
| **æ„å»ºç¼“å­˜** | Rust ä½¿ç”¨ Swatinem/rust-cacheï¼›TS æ— ç¼“å­˜ | TS åº”åˆ©ç”¨ turbo cache + actions/cache | é‡å¤æ„å»ºè€—æ—¶ï¼Œ`build:packages` çº¦éœ€ 2-3 åˆ†é’Ÿ |
| **å¢é‡æ„å»º** | æœªä½¿ç”¨ turbo çš„ `--filter` å’Œ `--since` | PR çº§åˆ«å¢é‡æ„å»º -> ä»…æ„å»ºå˜æ›´åŒ…åŠå…¶ä¾èµ– | å…¨é‡æ„å»ºæµªè´¹ CI æ—¶é—´ |
| **äº§ç‰©ç®¡ç†** | ä»… release.yml ä¸Šä¼  Tauri bundle | æ¯æ¬¡ CI åº”ä¸Šä¼  dist/ ä½œä¸º artifact | æ— æ³•åœ¨é CI ç¯å¢ƒå¤ç°/å®¡æŸ¥æ„å»ºäº§ç‰© |
| **Rust äº¤å‰ç¼–è¯‘** | æ—  | åº”ä¸º aarch64-linux, aarch64-macos ç­‰ç›®æ ‡äº¤å‰ç¼–è¯‘ | éƒ¨åˆ† crateï¼ˆconex-db å« sqlite nativeï¼‰éœ€è¦å¤šæ¶æ„æ”¯æŒ |
| **esbuild é…ç½®ä¸€è‡´æ€§** | å„åŒ…ç‹¬ç«‹ç»´æŠ¤ build:js å‘½ä»¤ | ç»Ÿä¸€ esbuild é…ç½®ï¼Œé€šè¿‡ turbo ç¼–æ’ | `packages/agent-daemon/package.json:27` çš„ esbuild å‘½ä»¤ä¸ `packages/shared-utils/package.json:47-49` çš„é…ç½®ä¸å®Œå…¨ä¸€è‡´ |
| **TS ç¼–è¯‘äº§ç‰©** | æ¯ä¸ªåŒ…è¿è¡Œ tsc --emitDeclarationOnly | å•æ¬¡ tsc -b é¡¹ç›®å¼•ç”¨æ¨¡å¼ | 7 ä¸ªåŒ…å„è·‘ç‹¬ç«‹ tscï¼Œé‡å¤è§£æ node_modules |

`turbo.json` å®šä¹‰äº† `outputs: ["dist/**", ".tsbuildinfo"]`ï¼ˆ`turbo.json:6`ï¼‰ï¼Œä½† CI ä¸­ä»æœªåˆ©ç”¨è¿™ä¸ªç¼“å­˜å£°æ˜ã€‚å¦‚æœèƒ½é€šè¿‡ turbo remote cachingï¼ˆå¦‚ `turbo-cloud` æˆ– `turbo-server`ï¼‰å…±äº«ç¼“å­˜ï¼Œ`build:packages` çš„è€—æ—¶å¯ä»¥ä» ~150s é™è‡³ ~10sï¼ˆç¼“å­˜å‘½ä¸­æ—¶ï¼‰ã€‚

### 3.2 æµ‹è¯•å·®è·

| å·®è·é¡¹ | ç°çŠ¶ | ç†æƒ³çŠ¶æ€ | å½±å“ |
|--------|------|----------|------|
| **çŸ©é˜µæµ‹è¯•** | æ—  Node ç‰ˆæœ¬çŸ©é˜µ | Node 20/22/23, æ¯ OS | ä¸åŒ Node ç‰ˆæœ¬çš„ ESM/TS è¡Œä¸ºå·®å¼‚ä¸å¯è§ |
| **æ“ä½œç³»ç»ŸçŸ©é˜µ** | TS ä»… linux | linux/windows/macos | windows ä¸Š vitest çš„ jsdom è¡Œä¸ºå·®å¼‚ï¼ˆ`vitest.config.ts` å·²é…ç½® jsdomï¼‰ä¸å¯è§ |
| **Rust æµ‹è¯•è¦†ç›–** | `cargo test --workspace` + `cargo test --all-features` åˆ†ç¦» | ç»Ÿä¸€ `cargo test --workspace --all-features` | `ci.yml` ä¸­ `rust-check` å’Œ `rust-stream-test` åˆ†ç¦»ï¼Œå†—ä½™ |
| **é›†æˆæµ‹è¯•** | `test:integration` å­˜åœ¨ä½† CI ä¸æ‰§è¡Œ | CI åº”è¿è¡Œå®Œæ•´çš„ `test:integration` | è·¨åŒ…é›†æˆé—®é¢˜é—æ¼ |
| **E2E æµ‹è¯•** | ä»… provider e2eï¼ˆ`ci.yml:180-181`ï¼‰ | åº”åŒ…å«ç«¯åˆ°ç«¯ daemonâ†’runtimeâ†’orchestrator æµç¨‹ | æ¶æ„å±‚é—´å¥‘çº¦æ–­è£‚ä¸å¯è§ |
| **è§†è§‰æµ‹è¯•** | Playwright æµ‹è¯•å·²é…ç½®ï¼ˆ`apps/crish-desktop/package.json:16-17`ï¼‰ | CI åº”æ‰§è¡Œ `test:visual` | UI å›å½’ä¸å¯è§ |
| **åŸºå‡†æµ‹è¯•æ–­è¨€** | `ci.yml:191` ä½¿ç”¨ `|| true` é™é»˜åç»“æœ | åº”æœ‰æ€§èƒ½é€€åŒ–é˜ˆå€¼æ–­è¨€ | æ€§èƒ½é€€åŒ–ä¸è¢«é˜»æ–­ |
| **æµ‹è¯•æŠ¥å‘Š** | vitest è¾“å‡ºåˆ° stdout | åº”ç”Ÿæˆ JUnit XML + HTML æŠ¥å‘Šå¹¶å½’æ¡£ | æ— æ³•è¿½æº¯å†å²æµ‹è¯•ç»“æœ |
| **æµ‹è¯•è€—æ—¶ç›‘æ§** | æ—  | è®°å½•æ¯æ¬¡ CI çš„æµ‹è¯•è€—æ—¶ï¼Œå»ºç«‹åŸºçº¿ | æµ‹è¯•è†¨èƒ€ä¸è¢«æ„ŸçŸ¥ |

`vitest.config.ts:8` çš„ include æ¨¡å¼åŒ…å« `apps/**` ä¸‹çš„æµ‹è¯•ï¼Œä¸” `vitest.setup.ts`ï¼ˆ`vitest.setup.ts:1-44`ï¼‰ä¸º Node ç¯å¢ƒè¡¥å……äº† localStorageã€dispatchEventã€CustomEvent ç­‰ browser å…¨å±€å˜é‡ï¼Œè¯´æ˜ vitest å¯ç”¨äºè¿è¡Œéƒ¨åˆ†å‰ç«¯é€»è¾‘æµ‹è¯•ã€‚ä½† CI ä¸­ `npx vitest run packages/agent-runtime/src/provider/__tests__/` åªä¼ å…¥äº†ä¸€ä¸ªå­ç›®å½•ï¼Œå¿½ç•¥äº†å…¶ä»–æ‰€æœ‰æµ‹è¯•ã€‚

### 3.3 è´¨é‡é—¨ç¦å·®è·

| å·®è·é¡¹ | ç°çŠ¶ | ç†æƒ³çŠ¶æ€ | å½±å“ |
|--------|------|----------|------|
| **è¦†ç›–ç‡é˜ˆå€¼å¼ºåˆ¶** | å®šä¹‰ï¼ˆ`apps/crish-desktop/vitest.config.ts:13-18`ï¼‰ä½†ä¸éªŒè¯ | CI ç¡¬æ€§é˜»æ–­ä½äºé˜ˆå€¼çš„æäº¤ | ä»£ç è¦†ç›–ç‡æŒç»­ä¸‹é™ä¸å¯æ§ |
| **lint ä¸¥æ ¼æ¨¡å¼** | `package.json:64` çš„ `lint` æ—  `--max-warnings` | ä½¿ç”¨ `lint:all`ï¼ˆ`--max-warnings 0` + stylelintï¼‰ | æ–° warning æŒç»­å¼•å…¥ä¸è¢«æ³¨æ„ |
| **TypeScript ä¸¥æ ¼æ¨¡å¼** | `tsconfig.base.json:8-23` å·²å¯ç”¨ `strict`ã€`noUncheckedIndexedAccess`ã€`exactOptionalPropertyTypes` | CI åº”å¯¹æ‰€æœ‰åŒ…è¿è¡Œ `tsc --noEmit` | ç±»å‹å®‰å…¨é—¨ç¦ä»…è¦†ç›– crish-desktop |
| **æ ¼å¼åŒ–æ ¡éªŒ** | `npm run format`ï¼ˆprettier --checkï¼‰å­˜åœ¨ä½†ä¸æ‰§è¡Œ | CI åº”è¿è¡Œ prettier --check | ä»£ç é£æ ¼ä¸ä¸€è‡´æŒç»­å¼•å…¥ |
| **ä¾èµ–åˆè§„** | `dependency-cruiser` åœ¨ devDependenciesï¼ˆ`package.json:73`ï¼‰ä½†æœªåœ¨ CI ä¸­ä½¿ç”¨ | è¿è¡Œ depcruise æ£€æŸ¥å¾ªç¯ä¾èµ–å’Œå±‚çº§è¿è§„ | æ¶æ„è€¦åˆï¼ˆç°æœ‰ 105 ä¸ªæ¶æ„è€¦åˆé—®é¢˜ï¼‰æŒç»­æ¶åŒ– |
| **Store ç±»å‹å®‰å…¨** | `check:store-types` è„šæœ¬ï¼ˆ`package.json:56`ï¼‰å­˜åœ¨ | CI æ‰§è¡Œ store ç±»å‹å®‰å…¨æ£€æŸ¥ | store ä¸­çš„ `as any` æ¨¡å¼ä¸è¢«å‘ç° |
| **API å¥‘çº¦éªŒè¯** | æ—  | OpenAPI/Swagger æˆ– tRPC çº§åˆ«çš„ API schema éªŒè¯ | IPC è¾¹ç•Œè„†å¼±æ€§ï¼ˆç°æœ‰ 15 ä¸ª IPC é—®é¢˜ï¼‰æŒç»­å­˜åœ¨ |
| **æ­»ä»£ç æ£€æµ‹** | æ—  | tsc çš„ `noUnusedLocals` å’Œ `noUnusedParameters`ï¼ˆ`tsconfig.base.json:18-19`ï¼‰å½“å‰è¢«å…³é—­ | æ­»ä»£ç ç§¯ç´¯ |
| **CSS è´¨é‡** | `lint:css` ä½¿ç”¨ stylelintï¼ˆ`package.json:63`ï¼‰ | CI åº”æ‰§è¡Œ CSS lint | CSS è´¨é‡é—®é¢˜ä¸è¢«å‘ç° |

### 3.4 å®‰å…¨å·®è·

| å·®è·é¡¹ | ç°çŠ¶ | ç†æƒ³çŠ¶æ€ | å½±å“ |
|--------|------|----------|------|
| **ä¾èµ–å®¡è®¡ï¼ˆnpmï¼‰** | `ci.yml:132-134` ä½¿ç”¨ `continue-on-error: true` | ä¸¥é‡/é«˜å±æ¼æ´åº”é˜»æ–­æµæ°´çº¿ | å·²çŸ¥æ¼æ´å¯ä»¥æµå…¥ç”Ÿäº§ |
| **ä¾èµ–å®¡è®¡ï¼ˆcargoï¼‰** | `ci.yml:122-123` ä½¿ç”¨ `continue-on-error: true` | cargo audit å¤±è´¥åº”é˜»æ–­æµæ°´çº¿ | Rust crate æ¼æ´å¯æµå…¥ |
| **å¯†é’¥æ‰«æ** | æ—  | CI åº”æ‰«ææäº¤å†å²ä¸­çš„ç¡¬ç¼–ç å¯†é’¥ | å¯†é’¥æ³„éœ²é£é™© |
| **CSP éªŒè¯** | æ—  | è¿è¡Œæ—¶ Content-Security-Policy éªŒè¯ | XSS æ”»å‡»é¢ä¸å¯æ§ |
| **SBOM ç”Ÿæˆ** | æ—  | æ¯æ¬¡å‘å¸ƒç”Ÿæˆ CycloneDX/Syft SBOM | ä¾›åº”é“¾å®‰å…¨åˆè§„ç¼ºå¤± |
| **npm ç­¾åéªŒè¯** | `npm audit signatures` æœªæ‰§è¡Œ | éªŒè¯ registry ç­¾åå®Œæ•´æ€§ | è¯ä¹¦åŠ«æŒé£é™© |
| **Docker é•œåƒæ‰«æ** | æ—  | å®¹å™¨é•œåƒå±‚æ¼æ´æ‰«æ | è¿è¡Œæ—¶å®‰å…¨é£é™© |

`eslint.config.js:9-21` çš„ ignores åˆ—è¡¨æ’é™¤äº† `.agent-runtime/`ã€`.agents/`ã€`.claude/`ã€`.codex/`ã€`.firecrawl/`ã€`.trae/` ç­‰ç›®å½•ï¼Œè¿™äº›æ˜¯ AI Agent çš„å·¥ä½œç›®å½•ï¼Œå¯èƒ½åŒ…å« API å¯†é’¥å’Œç”¨æˆ·æ•°æ®ã€‚CI ä¸åº”æ‰«æè¿™äº›ç›®å½•ï¼Œä½†ç”Ÿæˆç‰©ç®¡ç†éœ€è¦ç¡®ä¿è¿™äº›ç›®å½•ä¸è¢«æ„å¤–æ‰“åŒ…ã€‚

### 3.5 å‘å¸ƒå·®è·

| å·®è·é¡¹ | ç°çŠ¶ | ç†æƒ³çŠ¶æ€ | å½±å“ |
|--------|------|----------|------|
| **npm åŒ…å‘å¸ƒ** | æ—  | `@crish/shared-types`, `@crish/shared-utils`, `@crish/agent-runtime`, `@crish/agent-orchestrator`, `@crish/agent-daemon`, `@crish/decision-engine` åº”å‘å¸ƒåˆ° npm | æ— æ³•è¢«å¤–éƒ¨é¡¹ç›®ä½œä¸ºä¾èµ–ä½¿ç”¨ |
| **ç‰ˆæœ¬ç®¡ç†** | æ‰€æœ‰åŒ…ç¡¬ç¼–ç  `0.1.0`ï¼ˆå„ `package.json` çš„ version å­—æ®µï¼‰ | ç»Ÿä¸€ç‰ˆæœ¬ç®¡ç†ï¼ˆchangesets æˆ– workspace versionï¼‰ | æ‰‹åŠ¨ä¿®æ”¹ç‰ˆæœ¬å·å®¹æ˜“å‡ºé”™ |
| **Changelog** | æ— ä»»ä½• CHANGELOG.md | æ¯ä¸ªåŒ…åº”æœ‰è‡ªåŠ¨ç”Ÿæˆçš„ CHANGELOG | æ— æ³•è¿½è¸ªç‰ˆæœ¬é—´å˜æ›´ |
| **GitHub Release ä¿¡æ¯** | `release.yml:61` ä½¿ç”¨ `generate_release_notes: true`ï¼ˆè‡ªåŠ¨ç”Ÿæˆï¼‰ | åº”ä½¿ç”¨ç»“æ„åŒ–çš„ CHANGELOG å†…å®¹ + ä» git log ç”Ÿæˆçš„ release notes | Release notes ä¿¡æ¯é‡ä¸è¶³ |
| **daemon äºŒè¿›åˆ¶** | `scripts/bundle-daemon.mjs` å­˜åœ¨ | release.yml åº”æ„å»ºå¹¶ä¸Šä¼  daemon binary | daemon ä¸èƒ½ç‹¬ç«‹äº Tauri æ¡Œé¢åˆ†ç™¼ |
| **Docker é•œåƒ** | æ—  Dockerfile | æ„å»ºå¹¶å‘å¸ƒ daemon + Tauri çš„ Docker é•œåƒ | æ— æ³•åœ¨æœåŠ¡å™¨ç¯å¢ƒéƒ¨ç½² |
| **å‘å¸ƒå‰å¹²è¿è¡Œ** | æ—  | CI åº”æ”¯æŒå‘å¸ƒå‰å…¨éƒ¨ä»¶æ„å»ºéªŒè¯ | å‘å¸ƒæµç¨‹ä¸å¯é¢„æµ‹ |
| **å›æ»šæœºåˆ¶** | æ—  | æ”¯æŒ npm dist-tag å›æ»šã€GitHub Release æ’¤é”€ | é”™è¯¯å‘å¸ƒä¸å¯æ¢å¤ |

### 3.6 ç›‘æ§å·®è·

| å·®è·é¡¹ | ç°çŠ¶ | ç†æƒ³çŠ¶æ€ | å½±å“ |
|--------|------|----------|------|
| **æ„å»ºæ—¶é—´è¶‹åŠ¿** | æ—  | è®°å½•æ¯æ¬¡ CI æ„å»ºæ€»è€—æ—¶ã€å„é˜¶æ®µè€—æ—¶ | æ„å»ºè†¨èƒ€ä¸å¯è§ |
| **æµ‹è¯•å¤±è´¥ç‡** | æ—  | è®°å½•æµ‹è¯•å†å²æˆåŠŸç‡ã€å¤±è´¥åˆ†å¸ƒ | æµ‹è¯•å¥åº·åº¦ä¸å¯åº¦é‡ |
| **è¦†ç›–ç‡è¶‹åŠ¿** | æ—  | è®°å½•è¦†ç›–ç‡å†å²æ›²çº¿ | è¦†ç›–ç‡ä¸‹é™ä¸è¢«æ„ŸçŸ¥ |
| **æ€§èƒ½åŸºçº¿** | `perf-test.yml` æ‰§è¡ŒåŸºå‡†æµ‹è¯•ä½†æœªæŒä¹…åŒ–åŸºçº¿ | åŸºå‡†æµ‹è¯•ç»“æœæŒä¹…åŒ–åˆ°å­˜å‚¨ï¼ŒPR é—´è‡ªåŠ¨å¯¹æ¯” | æ€§èƒ½é€€åŒ–ç›´åˆ°å‘å¸ƒæ‰è¢«å‘ç° |
| **æ„å»ºå¤±è´¥å‘Šè­¦** | æ— ï¼ˆé»˜è®¤ GitHub é€šçŸ¥ï¼‰ | å¤±è´¥å‘Šè­¦åˆ°å³æ—¶é€šè®¯å·¥å…· | æ„å»ºå¤±è´¥å“åº”å»¶è¿Ÿ |
| **ä¾èµ–è¿‡æœŸè¿½è¸ª** | Dependabot åªå¼€ PRï¼Œæ— å‡çº§ä¼˜å…ˆçº§æ ‡è®° | ä¾èµ–è¿‡æœŸå¹´é¾„ã€å®‰å…¨ä¸¥é‡åº¦çš„ä»ªè¡¨ç›˜ | æŠ€æœ¯å€ºåŠ¡ç®¡ç†ç¼ºå¤± |
| **äºŒè¿›åˆ¶å¤§å°è¿½è¸ª** | æ—  | è®°å½•æ¯æ¬¡æ„å»ºçš„ dist/ å¤§å° | åŒ…ä½“ç§¯è†¨èƒ€ä¸å¯è§ |

## 4 æ ¹å› åˆ†æ

### 4.1 ä¸ºä»€ä¹ˆ CI/CD ä¸€ç›´ç¼ºå¤±

1. **é¡¹ç›®æ¼”è¿›é˜¶æ®µ**: `package.json:2` å®šä¹‰ç‰ˆæœ¬ä¸º `0.1.0`ï¼Œé¡¹ç›®å¤„äºæ—©æœŸå¼€å‘é˜¶æ®µã€‚ä¼˜å…ˆå»ºç«‹äº† Rust CIï¼ˆæˆç†Ÿçš„ cargo å·¥å…·é“¾ + GitHub Actions ç”Ÿæ€ï¼‰ï¼Œä½† TS/JS éƒ¨åˆ†é‡‡ç”¨"æ‰‹åŠ¨å¯ç”¨å³å¯"çš„è½»é‡ç­–ç•¥ã€‚

2. **ä¾èµ–å¤æ‚åº¦è¿‡é«˜**: é¡¹ç›®é‡‡ç”¨ npm workspacesï¼ˆ10 ä¸ªå·¥ä½œç©ºé—´åŒ…ï¼‰+ Rust workspaceï¼ˆ12 ä¸ª crateï¼‰+ Tauriï¼ˆRust+JS æ··åˆæ¶æ„ï¼‰+ esbuildï¼ˆJS bundleï¼‰+ tscï¼ˆç±»å‹ç”Ÿæˆï¼‰+ turboï¼ˆæ„å»ºç¼–æ’ï¼‰çš„å¤šå±‚æ„å»ºä½“ç³»ã€‚ç›¸æ¯”å•ä¸€æ„å»ºå·¥å…·çš„é¡¹ç›®ï¼ŒCI é›†æˆçš„è®¤çŸ¥è´Ÿè·æ˜¾è‘—æ›´é«˜ã€‚å›¢é˜Ÿå¯èƒ½å› ä¸º"æ„å»ºç³»ç»Ÿè¿‡äºå¤æ‚ä»¥è‡³äºä¸çŸ¥é“å¦‚ä½•åœ¨ CI ä¸­æ­£ç¡®é…ç½®"è€Œæ¨è¿Ÿé›†æˆã€‚

3. **æ„å»ºç¢ç‰‡åŒ–**: æ¯ä¸ªå­åŒ…ç‹¬ç«‹ç»´æŠ¤ `build` / `build:types` / `build:js` å‘½ä»¤ï¼ˆå¦‚ `packages/agent-daemon/package.json:25-28`ã€`packages/shared-types/package.json:25-28`ï¼‰ã€‚è™½ç„¶æ„å»ºæ¨¡å¼é«˜åº¦ä¸€è‡´ï¼ˆclean â†’ tsc declaration â†’ esbuildï¼‰ï¼Œä½†æ— è„šæœ¬å±‚é¢çš„ç»Ÿä¸€æŠ½è±¡ï¼Œå¯¼è‡´ CI é…ç½®éš¾ä»¥ç®€æ´è¡¨è¾¾"æ„å»ºå…¨éƒ¨åŒ…"ã€‚

4. **æµ‹è¯•åŸºç¡€è®¾æ–½ä¸ç»Ÿä¸€**ï¼š
   - vitest ç”¨äºå•å…ƒæµ‹è¯•ï¼ˆNode ç¯å¢ƒ + jsdom ç¯å¢ƒï¼‰
   - Playwright ç”¨äºè§†è§‰æµ‹è¯•ï¼ˆ`apps/crish-desktop/package.json:17`ï¼‰
   - cargo test ç”¨äº Rust æµ‹è¯•
   - `tests/stress/` ä¸‹çš„è‡ªå®šä¹‰æµ‹è¯•æ¡†æ¶ï¼ˆ`package.json:42-45`ï¼‰
   - å¤šç§æµ‹è¯•æ¡†æ¶å¢åŠ äº† CI é…ç½®å¤æ‚åº¦

5. **æœ¬åœ°éªŒè¯æ›¿ä»£ CI**ï¼š`.husky/pre-push` æ‰§è¡Œ `npm run typecheck && npm test`ï¼Œå¯èƒ½ä½¿å›¢é˜Ÿè®¤ä¸º"æäº¤å‰æœ¬åœ°è¿è¡Œé€šè¿‡äº†å°±æ˜¯å¥½çš„"ï¼Œä»è€Œæ¨è¿Ÿ CI å»ºè®¾ã€‚ä½† `npm run typecheck` åª cover `apps/crish-desktop/tsconfig.json`ï¼ˆ`package.json:54`ï¼‰ï¼Œ`npm test` è¿è¡Œæ‰€æœ‰ vitest æµ‹è¯•ï¼ˆå« e2eï¼‰ï¼Œæœ¬åœ°è¿è¡Œæ—¶å¯èƒ½å› ç¼ºå°‘ provider API key è·³è¿‡æˆ–è¶…æ—¶ã€‚

6. **å‘å¸ƒæµç¨‹æœªå®šä¹‰**: é¡¹ç›®å°šæœªè¿›è¡Œè¿‡æ­£å¼å‘å¸ƒï¼ˆæ‰€æœ‰åŒ…ç‰ˆæœ¬ä¸º `0.1.0`ï¼‰ï¼Œå› æ­¤å‘å¸ƒæµæ°´çº¿æœªè¢«å¼ºåˆ¶è¦æ±‚ã€‚`release.yml` çš„åˆ›å»ºå¯èƒ½æ¥è‡ª Tauri æ¨¡æ¿çš„é»˜è®¤é…ç½®ï¼Œè€Œéä¸»åŠ¨è®¾è®¡ã€‚

### 4.2 å½“å‰æ¶æ„ä¸­è®© CI éš¾ä»¥æ¥å…¥çš„è®¾è®¡

1. **development exports condition ä¾èµ–**: æ‰€æœ‰åŒ…çš„ `package.json` ä½¿ç”¨ `exports` å­—æ®µï¼ˆè¯¦è§ `packages/agent-daemon/package.json:9-20`ã€`packages/shared-utils/package.json:9-40`ï¼‰ï¼Œé€šè¿‡ `development` custom condition åœ¨å¼€å‘æ—¶ç›´æ¥ä½¿ç”¨ `.ts` æºæ–‡ä»¶ã€‚è¿™éœ€è¦ CI ä»»åŠ¡æ­£ç¡®è®¾ç½® `--conditions development` æ ‡å¿—ï¼Œæˆ–ç¡®ä¿æ‰€æœ‰ `dist/` äº§ç‰©ä¸ºæœ€æ–°ã€‚å½“å‰ CI çš„ `npx tsc --noEmit` å‘½ä»¤æœªè®¾ç½®æ­¤æ¡ä»¶ï¼Œå¯èƒ½å¯¼è‡´ç±»å‹æ£€æŸ¥åå·®ã€‚

2. **tsc-alias åå¤„ç†**: æ¯ä¸ªåŒ…çš„ `build:types` å‘½ä»¤ï¼ˆå¦‚ `packages/agent-daemon/package.json:26`ï¼‰ä½¿ç”¨ `tsc-alias` è§£æ path aliasã€‚å¦‚æœåœ¨ CI ä¸­åªåš `tsc --noEmit` è€Œä¸è¿è¡Œ `tsc-alias`ï¼Œç±»å‹æ£€æŸ¥å¯èƒ½é€šè¿‡ä½†å®é™…äº§ç‰©ä¸­è·¯å¾„æ— æ•ˆã€‚

3. **tsbuildinfo ç¼“å­˜æ‰‹åŠ¨æ¸…ç†**: å„åŒ…çš„ `build:types` å‘½ä»¤ï¼ˆå¦‚ `packages/shared-types/package.json:26`ï¼‰ä¼š `rmSync` æ¸…ç©º `.tsbuildinfo` ç¼“å­˜ï¼Œè¿™ä¸ turbo çš„å¢é‡æ„å»ºæ„å›¾çŸ›ç›¾ã€‚å¦‚æœ CI ç”¨ turbo ç¼–æ’ï¼Œéœ€è¦å¤„ç†è¿™ä¸ªå†²çªã€‚

4. **esbuild é…ç½®é‡å¤**: å„åŒ…çš„ `build:js` å‘½ä»¤å‚æ•°ä¸ç»Ÿä¸€ï¼š
   - `packages/agent-daemon/package.json:27`: `esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap`
   - `packages/shared-utils/package.json:47-49`: åŒæ ·çš„å‚æ•° + é¢å¤–çš„ browser/node å…¥å£
   - `packages/decision-engine/package.json:25`: åŒæ ·çš„å‚æ•°
   è™½ç„¶å‚æ•°ä¸€è‡´ï¼Œä½†åˆ†æ•£åœ¨ 7 ä¸ªæ–‡ä»¶ä¸­ï¼ŒCI é…ç½®éš¾ä»¥ç»Ÿä¸€å¼•ç”¨å’Œç®¡ç†ã€‚

5. **Tauri æ„å»ºçš„å‰ç½®æ¡ä»¶**: `apps/agent-workbench/package.json:9` çš„ build å‘½ä»¤é‡å®šå‘åˆ° `../crish-desktop`ï¼Œè€Œ `apps/crish-desktop/package.json:10` çš„ build æ˜¯ `tsc -b && vite build`ã€‚CI ä¸­è¿è¡Œ Tauri build éœ€è¦å®‰è£…ç³»ç»Ÿçº§ä¾èµ–ï¼ˆ`release.yml:33-35` åˆ—å‡ºçš„ libgtk-3, libwebkit2gtk-4.1 ç­‰ï¼‰ï¼Œå¢åŠ äº†è·¨å¹³å° CI çš„ç»´æŠ¤æˆæœ¬ã€‚

6. **stress/bench æµ‹è¯•çš„å¤–éƒ¨ä¾èµ–**: `package.json:42-47` å®šä¹‰çš„ stress æµ‹è¯•å’Œ bench æµ‹è¯•å¯èƒ½ä¾èµ–å¤–éƒ¨ Provider APIï¼Œä½¿ CI è¿è¡Œè¿™äº›æµ‹è¯•éœ€è¦ API key ç®¡ç†ã€‚

## 5 å½±å“è¯„ä¼°

### 5.1 å®‰å…¨æ€§é£é™©

- **é«˜**: ä¾èµ–å®¡è®¡ä½¿ç”¨ `continue-on-error: true`ï¼ˆ`ci.yml:122,134`ï¼‰ï¼Œå·²çŸ¥é«˜/ä¸¥é‡æ¼æ´ä¸ä¼šé˜»æ–­æµæ°´çº¿ã€‚ä¾‹å¦‚ï¼Œå¦‚æœ `ws`ï¼ˆ`package.json:93`ï¼Œdaemon å’Œ runtime ä½¿ç”¨ï¼‰æˆ– `@modelcontextprotocol/sdk`ï¼ˆ`packages/agent-daemon/package.json:39`ï¼‰å‡ºç°å®‰å…¨æ¼æ´ï¼ŒCI ä¸ä¼šæ‹’ç»å…¶è¿›å…¥ main åˆ†æ”¯ã€‚
- **é«˜**: æ— å¯†é’¥æ‰«æï¼Œå†å²è®°å½•ä¸­çš„å¯†é’¥æ³„éœ²ä¸å¯è¿½æº¯ã€‚éƒ¨åˆ† cratesï¼ˆå¦‚ `conex-net`ã€`conex-db`ï¼‰å¯èƒ½åœ¨æµ‹è¯•ä¸­å†™å…¥ä¸´æ—¶å‡­è¯ã€‚
- **ä¸­**: æ—  SBOM ç”Ÿæˆï¼Œæ— æ³•æ»¡è¶³ä¾›åº”é“¾å®‰å…¨å®¡è®¡éœ€æ±‚ã€‚
- **ä¸­**: `npm audit signatures` æœªæ‰§è¡Œï¼Œæ³¨å†Œè¡¨ç­¾åå®Œæ•´æ€§æ— æ³•éªŒè¯ã€‚

### 5.2 è´¨é‡é£é™©

- **é«˜**: è¦†ç›–ç‡é˜ˆå€¼å·²å®šä¹‰ä½†ä¸å¼ºåˆ¶ï¼ˆ`apps/crish-desktop/vitest.config.ts:13-18`ï¼‰ï¼Œä»£ç è¦†ç›–ç‡æŒç»­ä¸‹é™ã€‚å½“å‰ 8 ä¸ªåˆ†æç»´åº¦æŠ¥å‘Šäº† 215 ä¸ªé—®é¢˜ï¼Œè¦†ç›– 130+ æºæ–‡ä»¶ï¼Œæ—  CI é—¨ç¦æ„å‘³ç€è¿™äº›é—®é¢˜å°†æŒç»­å­˜åœ¨ç”šè‡³æ¶åŒ–ã€‚
- **é«˜**: TypeScript ä¸¥æ ¼æ¨¡å¼ï¼ˆ`tsconfig.base.json` çš„ `strict`ã€`noUncheckedIndexedAccess`ã€`exactOptionalPropertyTypes`ï¼‰ä»…åœ¨ `npm run typecheck` ä¸­å¯¹ crish-desktop æ‰§è¡Œï¼Œå…¶ä»– 9 ä¸ªå·¥ä½œç©ºé—´åŒ…çš„ç±»å‹å®‰å…¨ä¸éªŒè¯ã€‚
- **ä¸­**: `eslint.config.js` çš„ `react-refresh/only-export-components` è§„åˆ™å’Œ `no-restricted-syntax` è§„åˆ™ä»…åœ¨æœ¬åœ° pre-commit è§¦å‘ï¼ŒCI ä¸æ‰§è¡Œã€‚
- **ä¸­**: `command-registry:check`ï¼ˆ`apps/agent-workbench/package.json:12`ï¼‰éªŒè¯ Tauri command æ³¨å†Œå®Œæ•´æ€§ï¼ŒCI ä¸æ‰§è¡Œã€‚
- **ä½**: `check:store-types`ï¼ˆ`package.json:56`ï¼‰éªŒè¯ store ä¸­æ—  `as any` æ¨¡å¼ï¼ŒCI ä¸æ‰§è¡Œã€‚

### 5.3 åä½œæ•ˆç‡é£é™©

- **é«˜**: CI ç¢ç‰‡åŒ–ï¼ˆåªæµ‹è¯• 1/7 ä¸ª TS åŒ…ï¼‰å¯¼è‡´ PR åˆå¹¶åå…¶ä»–åŒ…çš„ä»£ç æŸåä¸ä¼šè¢«åŠæ—¶å‘ç°ã€‚ä¾‹å¦‚ï¼Œä¿®æ”¹ `@crish/shared-types` åï¼Œ`@crish/agent-runtime` å’Œ `@crish/agent-orchestrator` çš„æµ‹è¯•å‡ä¸æ‰§è¡Œã€‚
- **é«˜**: æ— çŸ©é˜µæµ‹è¯•å¯¼è‡´ä¸åŒ OS/Node ç‰ˆæœ¬çš„å…¼å®¹æ€§é—®é¢˜ç›´åˆ°ç”¨æˆ·æŠ¥å‘Šæ‰è¢«å‘ç°ã€‚
- **ä¸­**: æ„å»ºä¸ä½¿ç”¨ turbo ç¼“å­˜ï¼Œæ¯æ¬¡ CI å…¨é‡æ„å»º `build:packages`ï¼Œæµªè´¹çº¦ 2-3 åˆ†é’Ÿã€‚
- **ä¸­**: æ— é›†æˆæµ‹è¯•æ‰§è¡Œï¼Œè·¨åŒ…å¥‘çº¦å˜æ›´çš„é£é™©ä¸å¯è§ã€‚ç‰¹åˆ«æ˜¯ `@crish/agent-orchestrator` ä¾èµ– `@crish/agent-runtime`ï¼ˆ`packages/agent-orchestrator/package.json:31`ï¼‰ï¼Œ`@crish/agent-daemon` ä¾èµ– `@crish/agent-orchestrator`ï¼ˆ`packages/agent-daemon/package.json:33`ï¼‰ï¼Œè¿™æ¡ä¾èµ–é“¾çš„æ–­è£‚ä¸ä¼šè¢«æ—©æœŸå‘ç°ã€‚
- **ä½**: visual testing åœ¨ CI ä¸­ç¼ºå¤±ï¼ŒUI å›å½’é—®é¢˜è¿›å…¥ç”Ÿäº§ã€‚
- **ä½**: åŸºå‡†æµ‹è¯•ç»“æœä¸æŒä¹…åŒ–ï¼Œæ€§èƒ½é€€åŒ–è¶‹åŠ¿ä¸å¯è¿½æº¯ã€‚

## 6 å…·ä½“ä»£ç è¯æ®ç´¢å¼•

ä»¥ä¸‹æŒ‰æ–‡ä»¶è·¯å¾„å’Œè¡Œå·åˆ—å‡ºæœ¬æ–‡å¼•ç”¨çš„æ‰€æœ‰å…³é”®è¯æ®ç‚¹ï¼š

| æ–‡ä»¶ | è¡Œå· | å†…å®¹ |
|------|------|------|
| `package.json` | 2 | ç‰ˆæœ¬ `0.1.0` è¡¨æ˜æ—©æœŸé˜¶æ®µ |
| `package.json` | 7-16 | npm workspaces 10 ä¸ªåŒ… |
| `package.json` | 17-67 | å…¨éƒ¨ 50 æ¡ script å®šä¹‰ |
| `package.json` | 24-30 | åˆ†å±‚æ„å»ºé“¾ï¼šbuild:shared-types â†’ build:product |
| `package.json` | 49 | `perf:all` èšåˆæ€§èƒ½å‘½ä»¤ |
| `package.json` | 50 | `check:core` èšåˆ check å‘½ä»¤ |
| `package.json` | 54 | `typecheck` åª cover crish-desktop |
| `package.json` | 56 | `check:store-types` å­˜åœ¨ä½†ä¸ CI |
| `package.json` | 57-61 | æµ‹è¯•å‘½ä»¤å®šä¹‰ |
| `package.json` | 62-65 | lint/check ä¸¥æ ¼æ¨¡å¼ä¸å®½æ¾æ¨¡å¼å¹¶å­˜ |
| `package.json` | 69-86 | devDependencies å« dependency-cruiser, esbuild, vitest ç­‰ |
| `turbo.json` | 3-30 | pipeline å®šä¹‰å« 7 ä¸ªä»»åŠ¡ |
| `turbo.json` | 6 | `outputs: ["dist/**", ".tsbuildinfo"]` ç¼“å­˜å£°æ˜åœ¨ CI ä¸­æœªç”¨ |
| `tsconfig.base.json` | 8-23 | strict æ¨¡å¼å¼€å¯ä½† CI æœªå…¨éƒ¨éªŒè¯ |
| `tsconfig.base.json` | 18-19 | noUnusedLocals/noUnusedParameters å…³é—­ï¼Œæ­»ä»£ç ä¸å¯æ£€æµ‹ |
| `vitest.config.ts` | 7-16 | include è¦†ç›– packages + appsï¼Œä½† CI åªä¼ å­è·¯å¾„ |
| `vitest.config.ts` | 13-16 | coverage é…ç½® v8, text/json/html æŠ¥å‘Š |
| `apps/crish-desktop/vitest.config.ts` | 13-18 | è¦†ç›–ç‡é˜ˆå€¼å·²å®šä¹‰ä½†ä¸å¼ºåˆ¶ |
| `eslint.config.js` | 9-21 | ignores åˆ—è¡¨å« 11 ç§ AI Agent å·¥ä½œç›®å½• |
| `eslint.config.js` | 55-57 | Frontend rules è¦†ç›– crish-desktop + agent-workbench |
| `.lintstagedrc.json` | 1-5 | lint-staged é…ç½®ï¼ˆts, css, jsonï¼‰ |
| `.husky/pre-commit` | 1 | `npx lint-staged` |
| `.husky/pre-push` | 1 | `npm run typecheck && npm test` |
| `packages/agent-daemon/package.json` | 25-28 | build ä¸‰å…ƒç»„ï¼šclean â†’ build:types(tsc) â†’ build:js(esbuild) |
| `packages/agent-daemon/package.json` | 26 | tsc-alias åå¤„ç† |
| `packages/shared-types/package.json` | 25-28 | åŒæ · build æ¨¡å¼ |
| `packages/shared-utils/package.json` | 47-49 | å¤šå…¥å£ esbuildï¼ˆbrowser + nodeï¼‰ |
| `packages/agent-orchestrator/package.json` | 31 | ä¾èµ– chain: orchestrator â†’ runtime |
| `packages/agent-daemon/package.json` | 33 | ä¾èµ– chain: daemon â†’ orchestrator |
| `apps/agent-workbench/package.json` | 12 | cli:check å« command-registry:check |
| `apps/crish-desktop/package.json` | 10 | build = tsc -b && vite build |
| `apps/crish-desktop/package.json` | 13 | qa:check å« 4 é¡¹å…³é”®è´¨é‡æµ‹è¯• |
| `apps/crish-desktop/package.json` | 16-17 | Playwright visual test é…ç½® |
| `Cargo.toml` | 2-15 | Rust workspace å« 12 ä¸ª crate members |
| `Cargo.toml` | 60-66 | workspace.package å…ƒæ•°æ® |
| `.github/dependabot.yml` | 1-25 | dependabot é…ç½® npm + cargo |
| `.github/dependabot.yml` | 25 | `ignore: conex-stream` ç¼ºå°‘åŸå›  |
| `.github/workflows/ci.yml` | 79 | TS check åª cover agent-runtime |
| `.github/workflows/ci.yml` | 85,88 | test suites ç”¨ `|| true` é™é»˜åå¤±è´¥ |
| `.github/workflows/ci.yml` | 117-134 | security-audit ç”¨ continue-on-error |
| `.github/workflows/ci.yml` | 136-148 | ESLint åª cover provider å­ç›®å½• |
| `.github/workflows/ci.yml` | 163-167 | coverage check æ— å®é™…é˜ˆå€¼éªŒè¯ |
| `.github/workflows/ci.yml` | 169-181 | e2e åª cover provider e2e |
| `.github/workflows/ci.yml` | 209 | bench ç”¨ `|| true` é™é»˜ |
| `.github/workflows/perf-test.yml` | 1-137 | æ€§èƒ½æµ‹è¯•æ—  Node ç‰ˆæœ¬çŸ©é˜µã€æ— è·¨å¹³å° |
| `.github/workflows/provider-validation.yml` | 1-83 | ç‹¬ç«‹çš„ provider JSON æ ¡éªŒ |
| `.github/workflows/release.yml` | 61 | ä½¿ç”¨ `generate_release_notes: true`ï¼ˆè‡ªåŠ¨ï¼‰è€Œéç»“æ„åŒ– |
| `.github/workflows/release.yml` | 23 | Node 20ï¼ˆè½åå½“å‰ç‰ˆæœ¬ï¼‰ |
| `vitest.setup.ts` | 1-44 | browser å…¨å±€è¡¥é½ï¼Œvite è·¨ç¯å¢ƒæµ‹è¯•å‡†å¤‡ |

## æ•°æ®æ”¯æ’‘

- é¡¹ç›®æ€»åŒ…æ•°ï¼šnpm workspaces 10 + Rust workspace 12 = 22 ä¸ªå¯æ„å»ºå•å…ƒ
- CI ä¸­å®é™…æ‰§è¡Œçš„ TS å­åŒ…æ•°ï¼š1ï¼ˆagent-runtime çš„ provider å­ç›®å½•ï¼‰
- CI ä¸­å®é™…æ‰§è¡Œçš„ Rust crate è¦†ç›–ç‡ï¼šé€šè¿‡ `cargo test --workspace` è¦†ç›– 12 ä¸ª crate + ç‹¬ç«‹ conex-stream
- TypeScript æµ‹è¯•æ–‡ä»¶ï¼š`vitest.config.ts:8-11` å®šä¹‰çš„ include æ¨¡å¼è¦†ç›–çº¦æ•°ç™¾ä¸ªæµ‹è¯•æ–‡ä»¶ï¼ŒCI ä¸­ä»…æ‰§è¡Œ <5%
- æ„å»ºå‘½ä»¤æ•°ï¼šæ ¹ package.json 50 æ¡ script + å„å­åŒ…çº¦ 30 æ¡ script = çº¦ 80 æ¡å¯æ‰§è¡Œå‘½ä»¤
- CI ä¸­å®é™…è§¦å‘çš„æ„å»ºå‘½ä»¤æ•°ï¼šçº¦ 12 æ¡ï¼ˆä»…é’ˆå¯¹ agent-runtime å’Œ Rust crateï¼‰
- å‘å¸ƒåˆ¶å“ç±»å‹ï¼šnpm åŒ…ï¼ˆ6 ä¸ªï¼‰ã€Tauri æ¡Œé¢å®‰è£…åŒ…ï¼ˆ3 å¹³å°ï¼‰ã€daemon äºŒè¿›åˆ¶ï¼ˆæœªçº³å…¥ CIï¼‰

### 3.7 CI »ù´¡ÉèÊ©²î¾à

| ²î¾àÏî | µ±Ç°×´Ì¬ | ÀíÏë×´Ì¬ | Éæ¼° |
|--------|----------|----------|------|
| ²¢·¢¿ØÖÆ | ½ö release.yml ÓĞ | ËùÓĞ workflow Í³Ò»²¢·¢²ßÂÔ | ci.yml, perf-test.yml |
| È¨ÏŞ×îĞ¡»¯ | Î´ÉùÃ÷ permissions | Ã¿¸ö job ÏÔÊ½×îĞ¡È¨ÏŞ | ËùÓĞ workflow |
| Â·¾¶¹ıÂË | ÎŞ | Ö»´¥·¢±ä¸üÏà¹Ø job | ci.yml |
| ³¬Ê±ÉèÖÃ | e2e ÓĞ 5min£¨ci.yml:171£©£¬ÆäÓàÄ¬ÈÏ | ºÏÀí³¬Ê± + Í¨Öª | ËùÓĞ workflow |
| ÖØÊÔ²ßÂÔ | ÎŞ | ²âÊÔ»ò²½ÖèÊ§°Ü×Ô¶¯ÖØÊÔ | ci.yml |
| Runner Ñ¡Ôñ | È«²¿ GitHub-hosted | ¹Ø¼ü job ¿ÉÇĞ»»×ÔÍĞ¹Ü | ÎŞ |
| »·¾³±äÁ¿¹ÜÀí | ÎŞ×éÖ¯ | »·¾³±äÁ¿·Ö×é/ÃüÃû¹æ·¶ | ËùÓĞ workflow |
| workflow ¼ä¸´ÓÃ | ÎŞ | ¿É¸´ÓÃµÄ composite action | ÎŞ |
| ×Ô¶¯È¡ÏûÈßÓà | ÎŞ | Í¬ PR ¾ÉÍÆËÍ×Ô¶¯È¡Ïû | ci.yml, perf-test.yml |

## 4 ¸ùÒò·ÖÎö

### 4.1 ÎªÊ²Ã´ CI/CD Ò»Ö±È±Ê§

**¸ùÒò 1£ºÏîÄ¿Ñİ½ø½×¶ÎÓëÓÅÏÈ¼¶´íÎ»**

ÏîÄ¿°æ±¾Îª 0.1.0£¨package.json:2£©£¬´¦ÓÚÔçÆÚ¿ª·¢½×¶Î¡£ÍÅ¶ÓÓÅÏÈ½¨Á¢ÁË Rust CI£¨ci.yml:13-42 µÄ rust-check job£©£¬ÒòÎª Rust µÄ cargo ¹¤¾ßÁ´ÔÚ CI ÖĞÅäÖÃ¼òµ¥ÇÒÓĞ³ÉÊìµÄ action¡£TS/JS ²¿·ÖµÄ¹¹½¨ÌåÏµ¸´ÔÓ£¨npm workspaces + turbo + esbuild + tsc + Vite + tsc-alias + Tauri£©£¬ÍÅ¶Ó¿ÉÄÜÈÏÎªÊÖ¶¯¹¹½¨ÒÑ×ã¹»»òÏÈÈÃ¹¦ÄÜÅÜÆğÀ´ÔÙ¿¼ÂÇ CI¡£

Rust CI ¸´ÔÓ¶È: cargo check/test/clippy/fmt -> 4 ÌõÃüÁî£¬ËùÓĞ crate Í³Ò»
TS CI ¸´ÔÓ¶È: tsc --noEmit x 7 ¸ö°ü + esbuild x 7 ¸ö°ü + vite build + tsc-alias x 7 + ÒÀÀµË³Ğò¹ÜÀí + development exports -> Ô¼ 30 ÌõÃüÁî

**¸ùÒò 2£ºÒÀÀµ¸´ÔÓ¶È¹ı¸ßµ¼ÖÂÈÏÖª¸ººÉ³¬ÔØ**

ÏîÄ¿²ÉÓÃ npm workspaces£¨10 ¸ö°ü£©+ Rust workspace£¨12 ¸ö crate£©+ Tauri + esbuild + tsc + turbo + tsc-alias µÄ¶à²ã¹¹½¨ÌåÏµ¡£Ã¿¸ö°üÓĞ¶ÀÁ¢µÄ tsconfig¡¢esbuild ÅäÖÃºÍ build ½Å±¾¡£ÕâÖÖÍØÆË½á¹¹Ê¹µÃÔÚ CI ÖĞÕıÈ·ÅäÖÃ¹¹½¨Ë³ĞòµÄÈÏÖª³É±¾Ô¶¸ßÓÚµ¥°üÏîÄ¿¡£ÍÅ¶Ó¿ÉÄÜÏİÈë·ÖÎöÌ±»¾¡ª¡ªÒòÎª¹¹½¨ÏµÍ³¹ıÓÚ¸´ÔÓÒÔÖÁÓÚ²»ÖªµÀÈçºÎÔÚ CI ÖĞÕıÈ·ÅäÖÃ£¬ËùÒÔÑ¡Ôñ²»ÅäÖÃ¡£

**¸ùÒò 3£º¹¹½¨ËéÆ¬»¯Óë½Å±¾ÖØ¸´**

7 ¸ö TS °ü¸÷×ÔÎ¬»¤ÖØ¸´µÄ build / build:types / build:js ÃüÁî¡£ËäÈ»Ä£Ê½¸ß¶ÈÒ»ÖÂ£¨clean -> tsc declaration -> esbuild£©£¬µ«ÎŞ³éÏó²ã£º

- packages/agent-daemon/package.json:25-28: clean -> build:types -> build:js
- packages/shared-types/package.json:25-28: clean -> build:types -> build:js
- packages/shared-utils/package.json:44-50: clean -> build:types -> build:js -> build:js:browser -> build:js:node
- packages/decision-engine/package.json:22-26: clean -> build:types -> build:js
- packages/agent-runtime/package.json:34-38: clean -> build:types -> build:js
- packages/agent-orchestrator/package.json:24-28: clean -> build:types -> build:js

Õâ¸öÄ£Ê½µÄ 6 ´ÎÖØ¸´ÒâÎ¶×Å¶Ô¹¹½¨µÄÈÎºÎĞŞ¸Ä¶¼ĞèÒªĞŞ¸Ä 6 ¸öÎÄ¼ş¡£Èç¹ûÒªÔÚ CI ÖĞ¹¹½¨È«²¿£¬Ä¿Ç°µÄ×ö·¨ÊÇ npm run build:packages£¬ÕâÊÇ¸ö npm ½Å±¾¶ø·Ç¹¤¾ß²ãµÄµ¥µãÅäÖÃ¡£

**¸ùÒò 4£º±¾µØÑéÖ¤µÄĞé¼Ù°²È«¸Ğ**

.husky/pre-push Ö´ĞĞ npm run typecheck && npm test¡£±íÃæÉÏÕâÌá¹©ÁËÌá½»Ç°µÄÖÊÁ¿ÃÅ½û£¬µ«Êµ¼ÊÉÏ£º
- npm run typecheck Ö»¼ì²é apps/crish-desktop/tsconfig.json£¨package.json:54£©£¬ÆäËû 6 ¸ö TS °üµÄÀàĞÍÍêÈ«²»¼ì²é
- npm test ÔËĞĞÈ«²¿ vitest ²âÊÔ£¨°üÀ¨ e2e£©£¬±¾µØÒòÈ±ÉÙ Provider API key »áÌø¹ı»òÊ§°Ü
- ¿ª·¢Õß¿ÉÒÔÊ¹ÓÃ git push --no-verify ÍêÈ«ÈÆ¹ıÕâĞ©¼ì²é

±¾µØÑéÖ¤ÌåÏµµÄ²»ÍêÉÆ¿ÉÄÜÊ¹ÍÅ¶Ó²úÉúÎÒÃÇÒÑ¾­ÓĞÁË¼ì²éµÄ´í¾õ£¬´Ó¶øÍÆ³Ù CI ½¨Éè¡£

**¸ùÒò 5£º²âÊÔ»ù´¡ÉèÊ©²»Í³Ò»**

ÏîÄ¿Ê¹ÓÃ¶àÖÖ²âÊÔ¿ò¼ÜºÍ²âÊÔÀàĞÍ£º
- vitest£¨µ¥Ôª²âÊÔ£¬Node + jsdom Ë«»·¾³£©
- Playwright£¨ÊÓ¾õ²âÊÔ£¬apps/crish-desktop/package.json:17£©
- cargo test£¨Rust ²âÊÔ£©
- ×Ô¶¨Òå stress ²âÊÔ¿ò¼Ü£¨package.json:42-45£©
- ×Ô¶¨Òå benchmark ¿ò¼Ü£¨package.json:36-38£©
- ×Ô¶¨Òå startup ²âÊÔ£¨package.json:46-47£©

²âÊÔ¿ò¼ÜµÄ¶àÑùĞÔÔö¼ÓÁË CI ÅäÖÃµÄ¸´ÔÓ¶È¡£Ã¿ÖÖ²âÊÔ¿ò¼Ü¶¼ĞèÒª²»Í¬µÄ°²×°²½Öè¡¢²»Í¬µÄ runner ÅäÖÃºÍ²»Í¬µÄ±¨¸æ¸ñÊ½¡£

**¸ùÒò 6£º·¢²¼Á÷³ÌÉĞÎ´´¥·¢**

ÏîÄ¿ÉĞÎ´½øĞĞ¹ıÕıÊ½·¢²¼¡£ËùÓĞ°ü°æ±¾Îª 0.1.0£¬ÎŞÈÎºÎ CHANGELOG ÎÄ¼ş¡£release.yml µÄ´æÔÚ¿ÉÄÜÀ´×Ô create-tauri-app Ä£°åµÄÄ¬ÈÏÅäÖÃ£¬¶ø·ÇÖ÷¶¯Éè¼Æ¡£ÒòÎªÃ»ÓĞÊµ¼ÊµÄ·¢²¼ĞèÇó£¬·¢²¼Á÷Ë®ÏßÎ´±»Ç¿ÖÆÒªÇó£¬npm publish µÈÄÜÁ¦µÄÈ±Ê§Ò²¾ÍÃ»ÓĞ±»×¢Òâµ½¡£

### 4.2 ¼Ü¹¹Éè¼Æ¶Ô CI ½ÓÈëµÄ×è°­

**×è°­ 1£ºdevelopment exports condition ÒÀÀµ**

ËùÓĞ°üµÄ package.json Ê¹ÓÃ exports ×Ö¶ÎµÄ development condition¡£ÒÔ packages/agent-daemon/package.json:9-20 ÎªÀı£¬development Ìõ¼şÈÃ tsc ÔÚ¿ª·¢Ê±½âÎöµ½ src/index.ts£¬·ñÔò½âÎöµ½ dist/index.js¡£ÕâĞèÒª CI ÈÎÎñÕıÈ·ÉèÖÃ --conditions development ±êÖ¾£¬·ñÔò tsc »á³¢ÊÔ½âÎöµ½ dist/ ²úÎï¶ø²»ÊÇ src/ Ô´ÎÄ¼ş¡£µ±Ç° CI µÄ npx tsc --noEmit ÃüÁîÎ´ÏÔÊ½ÉèÖÃ´ËÌõ¼ş¡£

**×è°­ 2£ºtsc-alias ºó´¦Àí**

Ã¿¸ö°üµÄ build:types ÃüÁî£¨Èç packages/agent-daemon/package.json:26£©Ê¹ÓÃ tsc-alias ½âÎö path alias¡£Èç¹ûÔÚ CI ÖĞÖ»×ö tsc --noEmit ¶ø²»ÔËĞĞ tsc-alias£¬ÀàĞÍ¼ì²é¿ÉÄÜÍ¨¹ıµ«Êµ¼Ê²úÎïÖĞÂ·¾¶ÎŞĞ§¡£tsc-alias ½« tsconfig.json ÖĞµÄ paths Ó³Éä½âÎöÎªÏà¶ÔÂ·¾¶£¬ÕâÊÇÉú³É¿ÉÓÃÀàĞÍÉùÃ÷ÎÄ¼şµÄ¹Ø¼ü²½Öè¡£

**×è°­ 3£ºtsbuildinfo »º´æÊÖ¶¯ÇåÀí**

¸÷°üµÄ build:types ÃüÁîÖ´ĞĞ rmSync Çå¿Õ .tsbuildinfo »º´æ¡£ÀıÈç packages/shared-types/package.json:26 µÄ node -e require('node:fs').rmSync('../../node_modules/.cache/shared-types.tsbuildinfo', { force: true })¡£ÕâÓë turbo µÄÔöÁ¿¹¹½¨ÒâÍ¼Ã¬¶Ü¡ª¡ªturbo ÒÀÀµ .tsbuildinfo ÎÄ¼ş¼ì²âÔ´´úÂë±ä¸ü¡£Èç¹û CI ÓÃ turbo ±àÅÅ£¬ĞèÒª´¦ÀíÕâ¸ö³åÍ»£ºÒªÃ´ÒÆ³ıÊÖ¶¯ÇåÀí²½Öè£¬ÒªÃ´ÔÚ turbo µÄ pipeline ¶¨ÒåÖĞ±ê¼Ç clean ÈÎÎñÎªÀàĞÍ¼ì²éµÄÏÈ¾öÌõ¼ş¡£

**×è°­ 4£ºesbuild ÅäÖÃÖØ¸´**

¸÷°üµÄ build:js ÃüÁî²ÎÊı·ÖÉ¢ÔÚ 7 ¸öÎÄ¼şÖĞ£º
- packages/agent-daemon/package.json:27: esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap
- packages/shared-utils/package.json:47: Í¬ÉÏ£¬µ«ÓĞ¶îÍâµÄ browser Èë¿Ú
- packages/shared-utils/package.json:48: esbuild with --platform=browser
- packages/shared-utils/package.json:49: esbuild with --platform=node
- packages/decision-engine/package.json:25: Í¬ÉÏ

ËäÈ»²ÎÊıÒ»ÖÂ£¨esbuild src/index.ts --bundle --platform=node --format=esm --target=es2022 --packages=external --outfile=dist/index.js --sourcemap£©£¬µ«·ÖÉ¢ÔÚ¶à¸öÎÄ¼şÒâÎ¶×Å esbuild Éı¼¶£¨Èç´Ó 0.27 µ½ 0.28£©ĞèÒªÔÚ 7 ¸öµØ·½Í¬²½¸üĞÂÅäÖÃ¡£

**×è°­ 5£ºTauri ¹¹½¨µÄÇ°ÖÃÌõ¼ş**

apps/agent-workbench/package.json:9 µÄ build ÃüÁîÖØ¶¨Ïòµ½ ../crish-desktop£¬¶ø apps/crish-desktop/package.json:10 µÄ build ÊÇ tsc -b && vite build¡£CI ÖĞÔËĞĞ Tauri build ĞèÒªÏµÍ³¼¶ÒÀÀµ£¨release.yml:33-35 ÁĞ³öµÄ libgtk-3, libwebkit2gtk-4.1 µÈ£©£¬Ôö¼ÓÁË¿çÆ½Ì¨ CI µÄÎ¬»¤³É±¾¡£ÕâĞ©ÒÀÀµÔÚ ubuntu:latest ÉÏĞèÒª apt-get install£¬ÔÚ macOS ÉÏĞèÒª brew install£¬ÔÚ Windows ÉÏĞèÒª WebView2 ÔËĞĞÊ±£¨ÒÑÔ¤×°£©¡£

**×è°­ 6£ºstress/bench ²âÊÔµÄÍâ²¿ÒÀÀµ**

package.json:42-47 ¶¨ÒåµÄ stress ²âÊÔºÍ bench ²âÊÔ¿ÉÄÜÒÀÀµÍâ²¿ Provider API¡£Èç¹û CI ÔÚ²»Ìá¹© API key µÄÇé¿öÏÂÔËĞĞÕâĞ©²âÊÔ£¬ËüÃÇ»á³¬Ê±»òÊ§°Ü¡£µ±Ç° ci.yml Ê¹ÓÃ || true ¾²Ä¬Ä£Ê½ÕıÊÇÎªÁË½â¾öÕâ¸öÎÊÌâ¡£ÕıÈ·µÄ·½Ê½Ó¦¸ÃÊÇ£º½«ÕâĞ©²âÊÔ´Ó PR CI ÖĞÅÅ³ı£¬½öÔÚ¶¨Ê±ÈÎÎñ£¨ÈçÃ¿ÈÕ£©ÖĞÔËĞĞ£¬²¢ÔÚÔËĞĞÊ±×¢Èë¿ÉÑ¡µÄ API key »·¾³±äÁ¿¡£

## 5 Ó°ÏìÆÀ¹À

### 5.1 °²È«ĞÔ·çÏÕ

**¸ß·çÏÕ**£º
- ÒÀÀµÉó¼ÆÊ¹ÓÃ continue-on-error: true£¨ci.yml:122,134£©£¬ÒÑÖª¸ß/ÑÏÖØÂ©¶´²»»á×è¶ÏÁ÷Ë®Ïß¡£Èç¹û ws£¨package.json:93£¬daemon ºÍ runtime Ê¹ÓÃ WebSocket Í¨ĞÅ£©»ò @modelcontextprotocol/sdk£¨packages/agent-daemon/package.json:39£¬MCP Ğ­ÒéÊµÏÖ£©³öÏÖ°²È«Â©¶´£¬CI ²»»á¾Ü¾øÆä½øÈë main ·ÖÖ§¡£ÔÚ CVE-2024-XXXX ÀàĞÍµÄÂ©¶´ÅûÂ¶ºó£¬ÍÅ¶Ó¿ÉÄÜÔÚ²»°²È«µÄÒÀÀµÏÂÔËĞĞÊıÌìÖ±µ½ÏÂÒ»´ÎÊÖ¶¯Éó¼Æ¡£
- ÎŞÃÜÔ¿É¨Ãè£¬ÀúÊ·¼ÇÂ¼ÖĞµÄÃÜÔ¿Ğ¹Â¶²»¿É×·Ëİ¡£²¿·Ö crates£¨Èç conex-net ´¦ÀíÍøÂçÍ¨ĞÅ¡¢conex-db ¹ÜÀí±¾µØÊı¾İ¿â£©¿ÉÄÜÔÚ²âÊÔÅäÖÃÖĞĞ´ÈëÁÙÊ±Æ¾Ö¤¡£

**ÖĞ·çÏÕ**£º
- npm audit signatures Î´Ö´ĞĞ£¬ÎŞ·¨ÑéÖ¤×¢²á±íÇ©ÃûÍêÕûĞÔ¡£Èç¹ûÒ»¸ö npm °üµÄ dist-tag ±»½Ù³Ö£¬CI »áÎŞ¸ĞÖªµØ°²×°±»´Û¸ÄµÄ°ü¡£
- ÎŞ SBOM Éú³É£¬ÎŞ·¨Âú×ã¹©Ó¦Á´°²È«Éó¼ÆĞèÇó¡£¶ÔÓÚÆóÒµ²¿Êğ³¡¾°£¬SBOM£¨Software Bill of Materials£©ÊÇºÏ¹æĞÔÒªÇó¡£

**µÍ·çÏÕ**£º
- dependabot.yml:25 ºöÂÔ conex-stream crate µ«È±ÉÙÔ­ÒòËµÃ÷¡£Èç¹ûºöÂÔÊÇÒòÎªÄÚ²¿Éó¼Æ¹ıµÄ°²È«£¬ĞèÒªÃ÷È·×¢ÊÍÒÔ¸æÖªÎ´À´µÄÎ¬»¤Õß¡£

### 5.2 ÖÊÁ¿·çÏÕ

**¸ß·çÏÕ**£º
- ¸²¸ÇÂÊãĞÖµÒÑ¶¨Òåµ«²»Ç¿ÖÆ£¨apps/crish-desktop/vitest.config.ts:13-18£©£¬´úÂë¸²¸ÇÂÊ³ÖĞøÏÂ½µµ«ÎŞÈË¸ĞÖª¡£µ±Ç° 8 ¸ö·ÖÎöÎ¬¶È±¨¸æÁË 215 ¸öÎÊÌâ£¬¸²¸Ç 130+ Ô´ÎÄ¼ş£¬ÎŞ CI ÃÅ½ûÒâÎ¶×ÅÕâĞ©ÎÊÌâ½«³ÖĞø´æÔÚÉõÖÁ¶ñ»¯¡£
- TypeScript ÑÏ¸ñÄ£Ê½£¨tsconfig.base.json:8-23 µÄ strict¡¢noUncheckedIndexedAccess¡¢exactOptionalPropertyTypes£©½öÔÚ npm run typecheck ÖĞ¶Ô crish-desktop Ö´ĞĞ£¬ÆäËû 9 ¸ö¹¤×÷¿Õ¼ä°üµÄÀàĞÍ°²È«²»ÑéÖ¤¡£Èç¹ûÒ»¸ö¿ª·¢ÕßĞŞ¸ÄÁË @crish/shared-types ÖĞµÄºËĞÄÀàĞÍ¶¨Òå²¢ÒıÈëÁËÀàĞÍ´íÎó£¬Õâ¸ö´íÎóÖ»ÓĞÔÚ crish-desktop µÄ tsc ²½ÖèÖĞ²Å¿ÉÄÜ±»·¢ÏÖ¡ª¡ªµ«Ç°ÌáÊÇ crish-desktop Ê¹ÓÃÁË¸ÃÀàĞÍ¡£

**ÖĞ·çÏÕ**£º
- eslint.config.js µÄ react-refresh/only-export-components ¹æÔò£¨eslint.config.js:65-68£©ºÍ no-restricted-syntax ¹æÔò£¨eslint.config.js:69-76£©½öÔÚ±¾µØ pre-commit ´¥·¢£¬CI ²»Ö´ĞĞ¡£Èç¹ûÄ³¿ª·¢ÕßÌø¹ıÁË pre-commit hook£¬ÕâĞ©¹æÔòÍêÈ«²»»á±»ÑéÖ¤¡£
- command-registry:check£¨apps/agent-workbench/package.json:12£©ÑéÖ¤ Tauri command ×¢²áÓëÊµÏÖµÄÒ»ÖÂĞÔ¡£Èç¹ûĞÂÔöµÄ Tauri command Íü¼Ç×¢²á£¬CI ²»»á·¢ÏÖ¡£
- check:store-types£¨package.json:56£©ÑéÖ¤ store ÖĞÎŞ as any Ä£Ê½£¬µ« CI ²»Ö´ĞĞ¡£store ÊÇÓ¦ÓÃ×´Ì¬µÄºËĞÄ£¬store ÖĞµÄÀàĞÍ²»°²È«»áÀ©É¢µ½ËùÓĞÊ¹ÓÃ¸Ã×´Ì¬µÄ×é¼ş¡£

**µÍ·çÏÕ**£º
- ÎŞ Visual Testing ÃÅ½û£¬UI »Ø¹éÎÊÌâ¿ÉÄÜ½øÈëÉú²ú¡£µ«ÓÉÓÚµ±Ç°ÏîÄ¿ÈÔ´¦ÓÚ 0.1.0 ½×¶ÎÇÒ UI ¿ìËÙµü´ú£¬ÊÓ¾õ²âÊÔµÄ ROI ¿ÉÄÜ²»¸ß¡£

### 5.3 Ğ­×÷Ğ§ÂÊ·çÏÕ

**¸ß·çÏÕ**£º
- CI ËéÆ¬»¯£¨Ö»²âÊÔ 1/7 ¸ö TS °ü£©µ¼ÖÂ PR ºÏ²¢ºóÆäËû°üµÄ´úÂëËğ»µ²»»á±»¼°Ê±·¢ÏÖ¡£ÀıÈç£¬ĞŞ¸Ä @crish/shared-types ºó£¬@crish/agent-runtime ºÍ @crish/agent-orchestrator µÄ²âÊÔ¾ù²»Ö´ĞĞ¡£Õâ¸öÎÊÌâµÄÎ£ÏÕÔÚÓÚ¡ª¡ª´íÎóÔÚ merge µ½ main Ö®ºó²Å¿ÉÄÜ±»ÆäËû¿ª·¢Õß·¢ÏÖ£¨µ±ËûÃÇ git pull ºóÔËĞĞ±¾µØ²âÊÔÊ±£©£¬´ËÊ±´íÎóµÄÌá½»ÒÑ¾­ÔÚ main ·ÖÖ§ÉÏ£¬ĞŞ¸´ĞèÒª¶îÍâµÄ revert commit¡£
- ÎŞ¾ØÕó²âÊÔµ¼ÖÂ²»Í¬ OS/Node °æ±¾µÄ¼æÈİĞÔÎÊÌâÖ±µ½ÓÃ»§±¨¸æ²Å±»·¢ÏÖ¡£ÀıÈç£¬Node 20 µÄ ESM ½âÎöĞĞÎªÓë Node 22 ²»Í¬£¬Windows ÉÏµÄÂ·¾¶·Ö¸ô·û¿ÉÄÜµ¼ÖÂ esbuild µÄ --outfile Â·¾¶´íÎó¡£

**ÖĞ·çÏÕ**£º
- ¹¹½¨²»Ê¹ÓÃ turbo »º´æ£¬Ã¿´Î CI È«Á¿¹¹½¨ build:packages£¬ÀË·ÑÔ¼ 2-3 ·ÖÖÓ¡£¶ÔÓÚÒ»Ìì 20 ´Î PR ÍÆËÍµÄÏîÄ¿£¬ÕâÏàµ±ÓÚÃ¿ÌìÀË·Ñ 40-60 ·ÖÖÓµÄ CI Ê±¼ä¡£
- ÎŞ¼¯³É²âÊÔÖ´ĞĞ£¬¿ç°üÆõÔ¼±ä¸üµÄ·çÏÕ²»¿É¼û¡£ÒÀÀµÁ´ @crish/agent-orchestrator -> @crish/agent-runtime£¨packages/agent-orchestrator/package.json:31£©ºÍ @crish/agent-daemon -> @crish/agent-orchestrator£¨packages/agent-daemon/package.json:33£©µÄ¶ÏÁÑ²»»á±»ÔçÆÚ·¢ÏÖ¡£

**µÍ·çÏÕ**£º
- Visual testing ºÍ benchmark ½á¹ûµÄÈ±Ê§Ö÷ÒªÓ°Ïì·¢²¼Ç°µÄĞÅĞÄ¶È£¬¶ÔÈÕ³£¿ª·¢Ğ§ÂÊÓ°ÏìÓĞÏŞ¡£

## 6 ¾ßÌå´úÂëÖ¤¾İË÷Òı

ÒÔÏÂ°´ÎÄ¼şÂ·¾¶ºÍĞĞºÅÁĞ³ö±¾ÎÄÒıÓÃµÄËùÓĞ¹Ø¼üÖ¤¾İµã£º

| ÎÄ¼ş | ĞĞºÅ | ÄÚÈİ¸ÅÒª |
|------|------|----------|
| package.json | 2 | °æ±¾ 0.1.0 ±íÃ÷ÔçÆÚ½×¶Î |
| package.json | 7-16 | npm workspaces 10 ¸ö°ü¶¨Òå |
| package.json | 17-67 | È«²¿ 50 Ìõ script ¶¨Òå |
| package.json | 24 | build:shared-types Èë¿Ú |
| package.json | 25 | build:runtime Èë¿Ú |
| package.json | 26 | build:orchestrator Èë¿Ú |
| package.json | 27 | build:packages ¾ÛºÏÃüÁî |
| package.json | 28 | build:daemon Èë¿Ú |
| package.json | 29 | build:daemon-binary Èë¿Ú |
| package.json | 30 | build:product ×îÖÕ²úÎïÃüÁî |
| package.json | 49 | perf:all ¾ÛºÏĞÔÄÜÃüÁî |
| package.json | 50 | check:core ¾ÛºÏ check ÃüÁî |
| package.json | 54 | typecheck Ö» cover crish-desktop |
| package.json | 56 | check:store-types ´æÔÚµ«²» CI Ö´ĞĞ |
| package.json | 57 | test:core ¶¨Òå |
| package.json | 58 | test:desktop-helpers ¶¨Òå |
| package.json | 59 | test È«²¿²âÊÔ |
| package.json | 60 | test:coverage ´ø¸²¸ÇÂÊ |
| package.json | 61 | test:integration ¼¯³É²âÊÔÅäÖÃ |
| package.json | 62 | lint:all ÑÏ¸ñÄ£Ê½ |
| package.json | 64 | lint ¿íËÉÄ£Ê½ |
| package.json | 65 | check:all ÍêÕûÖÊÁ¿ÃÅ½û |
| package.json | 66-67 | format / format:write |
| package.json | 69-86 | devDependencies º¬ 18 ¸ö¹¤¾ßÁ´°ü |
| package.json | 73 | dependency-cruiser Î´ÔÚ CI Ê¹ÓÃ |
| package.json | 88-93 | Éú²úÒÀÀµ 6 ¸ö°ü |
| turbo.json | 3-30 | pipeline 7 ¸öÈÎÎñ¶¨Òå |
| turbo.json | 6 | outputs: dist/** + .tsbuildinfo »º´æÉùÃ÷ |
| tsconfig.base.json | 8-23 | strict Ä£Ê½ÒÑ¿ªÆô |
| tsconfig.base.json | 18-19 | noUnusedLocals/noUnusedParameters ¹Ø±Õ |
| tsconfig.base.json | 22 | noUncheckedIndexedAccess ¿ªÆô |
| tsconfig.base.json | 23 | exactOptionalPropertyTypes ¿ªÆô |
| vitest.config.ts | 7-16 | include ¸²¸Ç packages + apps |
| vitest.config.ts | 13-16 | coverage ÅäÖÃ v8, text/json/html ±¨¸æ |
| apps/crish-desktop/vitest.config.ts | 13-18 | ¸²¸ÇÂÊãĞÖµ 70/60/65/70 |
| eslint.config.js | 9-21 | ignores ÁĞ±íº¬ 11 ÖÖÄ¿Â¼ |
| eslint.config.js | 55-57 | Frontend rules crish-desktop + agent-workbench |
| eslint.config.js | 65-68 | react-refresh/only-export-components |
| eslint.config.js | 69-76 | no-restricted-syntax Object.assign ½ûÖ¹ |
| .lintstagedrc.json | 1-5 | lint-staged ts/css/json ÅäÖÃ |
| .husky/pre-commit | 1 | npx lint-staged |
| .husky/pre-push | 1 | npm run typecheck && npm test |
| packages/agent-daemon/package.json | 25-28 | build ÈıÔª×é clean - types - js |
| packages/agent-daemon/package.json | 26 | tsc-alias ºó´¦Àí |
| packages/agent-daemon/package.json | 33 | ÒÀÀµ daemon -> orchestrator |
| packages/shared-types/package.json | 25-28 | ±ê×¼ build Ä£Ê½ |
| packages/shared-utils/package.json | 46-49 | ¶àÈë¿Ú esbuild£¨browser + node + Ä¬ÈÏ£© |
| packages/agent-orchestrator/package.json | 31 | ÒÀÀµ orchestrator -> runtime |
| packages/agent-daemon/package.json | 39 | @modelcontextprotocol/sdk ÒÀÀµ |
| apps/agent-workbench/package.json | 9 | build ÖØ¶¨Ïòµ½ crish-desktop |
| apps/agent-workbench/package.json | 12 | cli:check + command-registry:check |
| apps/crish-desktop/package.json | 10 | build = tsc -b && vite build |
| apps/crish-desktop/package.json | 13 | qa:check 4 ÏîÖÊÁ¿¼ì²é |
| apps/crish-desktop/package.json | 16-17 | Playwright visual test |
| Cargo.toml | 2-15 | Rust workspace 12 ¸ö crate |
| Cargo.toml | 60-66 | workspace.package ÔªÊı¾İ |
| Cargo.toml | 68-82 | workspace.dependencies ¹«¹²ÒÀÀµ |
| crates/conex-stream/Cargo.toml | 1-21 | Ê¾Àı crate ÅäÖÃ |
| crates/conex-stream/Cargo.toml | 13-18 | criterion benchmark ÅäÖÃ |
| .github/dependabot.yml | 1-25 | dependabot npm + cargo |
| .github/dependabot.yml | 25 | ignore: conex-stream È±ÉÙÔ­Òò |
| .github/workflows/ci.yml | 13-42 | rust-check ÈıÆ½Ì¨ |
| .github/workflows/ci.yml | 30 | Swatinem/rust-cache |
| .github/workflows/ci.yml | 39 | cargo test --workspace |
| .github/workflows/ci.yml | 44-65 | rust-stream-test ¶ÀÁ¢ |
| .github/workflows/ci.yml | 66-88 | ts-check Ö» cover agent-runtime |
| .github/workflows/ci.yml | 79 | npx tsc --noEmit agent-runtime |
| .github/workflows/ci.yml | 81-82 | Provider tests |
| .github/workflows/ci.yml | 84-85 | Model catalog tests || true |
| .github/workflows/ci.yml | 87-88 | Fallback chain tests || true |
| .github/workflows/ci.yml | 90-114 | provider-json-validate |
| .github/workflows/ci.yml | 117-134 | security-audit continue-on-error |
| .github/workflows/ci.yml | 136-148 | ESLint ½ö provider ×ÓÄ¿Â¼ |
| .github/workflows/ci.yml | 150-167 | coverage ÎŞãĞÖµÑéÖ¤ |
| .github/workflows/ci.yml | 169-181 | e2e ½ö provider |
| .github/workflows/ci.yml | 184-197 | bench-rust || true |
| .github/workflows/ci.yml | 199-209 | bench-ts || true |
| .github/workflows/perf-test.yml | 1-137 | ĞÔÄÜ²âÊÔÎŞ Node ¾ØÕó |
| .github/workflows/release.yml | 1-67 | ·¢²¼Á÷Ë®Ïß |
| .github/workflows/release.yml | 23 | Node 20 Âäºó |
| .github/workflows/release.yml | 37 | build:packages ·Ç build:product |
| .github/workflows/release.yml | 61 | generate_release_notes: true |
| vitest.setup.ts | 1-44 | browser È«¾Ö²¹Æë |

## Êı¾İ×ÜÀÀ

- ÏîÄ¿×Ü°üÊı£ºnpm workspaces 10 + Rust workspace 12 = 22 ¸ö¿É¹¹½¨µ¥Ôª
- CI ÖĞÊµ¼ÊÖ´ĞĞµÄ TS ×Ó°üÊı£º1£¨agent-runtime µÄ provider ×ÓÄ¿Â¼£©
- TypeScript ²âÊÔÎÄ¼ş£ºvitest.config.ts:8-11 ¶¨ÒåµÄ include Ä£Ê½¸²¸ÇÔ¼Êı°Ù¸ö²âÊÔÎÄ¼ş£¬CI ÖĞ½öÖ´ĞĞÔ¼ 3-5%
- ¹¹½¨ÃüÁîÊı£º¸ù package.json 50 Ìõ + ¸÷×Ó°üÔ¼ 30 Ìõ = Ô¼ 80 Ìõ¿ÉÖ´ĞĞÃüÁî
- CI ÖĞÊµ¼Ê´¥·¢µÄ¹¹½¨ÃüÁîÊı£ºÔ¼ 12 Ìõ£¨½öÕë¶Ô agent-runtime ºÍ Rust crate£©
- ·¢²¼ÖÆÆ·ÀàĞÍ£ºnpm °ü£¨6 ¸ö£©¡¢Tauri ×ÀÃæ°²×°°ü£¨3 Æ½Ì¨£©¡¢daemon ¶ş½øÖÆ£¨Î´ÄÉÈë CI£©
- ÏÖÓĞ workflow Êı£º4£¨ci.yml 209 ĞĞ, perf-test.yml 137 ĞĞ, provider-validation.yml 83 ĞĞ, release.yml 67 ĞĞ£©

## 7 ÖğÎÄ¼ş CI ¸²¸Ç¶ÈÉó¼Æ

±¾½Ú¶ÔÏîÄ¿Ã¿¸ö¿É¹¹½¨µ¥ÔªÔÚ CI ÖĞµÄ¸²¸Ç¶È½øĞĞÖğÎÄ¼şÉó¼Æ¡£

### 7.1 ¸ù package.json ½Å±¾¸²¸Ç¶È

¸ù package.json ¶¨ÒåÁË 50 Ìõ script£¨package.json:17-67£©£¬ÏÖÖğÌõÉó¼Æ CI ¸²¸ÇÇé¿ö£º

| Script | ĞĞºÅ | ¹¦ÄÜ | CI Ö´ĞĞ? | Ö´ĞĞÎ»ÖÃ |
|--------|------|------|----------|----------|
| prepare | 18 | husky install | ·ñ | N/A£¨CI ÖĞ npm ci ×Ô¶¯´¦Àí£© |
| dev:desktop | 19 | ¿ª·¢·şÎñÆ÷ | N/A | ²»ĞèÒª CI |
| dev:workbench | 20 | Tauri dev | N/A | ²»ĞèÒª CI |
| dev:cli | 21 | CLI dev | N/A | ²»ĞèÒª CI |
| build:desktop | 22 | desktop ¹¹½¨ | ·ñ | N/A |
| build:workbench | 23 | workbench ¹¹½¨ | ·ñ | N/A |
| build:shared-types | 24 | shared-types ¹¹½¨ | ·ñ | N/A |
| build:runtime | 25 | runtime ¹¹½¨ | ·ñ | N/A |
| build:orchestrator | 26 | orchestrator ¹¹½¨ | ·ñ | N/A |
| build:packages | 27 | ¾ÛºÏ¹¹½¨ | ²¿·Ö | release.yml:37 |
| build:daemon | 28 | daemon ¹¹½¨ | ·ñ | N/A |
| build:daemon-binary | 29 | daemon ¶ş½øÖÆ | ·ñ | N/A |
| build:product | 30 | ×îÖÕ²úÎï | ·ñ | N/A |
| cli | 31 | CLI ±ğÃû | N/A | ²»ĞèÒª CI |
| daemon | 32 | daemon ¿ª·¢ | N/A | ²»ĞèÒª CI |
| daemon:dist | 33 | daemon ¶ş½øÖÆÔËĞĞ | N/A | ²»ĞèÒª CI |
| bench:daemon | 34 | daemon »ù×¼ | ·ñ | N/A |
| bench | 35 | TS »ù×¼ | ²¿·Ö | perf-test.yml:28 |
| bench:mem | 36 | ÄÚ´æ»ù×¼ | ²¿·Ö | perf-test.yml:31 |
| bench:ci | 37 | CI »ù×¼¾ÛºÏ | ·ñ | N/A |
| bench:acceptance | 38 | ½ÓÊÜ¶È»ù×¼ | ²¿·Ö | perf-test.yml:37 |
| bench:native-sla | 39 | Ô­Éú»ù×¼ | ·ñ | N/A |
| bench:native | 40 | Ô­Éú»ù×¼±ğÃû | ·ñ | N/A |
| bench:report | 41 | »ù×¼±¨¸æ | ²¿·Ö | perf-test.yml:40 |
| stress | 42 | Ñ¹Á¦²âÊÔ | ²¿·Ö | perf-test.yml:60 |
| stress:ai | 43 | AI Á÷Ñ¹Á¦ | ·ñ | N/A |
| stress:diff | 44 | diff Ñ¹Á¦ | ·ñ | N/A |
| stress:session | 45 | session ÇĞ»»Ñ¹Á¦ | ·ñ | N/A |
| startup:cold | 46 | ÀäÆô¶¯²âÁ¿ | ·ñ | N/A |
| startup:warm | 47 | ÈÈÆô¶¯²âÁ¿ | ·ñ | N/A |
| perf:all | 48 | ĞÔÄÜÈ«Á¿ | ·ñ | N/A |
| check:core | 50 | ºËĞÄÀàĞÍ¼ì²é | ·ñ | N/A |
| check:runtime | 51 | runtime ÀàĞÍ¼ì²é | ²¿·Ö | ci.yml:79 |
| check:orchestrator | 52 | orchestrator ÀàĞÍ¼ì²é | ·ñ | N/A |
| check:daemon | 53 | daemon ÀàĞÍ¼ì²é | ·ñ | N/A |
| check:workbench | 54 | workbench ¼ì²é | ·ñ | N/A |
| typecheck | 55 | desktop ÀàĞÍ¼ì²é | ·ñ | N/A |
| check:desktop | 56 | desktop ¼ì²é | ·ñ | N/A |
| check:store-types | 57 | store ÀàĞÍ°²È« | ·ñ | N/A |
| test:core | 58 | ºËĞÄ²âÊÔ | ·ñ | N/A |
| test:desktop-helpers | 59 | desktop ²âÊÔ | ·ñ | N/A |
| test | 60 | È«²¿²âÊÔ | ²¿·Ö | ci.yml:81-88 |
| test:coverage | 61 | ´ø¸²¸ÇÂÊ²âÊÔ | ²¿·Ö | ci.yml:162 |
| test:integration | 62 | ¼¯³É²âÊÔ | ·ñ | N/A |
| lint:all | 63 | ÑÏ¸ñ lint | ·ñ | N/A |
| lint:css | 64 | CSS lint | ·ñ | N/A |
| lint | 65 | ¿íËÉ lint | ²¿·Ö | ci.yml:148 |
| check:all | 66 | ÍêÕûÖÊÁ¿ÃÅ½û | ·ñ | N/A |
| format | 67 | prettier --check | ·ñ | N/A |
| format:write | 68 | prettier --write | N/A | ²»ĞèÒª CI |

×Ü¼Æ£º50 Ìõ script ÖĞ£¬CI ¸²¸ÇÔ¼ 12 Ìõ£¨24%£©£¬ÆäÖĞ 5 ÌõÊ¹ÓÃ || true ¾²Ä¬Ä£Ê½¡£ºËĞÄ¹¹½¨¹¹½¨Á´ build:product£¨6 ¸ö×ÓÃüÁî£©ÍêÈ«Î´ÔÚ CI ÖĞÖ´ĞĞ¡£

### 7.2 ×Ó°ü package.json ½Å±¾¸²¸Ç¶È

| °ü | ½Å±¾Êı | CI ¸²¸Ç | ¸²¸Ç¶È |
|----|--------|---------|--------|
| packages/agent-runtime | 4 | ÀàĞÍ¼ì²é + ²âÊÔ | 50% |
| packages/agent-daemon | 7 | ÎŞ | 0% |
| packages/shared-types | 4 | ÎŞ | 0% |
| packages/shared-utils | 7 | ÎŞ | 0% |
| packages/decision-engine | 4 | ÎŞ | 0% |
| packages/agent-orchestrator | 4 | ÎŞ | 0% |
| apps/crish-desktop | 8 | ÎŞ | 0% |
| apps/agent-workbench | 6 | ÎŞ | 0% |

### 7.3 TypeScript ÎÄ¼şÀàĞÍ¼ì²é¸²¸Ç¶È

ÏîÄ¿ TS ÎÄ¼ş·Ö²¼Óë CI ÀàĞÍ¼ì²é¸²¸Ç£º

| Ä¿Â¼ | tsconfig | tsc ÔÚ CI? | ĞĞÊı£¨¹À£© |
|------|----------|-----------|-----------|
| apps/crish-desktop/ | apps/crish-desktop/tsconfig.json | ·ñ | ~20000 |
| apps/agent-workbench/ | apps/agent-workbench/tsconfig.json | ·ñ | ~5000 |
| packages/shared-types/ | packages/shared-types/tsconfig.build.json | ·ñ | ~3000 |
| packages/shared-utils/ | packages/shared-utils/tsconfig.build.json | ·ñ | ~4000 |
| packages/decision-engine/ | packages/decision-engine/tsconfig.build.json | ·ñ | ~2000 |
| packages/agent-runtime/ | packages/agent-runtime/tsconfig.json | ²¿·Ö£¨--noEmit£© | ~15000 |
| packages/agent-orchestrator/ | packages/agent-orchestrator/tsconfig.build.json | ·ñ | ~5000 |
| packages/agent-daemon/ | packages/agent-daemon/tsconfig.build.json | ·ñ | ~3000 |

Ö»ÓĞÔ¼ 15% µÄ TS ´úÂëÔÚ CI ÖĞ½ÓÊÜÁËÀàĞÍ¼ì²é¡£

### 7.4 Rust crate ²âÊÔ¸²¸Ç¶È

Cargo.toml:2-15 ¶¨ÒåµÄ 12 ¸ö crate ÔÚ CI ÖĞµÄ¸²¸Ç£º

| Crate | cargo test | cargo clippy | cargo fmt | ¶ÀÁ¢²âÊÔ |
|-------|-----------|-------------|-----------|----------|
| conex-stream | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | all-features |
| conex-ipc | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-types | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-net | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-db | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-search | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-compaction | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-sandbox | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-diff | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-fs | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| conex-http | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |
| tauri-app | workspace ¼¶ | workspace ¼¶ | workspace ¼¶ | ·ñ |

Rust ¸²¸Ç¶ÈÃ÷ÏÔ¸üºÃ£ºÍ¨¹ı workspace ¼¶ÃüÁî¸²¸ÇÈ«²¿ 12 ¸ö crate¡£Ö÷ÒªÎÊÌâÊÇ cargo test --workspace ²»°üº¬ --all-features£¬ÇÒ benchmark ¾²Ä¬¡£

## 8 Cargo ÒÀÀµÍØÆË

Cargo.toml:68-82 ¶¨ÒåÁË workspace ¼¶¹«¹²ÒÀÀµ£º
- serde + serde_json£¨ĞòÁĞ»¯£©
- anyhow£¨´íÎó´¦Àí£©
- thiserror£¨´íÎó derive£©
- tokio£¨Òì²½ÔËĞĞÊ±£¬features = [full]£©
- reqwest£¨HTTP ¿Í»§¶Ë£¬rustls-tls£©
- tauri + tauri-build£¨×ÀÃæ¿ò¼Ü£©
- rusqlite + r2d2 + r2d2_sqlite£¨Êı¾İ¿â£©
- notify£¨ÎÄ¼şÏµÍ³¼à¿Ø£©
- similar£¨diff ÒıÇæ£©
- derive_builder£¨Builder Ä£Ê½£©

ÕâĞ©ÒÀÀµÖĞÓĞ 4 ¸ö£¨reqwest, notify, rusqlite, tauri£©±àÒëÁ´½Óµ½ÏµÍ³¿â£¬CI ÖĞµÄ Rust ¹¤×÷Á÷ĞèÒªÈ·±£ÕâĞ©ÏµÍ³ÒÀÀµÔÚ Windows/macOS/Linux ÈıÆ½Ì¨¶¼¿ÉÓÃ¡£µ±Ç° rust-check job ÔÚ windows-latest ÉÏÔËĞĞ cargo check Ê±£¬rusqlite µÄ bundled feature È·±£ SQLite ±»¾²Ì¬±àÒë£¬µ« tauri ÔÚ·Ç Linux Æ½Ì¨¿ÉÄÜÈ±ÉÙÄ³Ğ©ÏµÍ³¿â¡£ÕâĞ©Ç±ÔÚÎÊÌâµ±Ç°Î´±» CI ¼ì²â¡£

## 9 ¹¹½¨Ê±¼äÓë³É±¾¹ÀËã

»ùÓÚµ±Ç°´úÂë¹æÄ£ºÍ CI ÅäÖÃ£¬¹ÀËã¸÷ CI ³¡¾°µÄÊ±¼ä£º

**µ±Ç° PR CI Ê±¼ä**£¨ci.yml ÏÖÓĞ job µÄ²¢ĞĞÖ´ĞĞ£©£º
- rust-check£¨3 Æ½Ì¨²¢ĞĞ£©: ~5 min
- ts-check: ~3 min£¨Ö»ÓĞ agent-runtime µÄ tsc + provider ²âÊÔ£©
- lint: ~1 min£¨Ö»ÓĞ provider µÄ eslint£©
- coverage: ~2 min£¨Ö»ÓĞ provider µÄ²âÊÔ£©
- e2e: ~2 min£¨Ö»ÓĞ provider e2e£©
- security-audit: ~2 min
- ×Ü¼Æ£¨´®ĞĞ»¯ºó×î³¤Â·¾¶£©: ~8 min

**¸Ä½øºó PR CI Ê±¼ä**£¨ÔöÁ¿Ä£Ê½£©£º
- detect-changes: ~30s
- turbo restore cache: ~30s
- ÔöÁ¿ build: ~30s-2min£¨È¡¾öÓÚ±ä¸ü·¶Î§£©
- ÔöÁ¿ typecheck: ~1-3min
- ÔöÁ¿ lint: ~30s-1min
- ÔöÁ¿ test + coverage: ~2-5min
- Rust check: ~5min£¨Óë TS ²¢ĞĞ£©
- ×Ü¼Æ£¨×î³¤Â·¾¶£©: ~5-8min£¨Óëµ±Ç°Ïà½ü£¬µ«¸²¸Ç¶È¸ß 5 ±¶£©

**¸Ä½øºó main CI Ê±¼ä**£¨È«Á¿Ä£Ê½£©£º
- turbo run build: ~3min
- typecheck all: ~5min
- lint:all: ~2min
- test:coverage: ~5min
- test:integration: ~5min£¨º¬ e2e£©
- Rust full: ~6min
- security-audit + secret-scan: ~3min
- ×Ü¼Æ£¨ÊÜÏŞÓÚ×î³¤´®ĞĞÂ·¾¶£©: ~15-20min

## 10 ²Î¿¼¹¤³ÌÊµ¼ù¶Ô±È

ÒÔÏÂ¶Ô±È»ùÓÚ³ÉÊìÏîÄ¿µÄ CI/CD ×î¼ÑÊµ¼ù£º

| Êµ¼ù | ĞĞÒµ×î¼Ñ | conex ÏÖ×´ | ²î¾à |
|------|----------|-----------|------|
| PR ×Ô¶¯»¯²âÊÔ | ËùÓĞ PR ×Ô¶¯ÔËĞĞÏà¹Ø²âÊÔ | Ö»ÔËĞĞ agent-runtime ×Ó¼¯²âÊÔ | ÑÏÖØ |
| ²âÊÔ¾ØÕó | Node µ±Ç° + ÉÏÒ»¸ö LTS | µ¥ Node °æ±¾ | ÖĞµÈ |
| OS ¼æÈİĞÔ | Linux + Windows + macOS | ½ö Linux£¨TS£©/ ÈıÆ½Ì¨£¨Rust£© | ÖĞµÈ |
| ¹¹½¨»º´æ | Ô¶³Ì»º´æ + ÔöÁ¿¹¹½¨ | ÎŞ TS »º´æ | ÑÏÖØ |
| Lint ÃÅ½û | zero-warning ×è¶Ï | ×ÓÄ¿Â¼ lint ¾²Ä¬ | ÑÏÖØ |
| ¸²¸ÇÂÊÃÅ½û | ãĞÖµÓ²ĞÔ×è¶Ï | ÓĞ¶¨Òå²»Ö´ĞĞ | ÑÏÖØ |
| °²È«É¨Ãè | ¶¨Ê± + PR ×è¶Ï | continue-on-error | ÑÏÖØ |
| ÃÜÔ¿É¨Ãè | Ìá½»Ç° + CI ÖĞ | ÎŞ | ÑÏÖØ |
| ÒÀÀµÉı¼¶ | ×Ô¶¯»¯ + ×Ô¶¯ºÏ²¢ | Dependabot ÅäÖÃ | Á¼ºÃ |
| °æ±¾¹ÜÀí | changesets / release-please | ÊÖ¶¯ | ÑÏÖØ |
| ·¢²¼Á÷Ë®Ïß | npm publish + GH Release + Docker | ½ö GH Release£¨Tauri£© | ÑÏÖØ |
| ·¢²¼Ç°ÑéÖ¤ | dry-run + check list | ÎŞ | ÑÏÖØ |
| ĞÔÄÜÇ÷ÊÆ | »ùÏß + ÍË»¯×è¶Ï | ÎŞ³Ö¾Ã»¯ | ÖĞµÈ |
| ¹¹½¨Ê§°Ü¸æ¾¯ | ¼´Ê±Í¨Ñ¶Í¨Öª | Ä¬ÈÏÓÊ¼ş | µÍ |
| SBOM | Ã¿´Î·¢²¼Éú³É | ÎŞ | ÖĞµÈ |

## 11 ×ÓÏî·ÖÀà»ã×ÜÓëÑÏÖØ¶È¾ØÕó

### 11.1 °´ÑÏÖØ¶È·ÖÀà

| ÑÏÖØ¶È | ÊıÁ¿ | ÃèÊö |
|--------|------|------|
| P0 - ÑÏÖØ×è¶Ï | 12 | ¾²Ä¬ÍÌÊ§°Ü¡¢ÎŞ npm publish¡¢ÎŞÈËÃÜÔ¿É¨Ãè¡¢¸²¸ÇÂÊ²»ÑéÖ¤µÈ |
| P1 - ¸ß·çÏÕ | 18 | ÎŞ¾ØÕó²âÊÔ¡¢ÎŞ¼¯³É²âÊÔ¡¢eslint ·¶Î§¹ıÕ­¡¢·¢²¼ÎŞ¸ÉÔËĞĞµÈ |
| P2 - ÖĞ·çÏÕ | 15 | ÎŞÊÓ¾õ²âÊÔ¡¢»ù×¼ÎŞ¶ÏÑÔ¡¢ÎŞ Docker ¾µÏñ¡¢ÎŞ SBOM µÈ |
| P3 - µÍ·çÏÕ | 8 | ÎŞ¹¹½¨Ê±¼ä¼à¿Ø¡¢ÎŞ²âÊÔºÄÊ±»ùÏß¡¢node °æ±¾ÅäÖÃ¹ıÊ±µÈ |

### 11.2 P0 ÑÏÖØ×è¶ÏÏîÇåµ¥

1. ci.yml:85 || true ¾²Ä¬ÍÌÊÉ model catalog ²âÊÔÊ§°Ü
2. ci.yml:88 || true ¾²Ä¬ÍÌÊÉ fallback chain ²âÊÔÊ§°Ü
3. ci.yml:134 continue-on-error: true Ê¹ npm audit ²»×è¶Ï
4. ci.yml:123 continue-on-error: true Ê¹ cargo audit ²»×è¶Ï
5. ci.yml:148 || echo "ESLint check skipped" Ê¹ lint ²»×è¶Ï
6. ci.yml:166 ¸²¸ÇÂÊ²½Öè²»×öãĞÖµ±È½Ï£¨Write-Host ÎŞÊµ¼ÊÑéÖ¤£©
7. ·¢²¼Á÷Ë®ÏßÈ±Ê§ npm publish£¨6 ¸ö @crish/* °üÎŞ·¨·¢²¼£©
8. ÎŞÃÜÔ¿É¨Ãè£¨AI Agent ¹¤×÷Ä¿Â¼ API key Ğ¹Â¶²»¿É¸ĞÖª£©
9. ÎŞ daemon ¶ş½øÖÆ¹¹½¨·¢²¼£¨build:daemon-binary ´ÓÎ´ÔÚ CI Ö´ĞĞ£©
10. ÎŞÈ«Á¿ÀàĞÍ¼ì²é£¨6/7 ¸ö TS °üÁãÀàĞÍ°²È«ÑéÖ¤£©
11. pre-push hook Ö´ĞĞ e2e ²âÊÔµ¼ÖÂ±¾µØÆµ·±Ìø¹ı
12. release.yml:23 Ê¹ÓÃ Node 20£¨ÓëÏîÄ¿ @types/node ^25.6.0 ²»Æ¥Åä£©

### 11.3 P1 ¸ß·çÏÕÏîÇåµ¥

1. ²âÊÔËéÆ¬»¯£ºÖ»Ö´ĞĞ 1/7 TS °üµÄ provider ×ÓÄ¿Â¼²âÊÔ
2. ÎŞ OS ¾ØÕó£¨TS ²¿·Ö½ö linux£©
3. ÎŞ Node °æ±¾¾ØÕó
4. ÎŞ¼¯³É²âÊÔÖ´ĞĞ
5. ÎŞ E2E ²âÊÔ¸²¸Ç¿ç°ü¼¯³É
6. lint ·¶Î§¹ıÕ­£ºÖ» cover agent-runtime/provider
7. ci.yml:79 tsc --noEmit Ö» cover agent-runtime
8. ¹¹½¨²»Ê¹ÓÃ turbo »º´æ
9. ÔöÁ¿¹¹½¨ÄÜÁ¦ÍêÈ«Î´ÀûÓÃ
10. ÎŞ build:daemon-binary µÄ CI ¹¹½¨
11. ÎŞ Vite build µÄ CI ¹¹½¨£¨apps/crish-desktop£©
12. ÎŞ qa:check µÄ CI Ö´ĞĞ£¨¶Ô»°²»±äÁ¿¡¢stress fuzzing¡¢È«³¡¾°Á÷³Ì£©
13. ¸²¸ÇÂÊãĞÖµ 70/60/65/70 ÍêÈ«Î´ÔÚ CI ÑéÖ¤
14. °æ±¾¹ÜÀíÍêÈ«ÊÖ¶¯£¨È«²¿Ó²±àÂë 0.1.0£©
15. ÎŞ·¢²¼Ç°¸ÉÔËĞĞ
16. ÎŞ Changelog Éú³É
17. ÒÀÀµºÏ¹æ£¨depcruise£©Î´Ê¹ÓÃ
18. ²¢·¢¿ØÖÆÈ±Ê§£¨ci.yml, perf-test.yml£©

### 11.4 ÈÈÁ¦Í¼£¨°´ÎÄ¼ş£©

¼¯ÖĞÁË×î¶àÎÊÌâµÄÎÄ¼ş£º
- .github/workflows/ci.yml: 15 ¸ö¶ÀÁ¢ÎÊÌâ£¨ËéÆ¬»¯²âÊÔ¡¢¾²Ä¬Ä£Ê½¡¢ÎŞ»º´æ¡¢ÎŞ¾ØÕóµÈ£©
- package.json: 8 ¸öÎÊÌâ£¨½Å±¾Î´ÔÚ CI Ê¹ÓÃ¡¢¹¹½¨Á´²»ÍêÕûµÈ£©
- .github/workflows/release.yml: 5 ¸öÎÊÌâ£¨npm publish È±Ê§¡¢daemon È±Ê§µÈ£©
- .husky/pre-push: 2 ¸öÎÊÌâ£¨¸²¸Ç·¶Î§Õ­¡¢e2e ³¬Ê±£©
- packages/agent-daemon/package.json: 3 ¸öÎÊÌâ£¨build:types ²»Çå cache¡¢ÒÀÀµÁ´Î´ÑéÖ¤µÈ£©

## 12 ¸½Â¼£ºÊõÓï¶ÔÕÕ

| ÊõÓï | º¬Òå |
|------|------|
| CI/CD | Continuous Integration / Continuous Delivery |
| turbo | npm workspace ¹¹½¨±àÅÅ¹¤¾ß£¬Ö§³Ö»º´æºÍÔöÁ¿¹¹½¨ |
| esbuild | JavaScript/TypeScript ´ò°ü¹¤¾ß£¨Go ±àĞ´£© |
| tsc-alias | TypeScript Â·¾¶±ğÃû½âÎö¹¤¾ß |
| ESLint | ´úÂëÖÊÁ¿¼ì²é¹¤¾ß |
| Vitest | µ¥Ôª²âÊÔ¿ò¼Ü£¨Vite ÉúÌ¬£© |
| Playwright | ä¯ÀÀÆ÷¶Ëµ½¶Ë²âÊÔ¿ò¼Ü |
| dependency-cruiser | ÒÀÀµ¹ØÏµÑéÖ¤¹¤¾ß |
| Stylelint | CSS ´úÂëÖÊÁ¿¼ì²é¹¤¾ß |
| Prettier | ´úÂë¸ñÊ½»¯¹¤¾ß |
| Husky | Git hooks ¹ÜÀí¹¤¾ß |
| lint-staged | Ö»¶Ô staged ÎÄ¼şÔËĞĞ lint |
| Prettier | ´úÂë¸ñÊ½»¯¹¤¾ß |
| OIDC | OpenID Connect£¬GitHub Actions ÓÃÓÚÎŞÃÜÔ¿·¢²¼ |
| SBOM | Software Bill of Materials£¬Èí¼şÎïÁÏÇåµ¥ |
| Rust Crate | Rust °ü |
| npm workspace | npm ¶à°ü¹ÜÀíÄ£Ê½ |
| Tauri | ¿çÆ½Ì¨×ÀÃæÓ¦ÓÃ¿ò¼Ü£¨Rust + Web Ç°¶Ë£© |
| OIDC trusted publishing | GitHub Actions ÎŞÃÜÔ¿ npm ·¢²¼ |
| Cargo.toml | Rust °üÃèÊöÎÄ¼ş |
| .github/workflows/ | GitHub Actions ¹¤×÷Á÷Ä¿Â¼ |

## 13 å…¸å‹å¤±è´¥åœºæ™¯åˆ†æ

æœ¬èŠ‚æè¿°åœ¨å½“å‰?CI/CD ç¼ºå¤±æƒ…å†µä¸‹å¯èƒ½å‘ç”Ÿçš„å…¸å‹å¤±è´¥åœºæ™¯ï¼Œä»¥è¯´æ˜æ¯ä¸ªå·®è·çš„å®é™…å½±å“ã€?
### åœºæ™¯ 1ï¼šå…±äº«ç±»å‹ä¿®æ”¹å¯¼è‡´ä¸‹æ¸¸æ–­è£?
**è§¦å‘æ¡ä»¶**ï¼šå¼€å‘è€…ä¿®æ”?`packages/shared-types/src/index.ts`ï¼Œæ–°å¢äº†ä¸€ä¸ªå¿…å¡«å­—æ®µåˆ°æ ¸å¿ƒç±»å‹å®šä¹‰ã€?
**äº‹ä»¶é“?*ï¼?1. å¼€å‘è€…åœ¨æœ¬åœ°è¿è¡Œ `pre-push`ï¼Œ`npm run typecheck` åªæ£€æŸ?`crish-desktop`ï¼Œä¸” `crish-desktop` æœªä½¿ç”¨è¯¥ç±»å‹ï¼Œé€šè¿‡
2. `npm test` è¿è¡Œå…¨éƒ¨ vitest æµ‹è¯•ï¼Œä½† `ci.yml` ä¸­çš„ model catalog æµ‹è¯•ä½¿ç”¨ `|| true` é™é»˜æ¨¡å¼ï¼Œå³ä½¿å¤±è´¥ä¹Ÿä¸æŠ¥é”?3. PR è¢«åˆå¹¶åˆ° main
4. `@crish/agent-runtime` ä¸­ä½¿ç”¨äº†è¯¥ç±»å‹çš„åœ°æ–¹å› ä¸ºç¼ºå°‘æ–°å­—æ®µè€Œç¼–è¯‘å¤±è´¥ï¼Œä½?`ci.yml` çš?ts-check åªè¿è¡?`tsc --noEmit` æ£€æŸ?`agent-runtime`â€”â€”å¦‚æ?developer mode æ¡ä»¶æœªæ­£ç¡®è®¾ç½®ï¼Œç¼–è¯‘å¯èƒ½é€šè¿‡
5. ç›´åˆ° CI ä¸­å°è¯•è¿è¡?`@crish/agent-daemon` æ—¶ï¼ˆä¸‹æ¸¸åŒ…ï¼Œ`packages/agent-daemon/package.json:33` ä¾èµ– orchestratorï¼‰ï¼Œç±»å‹ä¸åŒ¹é…å¯¼è‡´è¿è¡Œæ—¶é”™è¯¯
6. ä½?CI ä¸è¿è¡?daemon æµ‹è¯•ï¼Œé”™è¯¯ç›´åˆ°ç”¨æˆ·æŠ¥å‘Šæ‰è¢«å‘ç?
**å®é™…åæœ**ï¼šè¿è¡Œæ—¶ TypeErrorï¼Œagent-daemon å´©æºƒï¼Œç”¨æˆ·æ— æ³•ä½¿ç”¨ã€‚ä»åˆå¹¶åˆ°å‘ç°å¯èƒ½é—´éš”æ•°å°æ—¶åˆ°æ•°å¤©ã€?
**æ¶‰åŠå·®è·**ï¼?- `ci.yml:79` åªæ£€æŸ?single package
- `ci.yml:85,88` çš?`|| true` æ¨¡å¼
- `package.json:54` çš?typecheck å?cover desktop
- `.husky/pre-push` å?cover desktop
- ç¼ºå°‘ `turbo run typecheck --filter` çš„ä¾èµ–é“¾ä¼ æ’­

### åœºæ™¯ 2ï¼šå®‰å…¨æ¼æ´è¿›å…?main

**è§¦å‘æ¡ä»¶**ï¼šnpm ç”Ÿæ€æŠ«éœ²äº†ä¸€ä¸?`ws` åŒ…çš„é«˜å± CVEï¼ˆ`package.json:93` ä¾èµ– `ws`ï¼‰ï¼Œç¤¾åŒºå·²ä¿®å¤å¹¶å‘å¸ƒè¡¥ä¸ã€?
**äº‹ä»¶é“?*ï¼?1. Dependabot è‡ªåŠ¨åˆ›å»ºäº†å‡çº?`ws` çš?PRï¼ˆ`dependabot.yml:6-14` é…ç½®äº†æ¯å‘¨æ£€æŸ¥ï¼‰
2. CI è¿è¡Œä½†ä¸éªŒè¯ npm auditâ€”â€”`ci.yml:133-134` çš?`continue-on-error: true` ä½?audit å¤±è´¥ä¸é˜»æ–?3. PR è¢«åˆå¹¶åˆ° main
4. ç”Ÿäº§ç¯å¢ƒè¿è¡Œçš?daemon ä½¿ç”¨æœ‰æ¼æ´çš„ `ws` ç‰ˆæœ¬
5. æ”»å‡»è€…å¯ä»¥åˆ©ç”?WebSocket æ¼æ´

**å®é™…åæœ**ï¼šå®‰å…¨æ€§å—æŸã€‚ç”±äº?CVE æŠ«éœ²åˆ°ä¿®å¤çš„æ—¶é—´çª—å£ï¼ˆé€šå¸¸ 7-14 å¤©ï¼‰ï¼Œé¡¹ç›®åœ¨æ­¤æœŸé—´ä¸è®¾é˜²ã€?
**æ¶‰åŠå·®è·**ï¼?- `ci.yml:133-134` çš?`continue-on-error: true`
- ç¼ºå°‘ `npm audit signatures` éªŒè¯
- ç¼ºå°‘ `npm run check:all` çš„å®‰å…¨å®¡è®?
### åœºæ™¯ 3ï¼šå‘å¸ƒå¤±è´?
**è§¦å‘æ¡ä»¶**ï¼šå›¢é˜Ÿå‡†å¤‡å‘å¸?v0.2.0ï¼Œæ‰‹åŠ¨æ›´æ–°äº†æ‰€æœ?package.json çš?version å­—æ®µã€?
**äº‹ä»¶é“?*ï¼?1. éƒ¨åˆ†å­åŒ…çš?version å­—æ®µè¢«é—æ¼ï¼ˆå¦?`packages/decision-engine/package.json` ä»ä¸º 0.1.0ï¼?2. æ¨é€?`v0.2.0` tagï¼Œè§¦å?`release.yml`
3. Tauri æ¡Œé¢æ„å»ºåœ?Windows ä¸Šå¤±è´¥ï¼ˆCI æœªåœ¨ Windows ä¸Šé¢„å…ˆéªŒè¯æ¡Œé¢æ„å»ºï¼‰
4. GitHub Release åˆ›å»ºä½†ç¼ºå°‘éƒ¨åˆ?artifact
5. å‘ç° version ä¸ä¸€è‡´åéœ€è¦æ‰‹åŠ¨ä¿®å¤å¹¶é‡æ–°æ¨é€?tag

**å®é™…åæœ**ï¼šå‘å¸ƒæµç¨‹éœ€è¦?2-3 æ¬¡å°è¯•ï¼Œæ¯æ¬¡ 30 åˆ†é’Ÿã€‚`release.yml:61` çš?`generate_release_notes: true` ç”Ÿæˆæ— åˆ†ç±»çš„ release notesï¼Œç”¨æˆ·çœ‹åˆ°çš„åªæœ‰ commit æ ‡é¢˜åˆ—è¡¨ã€?
**æ¶‰åŠå·®è·**ï¼?- æ— ç»Ÿä¸€ç‰ˆæœ¬ç®¡ç†ï¼ˆT5.2ï¼?- release.yml æ— å‘å¸ƒå‰éªŒè¯ï¼ˆT4.3ï¼?- `release.yml:23` ä½¿ç”¨ Node 20 ä¸é¡¹ç›?@types/node ä¸åŒ¹é…?- æ—?npm publishï¼ˆT5.1ï¼?- æ—?daemon äºŒè¿›åˆ¶æ„å»ºï¼ˆT4.2ï¼?
### åœºæ™¯ 4ï¼šä»£ç é£æ ¼é€€åŒ?
**è§¦å‘æ¡ä»¶**ï¼šæ–°å¼€å‘è€…åŠ å…¥å›¢é˜Ÿï¼Œæœªé…ç½®æœ¬åœ?prettier/eslint hookï¼ˆ`pre-commit` hook éœ€è¦?`husky install` åç”Ÿæ•ˆï¼‰ã€?
**äº‹ä»¶é“?*ï¼?1. æ–°å¼€å‘è€…çš„ä»£ç ä¸ç¬¦å?prettier æ ¼å¼è§„èŒƒ
2. ä»£ç é€šè¿‡ `git push --no-verify`ï¼ˆå›  pre-push çš?e2e æµ‹è¯•è¶…æ—¶ï¼?3. CI ä¸è¿è¡?`prettier --check`ï¼ˆ`package.json:66`ï¼?4. CI çš?eslint åªæ£€æŸ?provider å­ç›®å½•ä¸”é™é»˜
5. ä¸ç¬¦åˆè§„èŒƒçš„ä»£ç è¿›å…¥ main
6. é€æ¸ç§¯ç´¯ï¼Œæœ€ç»ˆéœ€è¦å¤§è§„æ¨¡ reformat

**å®é™…åæœ**ï¼šä»£ç é£æ ¼ä¸€è‡´æ€§è¢«ç ´åï¼Œcode review æ—¶å™ªéŸ³å¢åŠ ï¼ˆæ ¼å¼åŒ–å˜æ›´ä¸é€»è¾‘å˜æ›´æ··åœ¨ä¸€èµ·ï¼‰ã€‚æ ¹æ?.lintstagedrc.json çš„é…ç½®ï¼ˆeslint --fix + prettier --writeï¼‰ï¼Œlint-staged åªèƒ½ä¿®å¤ staged æ–‡ä»¶ï¼Œä½†è¿œç«¯ CI ä¸éªŒè¯ã€?
**æ¶‰åŠå·®è·**ï¼?- `ci.yml:148` çš?eslint èŒƒå›´è¿‡çª„
- ç¼ºå°‘ `npm run format`ï¼ˆprettier --checkï¼?- ç¼ºå°‘ `npm run lint:all` çš„ä¸¥æ ¼æ¨¡å¼?- `.husky/pre-push` æ‰§è¡Œ e2e å¯¼è‡´å¼€å‘è€…è·³è¿?
## 14 æ”¹è¿›ä¼˜å…ˆçº§çŸ©é˜?
åŸºäºå½±å“èŒƒå›´ Ã— ä¸¥é‡åº¦çš„äºŒç»´è¯„ä¼°ï¼Œå»ºè®®ä»¥ä¸‹ä¼˜å…ˆçº§ï¼?
```
ä¸¥é‡åº? é«? | P0: npm publish, secret scan,     | P0: å…¨é‡ typecheck, 
     | coverage threshold, é™é»˜æ¨¡å¼     | å¢é‡æµ‹è¯•, build cache
 ä¸? | P0: daemon binary, audit ç¡¬æ€?  | P1: OS çŸ©é˜µ, é›†æˆæµ‹è¯•
     |                                  |
 ä½? | P2: Docker, Playwright, SBOM    | P3: metrics, è€—æ—¶ç›‘æ§
     |__________________________________|_____________________
        çª„ï¼ˆsingle packageï¼?             å®½ï¼ˆworkspace-wideï¼?                            å½±å“èŒƒå›´
```

å³ä¸Šè±¡é™ï¼ˆé«˜ä¸¥é‡åº?+ å®½å½±å“èŒƒå›´ï¼‰çš„é—®é¢˜åº”ä¼˜å…ˆå¤„ç†ï¼šå…¨é‡?typecheckã€å¢é‡æµ‹è¯•ã€æ„å»ºç¼“å­˜ã€‚è¿™äº›æ”¹è¿›è¦†ç›–æœ€å¤šåŒ…ï¼Œé˜²æ­?P0 é—®é¢˜è·¨åŒ…æ‰©æ•£ã€?
## 15 ½áÂÛ

±¾·ÖÎöÏµÍ³Ê¶±ğÁË conex ÏîÄ¿ CI/CD Á÷Ë®ÏßÔÚ 7 ¸öÎ¬¶ÈÉÏµÄÏµÍ³ĞÔ²î¾à£¬Éæ¼° 12 ¸ö P0 ÑÏÖØ×è¶ÏÏîºÍ 18 ¸ö P1 ¸ß·çÏÕÏî¡£ºËĞÄÎÊÌâ¿ÉÒÔ¹éÄÉÎªÈı¾ä»°£º**¹¹½¨Î´×Ô¶¯»¯**£¨turbo ÔÚ CI ÖĞÍêÈ«Î´Ê¹ÓÃ£¬7 ¸ö TS °üÁã¹¹½¨ÑéÖ¤£©¡¢**²âÊÔËéÆ¬»¯**£¨95% µÄ²âÊÔ´úÂëÔÚ CI ÖĞ²»Ö´ĞĞ£¬2 ¸öºËĞÄ²âÊÔÌ×¼ş±»¾²Ä¬ÍÌÊÉ£©¡¢**·¢²¼ÎŞÁ÷Ë®Ïß**£¨6 ¸ö npm °üÎŞ·¨·¢²¼£¬daemon ¶ş½øÖÆ´Ó²»×Ô¶¯¹¹½¨£©¡£ÕâĞ©²î¾à¹²Í¬¹¹³ÉÁËÏîÄ¿´Ó\"¿ª·¢Ô­ĞÍ\"×ßÏò\"¿É½»¸¶²úÆ·\"µÄ×î´ó×è°­¡£ci_cd_improvement_plan.md Ìá¹©ÁË¸²¸Ç 5 ²ã¼Ü¹¹£¨´¥·¢¿ØÖÆ - ÔöÁ¿ÑéÖ¤ - È«Á¿ÑéÖ¤ - ·¢²¼Ç°ÑéÖ¤ - ½»¸¶£©µÄÏµÍ³ĞÔ¸Ä½ø·½°¸£¬×Ü¼ÆÉæ¼° 12 ¸öÎÄ¼şµÄĞŞ¸ÄÀ©ÔöºÍÔ¼ 1100 ĞĞ´úÂë±ä¸ü¡£
¸Ä½ø·½°¸Óë¼Ü¹¹ĞŞ¸´·½°¸£¨docs/crish_desktop_architectural_remediation_plan/00_master_overview.md:3-50£©×ñÑ­ÏàÍ¬µÄÉè¼ÆÕÜÑ§¡ª¡ªÂß¼­ÒÀÀµÇı¶¯¡¢ËùÓĞÎÊÌâÆ½µÈÓÅÏÈ¼¶¡¢ÎŞÊ±¼äÓëÈËÔ±°ó¶¨¡£±¾·ÖÎöÖĞÊ¶±ğµÄ 53 ¸ö¾ßÌå²î¾àµãÓë¼Ü¹¹ĞŞ¸´·½°¸µÄ 215 ¸öÎÊÌâµã»¥²¹£º¼Ü¹¹ĞŞ¸´½â¾ö´úÂëÄÚ²¿µÄ¸¯»¯£¬CI/CD ¸Ä½ø·ÀÖ¹¸¯»¯ÔÚºÏ²¢ºó¼ÌĞø¶ñ»¯¡£
µ±Ç° 4 ¸ö workflow ÎÄ¼şºÏ¼Æ 496 ĞĞ YAML ÅäÖÃ£¬¸Ä½øºóÔ¤¼ÆÀ©Õ¹ÖÁÔ¼ 1200 ĞĞ¡£Õâ¸öÔö³¤ÊÇ±ØÒªµÄ¡ª¡ªÃ¿¸öĞÂÔöµÄ job ´ú±íÒ»¸ö±»×Ô¶¯»¯µÄÖÊÁ¿±£ÕÏ²½Öè¡£¹Ø¼üÔÚÓÚÍ¨¹ı composite action ºÍ workflow ¸´ÓÃ»úÖÆ¿ØÖÆ¸´ÔÓ¶ÈÅòÕÍ£¬±ÜÃâ CI ±¾Éí³ÉÎªĞÂµÄÎ¬»¤¸ºµ£¡£
---
ÎÄµµ°æ±¾£º1.0.0
¶ÔÓ¦¸Ä½ø·½°¸£ºanalysis/ci_cd_improvement_plan.md
