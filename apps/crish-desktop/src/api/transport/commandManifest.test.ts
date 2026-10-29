/**
 * commandManifest 测试（PE-03 T03.1）：
 * - 内置快照与 Rust `command_manifest.rs` 对齐（条数 = 注册面 + 登记先行、
 *   9 条新增登记齐备、幽灵命令排除、命令名唯一）——双端手工同步的双向守门；
 * - 动态对照（镜像守门）：`extractRustManifestNames()` 直读 Rust 真源（经
 *   `import.meta.url` 上溯仓库根），读失败 fail 不 skip + 提取数哨兵 ≥ 93 +
 *   断言三式（registered 子集逐名 / 总数 / 登记先行双向一致）——防摆设化；
 * - `initCommandManifest`：拉取成功（mock core_list_commands）→ 真源生效；
 * - 拉取失败（missing）→ 回退内置快照（不崩）；
 * - `isRegisteredCommand`：registered / 登记先行（false）/ 未知名三分支。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../../test-setup';
import {
  BUILTIN_COMMAND_MANIFEST,
  getEffectiveManifest,
  initCommandManifest,
  isRegisteredCommand,
  resetCommandManifestForTests,
} from './commandManifest';

describe('commandManifest', () => {
  beforeEach(() => {
    resetCommandManifestForTests();
  });

  describe('内置快照（镜像 Rust command_manifest.rs）', () => {
    it('条数公式化：总数 = 注册面 + 登记先行（镜像 Rust 测试断言）', () => {
      const registered = BUILTIN_COMMAND_MANIFEST.commands.filter(
        (c) => c.registered
      ).length;
      const pending = BUILTIN_COMMAND_MANIFEST.commands.length - registered;
      expect(pending).toBe(0);
      // 与 Rust COMMAND_MANIFEST（171 = 注册面 171 全实装）保持同步；
      // 变更 Rust 侧时同步本快照，双向条数由两端测试锁定
      // PE-07：T07.3（git_run/fs_delete_file）+ T07.4（profile_apply/secret_reveal）已接线
      // P3 步骤 5（C7 ③）：catalog_get / catalog_refresh 曾接线；**单轨收敛
      //   已退役**（`command_manifest.rs:326`；`catalog_commands.rs` 物理删除）
      //   ——与本文件下方「幽灵命令排除」断言一致；前端残留调用面（恒 MISSING）
      //   由 command-contract-drift.test.ts 断言一守（当前红，待 04 阶段 3 修）
      // F3（T-AB-19）：workbench_send_input 已接线
      // F9（T-CF-14）：workflow 六条 kebab 接线；I2-S5：trash 三条接线
      // R13（27 方案 S6）：browser_start / browser_stop / browser_status 已接线；
      //   并行域（browser 域）追加 browser_input / browser_start_frames /
      //   browser_stop_frames / browser_frame_status（90 → 94）
      // T-F 06：退役 5 条（core_read_run_events / delete_session / touch_session /
      //   core_md_render_stream / core_md_clear_cache），95 → 90（changelog 33 可查）
      // R1-07：multi_device_pair_* / multi_device_list_devices 四件套已接线（94 → 98）
      // R1-08：multi_device_revoke_device / multi_device_rename_device 已接线（98 → 100）
      // R1-09（G-4）：multi_device_network_info 已接线（102 → 103）
      // R1-11（G-1）：multi_device_set_enabled 已接线（103 → 104）
      // G-4 收尾：browser_import/list_bookmarks/history 四命令已接线（104 → 108）
      // Round7：note_document_apply_md / note_query_blocks / note_send_to_note（108 → 111）
      // D4a：resume_subagent / kill_all / kill_subagent（110）+
      //   core_resume_run / core_compact_now 登记先行（6）（111 → 116）
      // note_document_hydrate：真 hydrate IPC（116 → 117；registered 110 → 111）
      // note_detect_mirror_drift + note_import_mirror_proposal（117 → 119；111 → 113）
      // note_apply_ops：CONN-B3 collab wire apply（119 → 120；113 → 114）
      // 电脑操作三命令（computer_session_* / computer_status）已接线
      //   （123；117）
      // 原生浏览器与面板标准化战役：computer-panel 旧投屏残留退役（前端
      //   computerSessionApi 已删；Rust 侧命令面仍登记，见
      //   command-contract-drift.test.ts GHOST_EXEMPTIONS 退役面豁免）
      // E2 F4：core_compact_now 已接线（registered=false → true；118 → 119,
      //   登记先行 6 → 5）
      // F-03（DM-07）：core_read_run_events 恢复激活（T-F 06 退役撤销；
      //   124 → 125，119 → 120）
      // note_undo_text + note_redo_text：CRDT 因果撤销/重做（125 → 127，120 → 122）
      // 原生探活与模型扫描（provider_probe_ping / provider_probe_scan_models）（130 → 132，125 → 127）
      // R1 撤回（统一输入流收敛战役）：core_session_retract 已接线（132 → 133，127 → 128）
      // R7 收口：GUI fs 删除命令幽灵退役（R6-D5 后零消费）（125 → 124）
      // 后端优化维度 1：computer_estop 退役（停止合并到输入框停止按钮）
      //   （124 → 123）
      // note_document_recent：最近一篇 persist 非空查询（123 → 124）
      // 模型字典真源三命令追加（124 → 127），core_jsonl_append 退役（127 → 126）
      // 用量监控与时序分析五命令追加（126 → 131）
      // 多笔记综合管理体系四命令追加（131 → 135）
      // 用户账号与云端设备管理面七命令追加（135 → 142）
      // 偏好持久化面三命令追加（142 → 145，prefs_get / prefs_set / prefs_delete）
      // 首绘就绪握手命令追加（145 → 146，workbench_window_ready）
      // Win11 贴靠布局热区追加（136 → 137，workbench_set_snap_overlay_rect）
      // PE-07：五条工作区授权命令后 147 → 152；默认根激活命令追加后 152 → 153
      // 原生 Hit-Test 能力诊断命令追加后 160 → 161；Inspector 命令 161 → 162
      // auth_get_relay_ticket / auth_revoke_device 下线（改走远端中继直连与在线设备面）166 → 164
      const rust = rustManifestOnce();
      expect(registered).toBe(rust.registered.length);
      expect(BUILTIN_COMMAND_MANIFEST.commands.length).toBe(
        rust.registered.length + rust.pending.length
      );
    });

    it('命令名唯一', () => {
      const names = BUILTIN_COMMAND_MANIFEST.commands.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('PE-07 命令登记齐备（§7.2 登记表；已接线 registered=true）', () => {
      const byName = new Map(
        BUILTIN_COMMAND_MANIFEST.commands.map((c) => [c.name, c])
      );
      for (const name of [
        'workbench_apply_models_config',
        'config_secret_reveal',
        'workbench_git_run',
        'workbench_open_workspace',
        'workbench_open_workspaces',
        'workbench_activate_default_workspace',
        'workbench_list_workspaces',
        'workbench_pick_workspace_folder',
        'workbench_pick_workspace_folders',
      ]) {
        expect(byName.has(name), `${name} 必须登记内置快照`).toBe(true);
        expect(byName.get(name)?.registered, `${name} 已接线`).toBe(true);
      }
    });

    it('原生多 Webview 浏览器命令登记齐备（已接线 registered=true）', () => {
      const byName = new Map(
        BUILTIN_COMMAND_MANIFEST.commands.map((c) => [c.name, c])
      );
      for (const name of [
        'browser_webview_create',
        'browser_webview_set_bounds',
        'browser_webview_set_visible',
        'browser_webview_navigate',
        'browser_webview_action',
        'browser_webview_close',
        'browser_webview_set_muted',
        'browser_webview_set_hit_test',
        'browser_webview_set_inspector',
      ]) {
        expect(byName.has(name), `${name} 必须登记内置快照`).toBe(true);
        expect(byName.get(name)?.registered, `${name} 已接线`).toBe(true);
        expect(byName.get(name)?.family, `${name} 属于 browser 族`).toBe(
          'browser'
        );
        expect(byName.get(name)?.surface, `${name} 属于 engine 契约面`).toBe(
          'engine'
        );
      }
    });

    it('幽灵命令排除：由 commandMap 侧行为断言 + Rust 侧 manifest 测试双重守门', () => {
      // 幽灵命令（AA-02 W-5，9 条）不得出现在内置快照：此处不重复字面量清单
      // （前端 grep 零命中门禁），守门分工如下：
      // - 映射面：commandMap.test.ts 断言 9 个幽灵 WS type 一律解析为 null；
      // - 清单面：Rust command_manifest.rs `manifest_excludes_ghost_commands`
      //   断言幽灵命令名不得登记 manifest（真源侧拦截）；
      // - 传递性：本测试「映射值全部 registered」+ commandMap 对照测试保证
      //   幽灵命令无任何可调用路径。
      const registered = new Set(
        BUILTIN_COMMAND_MANIFEST.commands
          .filter((c) => c.registered)
          .map((c) => c.name)
      );
      // 幽灵 WS type 对应的命令名不得出现在 registered 面
      for (const ws of [
        'git-status',
        'git-diff',
        'config_get',
        'config_update',
        'config_profile_apply',
        'catalog_get',
        'catalog_refresh',
      ]) {
        expect(registered.has(ws)).toBe(false);
      }
    });
  });

  describe('isRegisteredCommand（清单校验）', () => {
    it('registered 命令可调用；登记先行（false）与未知名不可调用', () => {
      expect(isRegisteredCommand('core_run_task')).toBe(true);
      expect(isRegisteredCommand('core_list_commands')).toBe(true);
      // PE-07 T07.3：git_run 已接线；T07.4：profile_apply / secret_reveal 已接线
      expect(isRegisteredCommand('workbench_git_run')).toBe(true);
      expect(isRegisteredCommand('workbench_apply_models_config')).toBe(true);
      expect(isRegisteredCommand('config_secret_reveal')).toBe(true);
      // R1-09（G-4）：网络环境检测已接线
      expect(isRegisteredCommand('multi_device_network_info')).toBe(true);
      // R1-11（G-1）：多端服务总开关已接线
      expect(isRegisteredCommand('multi_device_set_enabled')).toBe(true);
      // G-4 收尾：书签/历史导入四命令已接线
      expect(isRegisteredCommand('browser_import_bookmarks')).toBe(true);
      expect(isRegisteredCommand('browser_import_history')).toBe(true);
      expect(isRegisteredCommand('browser_list_bookmarks')).toBe(true);
      expect(isRegisteredCommand('browser_list_history')).toBe(true);
      // D4a：子代理显式恢复与关闭三命令已接线
      expect(isRegisteredCommand('resume_subagent')).toBe(true);
      expect(isRegisteredCommand('kill_all')).toBe(true);
      expect(isRegisteredCommand('kill_subagent')).toBe(true);
      // E2 F4：core_compact_now 已接线（registered=true，可调用）
      expect(isRegisteredCommand('core_compact_now')).toBe(true);
      expect(isRegisteredCommand('core_generate_session_title')).toBe(true);
      // 用量监控面五命令已接线
      expect(isRegisteredCommand('usage_get_dashboard_data')).toBe(true);
      expect(isRegisteredCommand('usage_get_activity_matrix')).toBe(true);
      expect(isRegisteredCommand('usage_clear_history')).toBe(true);
      expect(isRegisteredCommand('usage_record_delta')).toBe(true);
      expect(isRegisteredCommand('usage_import_legacy_snapshot')).toBe(true);
      // 偏好持久化面三命令已接线
      expect(isRegisteredCommand('prefs_get')).toBe(true);
      expect(isRegisteredCommand('prefs_set')).toBe(true);
      expect(isRegisteredCommand('prefs_delete')).toBe(true);
      // 原生多 Webview 浏览器七命令已接线
      expect(isRegisteredCommand('browser_webview_create')).toBe(true);
      expect(isRegisteredCommand('browser_webview_set_bounds')).toBe(true);
      expect(isRegisteredCommand('browser_webview_set_visible')).toBe(true);
      expect(isRegisteredCommand('browser_webview_navigate')).toBe(true);
      expect(isRegisteredCommand('browser_webview_action')).toBe(true);
      expect(isRegisteredCommand('browser_webview_close')).toBe(true);
      expect(isRegisteredCommand('browser_webview_set_muted')).toBe(true);
      // 未知名
      expect(isRegisteredCommand('nope')).toBe(false);
    });
  });

  describe('initCommandManifest（启动拉取）', () => {
    it('拉取成功 → 真源清单生效（替换内置快照）', async () => {
      mockTauriCommand('core_list_commands', async () => ({
        contractVersion: '9.9.9',
        commands: [
          {
            name: 'core_mock_only',
            family: 'core',
            surface: 'engine',
            registered: true,
          },
        ],
      }));
      const manifest = await initCommandManifest();
      expect(manifest.contractVersion).toBe('9.9.9');
      expect(getEffectiveManifest()).toBe(manifest);
      expect(isRegisteredCommand('core_mock_only')).toBe(true);
      // 真源替换后，内置快照的 registered 面不再生效
      expect(isRegisteredCommand('core_run_task')).toBe(false);
    });

    it('拉取失败（missing / 非 Tauri 环境）→ 回退内置快照（不崩）', async () => {
      const manifest = await initCommandManifest();
      expect(manifest).toBe(BUILTIN_COMMAND_MANIFEST);
      expect(isRegisteredCommand('core_run_task')).toBe(true);
    });

    it('幂等：并发/重复调用只拉取一次', async () => {
      const impl = vi.fn(async () => ({
        contractVersion: '1.0.0',
        commands: [
          {
            name: 'core_mock_only',
            family: 'core',
            surface: 'engine',
            registered: true,
          },
        ],
      }));
      mockTauriCommand('core_list_commands', impl);
      await Promise.all([
        initCommandManifest(),
        initCommandManifest(),
        initCommandManifest(),
      ]);
      expect(impl).toHaveBeenCalledTimes(1);
    });
  });

  // ── 动态对照（镜像守门，34 文档 DD5-T1 §1.4）──
  // 直读 Rust 真源 command_manifest.rs 与内置快照双向核对：
  // - 仓库根定位：import.meta.url 反推测试文件绝对路径，逐级上溯至真源存在目录
  //   （monorepo 根；不停在子 workspace 的 package.json），不依赖 process.cwd()；
  // - 读失败/文件缺失 → 抛错（测试 fail），严禁 catch 后 skip——否则回归「摆设
  //   测试」（00 计划总文档 §6.1 风险 6）；
  // - 哨兵：提取数 ≥ 120（真源 127），提取语法漂移/正则失配空集时直接 fail；
  // - 断言三式：registered 子集逐名带差异清单 + 总数一致 + 登记先行双向一致。

  /** Rust 真源相对仓库根的路径（路径耦合由 existsSync fail 兜底） */
  const RUST_MANIFEST_REL =
    'apps/agent-workbench/src-tauri/src/command_manifest.rs';

  function locateRepoRoot(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    while (true) {
      if (existsSync(join(dir, RUST_MANIFEST_REL))) return dir;
      const parent = dirname(dir);
      if (parent === dir) {
        throw new Error(
          `无法定位仓库根：上溯未找到 ${RUST_MANIFEST_REL}（起始于 ${dir}）`
        );
      }
      dir = parent;
    }
  }

  function readRustManifestSource(): string {
    const file = join(locateRepoRoot(), RUST_MANIFEST_REL);
    if (!existsSync(file)) {
      // 文件缺失/读失败必须 fail 不 skip：镜像守门失效即红
      throw new Error(`Rust 真源缺失：${file}（动态对照必须 fail，不得 skip）`);
    }
    return readFileSync(file, 'utf8');
  }

  /** 去注释（行注释 // 与块注释，含 //! 文档注释）后按四元组正则提取 Rust entry 调用面 */
  function extractRustManifestNames(): {
    registered: string[];
    pending: string[];
  } {
    const stripped = readRustManifestSource()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // Rust entry() 签名恒四参（name/family/surface/registered），
    // 尾逗号可选（多行缩进排版会带尾逗号）；
    // 勿复用 TS 三/四参正则（34 文档 §1.4 约定）
    const re =
      /entry\(\s*"([^"]+)",\s*"[^"]+",\s*"[^"]+",\s*(true|false)\s*,?\s*\)/g;
    const registered: string[] = [];
    const pending: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      (m[2] === 'true' ? registered : pending).push(m[1]);
    }
    return { registered, pending };
  }

  /** 惰性缓存：Rust 真源只读一次，提取失败在用例内显式抛错（fail 不 skip） */
  let cachedRust: { registered: string[]; pending: string[] } | null = null;
  function rustManifestOnce(): { registered: string[]; pending: string[] } {
    if (!cachedRust) cachedRust = extractRustManifestNames();
    return cachedRust;
  }

  describe('动态对照（镜像守门：直读 Rust command_manifest.rs 真源）', () => {
    it('哨兵：Rust 提取数 ≥ 120（防提取语法漂移/正则失配空集摆设化）', () => {
      const rust = rustManifestOnce();
      const total = rust.registered.length + rust.pending.length;
      expect(total).toBeGreaterThanOrEqual(120);
    });

    it('断言一式：前端 registered ⊇ Rust registered（逐名断言，缺失带差异清单）', () => {
      const rust = rustManifestOnce();
      const frontend = new Set(
        BUILTIN_COMMAND_MANIFEST.commands
          .filter((c) => c.registered)
          .map((c) => c.name)
      );
      const missing = rust.registered.filter((name) => !frontend.has(name));
      expect(
        missing,
        `前端 registered 缺失 ${missing.length} 条：${missing.join(', ')}` +
          '（镜像守门：内置快照与 Rust 真源漂移）'
      ).toEqual([]);
    });

    it('断言二式：双端总数一致（总数一致 + 一式子集 ⇒ registered 全等）', () => {
      const rust = rustManifestOnce();
      const total = rust.registered.length + rust.pending.length;
      expect(BUILTIN_COMMAND_MANIFEST.commands.length).toBe(total);
      expect(
        BUILTIN_COMMAND_MANIFEST.commands.map((item) => item.name).sort()
      ).toEqual([...rust.registered, ...rust.pending].sort());
    });

    it('断言三式：登记先行（registered=false）名集合双向一致', () => {
      const rust = rustManifestOnce();
      const frontendPending = new Set(
        BUILTIN_COMMAND_MANIFEST.commands
          .filter((c) => !c.registered)
          .map((c) => c.name)
      );
      const rustPending = new Set(rust.pending);
      const rustOnly = [...rustPending].filter(
        (name) => !frontendPending.has(name)
      );
      const frontendOnly = [...frontendPending].filter(
        (name) => !rustPending.has(name)
      );
      expect(
        rustOnly,
        `Rust 有而前端缺的登记先行：${rustOnly.join(', ')}`
      ).toEqual([]);
      expect(
        frontendOnly,
        `前端多出的登记先行（Rust 真源无）：${frontendOnly.join(', ')}`
      ).toEqual([]);
    });
  });
});
