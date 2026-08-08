# UPGRADING.md · 用户数据侧升级/迁移指南（唯一 SoT）

> 本文件是**用户数据侧迁移的唯一清单**（AU-02 §五.6 空白承接，PE-11 T11.5.3）。
> 实现归属：密钥迁移 PE-07 T07.4-B（原 PE-01 T03.3 收编）、DB 迁移 PE-08 T08.7、
> config 目录迁移 PE-01 T05.2、workspace 授权 PE-07 T07.2。
> 测试归属：PE-11 T11.5.1/T11.5.2/T11.5.3（见文末「测试资产」）。
> 升级指南为唯一入口——任何任务书/文档引用用户侧迁移说明时，一律指向本文件，
> 不另立第二份。

---

## 1. 总览：升级涉及哪些数据

| 数据           | 迁移内容                                   | 触发时机                      | 失败后果                   | 章节 |
| -------------- | ------------------------------------------ | ----------------------------- | -------------------------- | ---- |
| API 密钥       | localStorage 明文 → Rust DPAPI 凭据槽      | 应用启动（loadProfiles 前置） | 明文保留，可重试，可见报错 | §2   |
| 会话数据库     | sessions.db schema v1→v7                   | LocalDb::open 自动            | 自动重试 + 备份可回滚      | §3   |
| 配置目录       | 旧 `%APPDATA%\Crish\AgentWorkbench` → 新根 | 首启                          | 旧文件保留不删             | §4   |
| workspace 授权 | 旧 `crish_workspace` 不再自动授权          | 升级后首次使用                | 需重新授权（弹窗）         | §5   |

升级后自查步骤见 §6；故障排查见 §7。

---

## 2. 密钥迁移：localStorage → DPAPI

### 2.1 迁移什么

- 源：`localStorage['crish_provider_profiles_v1']` 中各 profile 的**明文 `apiKey`**（K-01 下线）。
- 目标：Rust DPAPI 凭据槽（`config_profile_apply`，写盘确认 `credentialPersistence='persisted'`）。
- 幂等标记：`localStorage['crish_profiles_secrets_migrated_v1'] = '1'`，置位后跳过（F5 冻结名）。

### 2.2 何时触发

每次启动时由 `ensureLegacyProfilesMigration()`（profileStore loadProfiles 前置钩子）触发一次；
进程内并发调用共享同一次迁移（StrictMode 双跑安全）。

### 2.3 失败可见性与回退（防密钥丢失模型）

| 结果                                                               | 行为                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| apply 成功且 DPAPI 落盘                                            | 剥离明文、保留 `hasKey`、迁移成功                             |
| apply 成功但 `credentialPersistence != 'persisted'`（降级/内存态） | **保留明文**（DPAPI 未落盘绝不删明文）、计 degraded、不置标记 |
| apply 失败                                                         | 计 failed、**保留明文**、不置标记                             |
| 全键扫描发现残留明文 JSON                                          | 计 residual、不置标记                                         |

- 主迁移失败后**重试一次**；仍失败则：
  - 派发 `security-migration-failed` 事件（`attempts`/`migrated`/`degraded`/`failed`，**载荷脱敏无明文**）；
  - 写告警日志（脱敏）；**不阻断启动**。
- 不置幂等标记 → **下次启动自动重试**，直到成功。
- 明文只在「DPAPI 确认落盘」后剥离，任何异常都不会造成密钥丢失。

### 2.4 验证

- 启动后设置页模型列表各 profile 无「待同步」提示；
- 浏览器 devtools → localStorage 中 `crish_provider_profiles_v1` 不含 `apiKey` 字段；
- 迁移成功标记 `crish_profiles_secrets_migrated_v1 = '1'`；
- 失败场景：启动日志出现 `migrateLegacyProfiles 未完成`（脱敏）与 `security-migration-failed` 事件。

---

## 3. 会话数据库 schema 迁移：v1 → v7

### 3.1 触发与机制

- 位置：`<app_data_dir>/sessions.db`（config 与 DB 同根，见 §4）。
- 机制：`LocalDb::open` → `PRAGMA user_version` 驱动，从当前版本逐级迁移到 v7；
  **每个版本独立事务**，迁移中断后下次 open 从已提交版本继续（幂等可重试）。
- 新库直接走 v1..v7 全链建 v7 结构。

### 3.2 各版本变化一览

| 版本 | 变化                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v1   | 初始形态：sessions（无 folder）、events 含 AUTOINCREMENT id、metadata 表、runs/pending 无 FK、session_messages 无 updated_at                                                                                                               |
| v2   | sessions 增列：folder / is_pinned / is_archived / branch_parent_id / timestamp_source / pinned_message_ids / engine_cursor / engine_last_run_id / hydrated_from_engine                                                                     |
| v3   | session_agent_messages 重建补 `CHECK (status IN ...)` 约束（数据拷贝）；生产形态含 message_count 触发器、session_sequence 计数器表                                                                                                         |
| v4   | events 重建为组合主键 `(session_id, sequence)` + FK（删除 AUTOINCREMENT id）；metadata 死表删除；runs / pending_inputs 加 FK（孤儿行过滤）；session_messages 加 `updated_at`；session_sequence 对齐为 `next_sequence`；schema_version 登记 |
| v5   | runs 增列 9 项缓存计量（prompt/completion/total/cache_read/cache_write/cache_miss tokens、sample_count、missed_tokens、warm_until_ms）；session_messages 增列 `usage_json`（P5 缓存测量域）                                                |
| v6   | session_agents 增列 3 项定义扩展：task_type / display_label / allowed_write_paths_json（T-D-07，REQ-D04 收敛参数落库）                                                                                                                      |
| v7   | 新建 `compression_blocks` 压缩块单表（记忆韧性专项 T-15，R-A 合列）：**PRIMARY KEY (session_id, block_id)**（块 id 仅会话内唯一）+ 索引 (session_id, generation DESC)；纯新建表零既有列改动（不触发备份-DROP） |

### 3.3 备份机制（回滚保险）

- 每级 DROP/重建前整库拷贝为 `sessions.db.bak-v{n}`（如 v3→v4 产生 `sessions.db.bak-v4`），
  保留最近 **2 份**。
- 备份文件 = **迁移前快照**（旧 user_version、旧表形态、含孤儿数据），可直接用于回滚。

### 3.4 数据清理语义

- v4 会过滤**孤儿行**（events/runs/pending_inputs 指向已删除会话），计数写入
  `session_meta['migration_v4_dropped_orphans'] = "events:runs:pending"`（可观测）。

### 3.5 验证

- 启动日志无 `migrate_v{n} failed`；
- `PRAGMA user_version` 应为 7；
- 侧栏会话/消息回灌完整（升级后会话树、正文、子代理均可见）；
- 数据目录存在 `sessions.db.bak-v4`（至多 2 份备份；v5/v6/v7 为纯 ADD COLUMN/新建表，
  不触发备份-DROP，不额外产生备份）。

---

## 4. 配置目录迁移：旧路径 → 新根

- 旧路径：`%APPDATA%\Crish\AgentWorkbench`（provider-config.json / *.dpapi / secrets/）。
- 新根：`app_data_dir`（配置与 DB 同根；打包环境以 `app.path().app_data_dir()` 为真源）。
- 时机：应用首启（检测到旧路径存在、新根无对应文件时执行）。
- 语义：**只复制不删除**——迁移成功前旧文件保留；成功后在 DB 写 `session_meta['config_migrated_v1']` 标记；幂等（新根已有同 key 文件则跳过）。
- 环境覆盖：`CRISH_WORKBENCH_CONFIG_DIR` 仅测试用，不影响用户升级路径。

### 验证

- 新根出现 provider-config.json / *.dpapi / secrets/ 且可读；
- 旧路径文件仍在（未删除）；
- `config_migrated_v1` 标记已写。

---

## 5. workspace 重新授权（PE-07 风险 3 缓解）

- 升级后 `localStorage['crish_workspace']` 中的历史 workspace **不再自动授权**
  （旧 grant 不随迁移继承，防越权：AA-05 P-01 迁移影响面）。
- 未授权路径访问会返回 `workspace_not_granted`，UI 弹出目录选择对话框重新授权；
- 授权成功经 `select_folder` 对话框 + `workbench_open_workspace` 登记到 `recent-workspaces.json`。

### 验证

- 升级后首次访问旧 workspace：出现重新授权对话框；
- 拒绝授权：文件操作被拒（`workspace_not_granted`），无越权路径。

---

## 6. 升级后自查步骤（5 分钟自检）

1. **启动日志关键字**：
   - 无 `migrate_v{n} failed`、无 `migrateLegacyProfiles 未完成`、无 `workspace_not_granted` 风暴；
   - 有 schema 完成迹象（`schema_version` 元数据 = 当前版本，见 §3.5）。
2. **设置页状态诊断**：
   - 各模型 profile 无「待同步」提示（密钥迁移成功）；
   - 模型密钥可正常使用（首条消息发送成功 = DPAPI 链路通）。
3. **会话数据**：
   - 侧栏会话树、消息正文、子代理面板回灌完整；
   - 打开旧会话可继续发送消息（事件流、sequence 正常续号）。
4. **备份存在**：数据目录 `sessions.db.bak-v{n}` 存在（≤2 份）。

---

## 7. 故障排查

| 症状                                  | 原因                                     | 处理                                                                                                                                 |
| ------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 启动日志 `migrate_v{n} failed`        | DB 迁移失败（磁盘/损坏）                 | 迁移按版本事务，下次启动自动重试；仍失败则用备份回滚：停止应用 → 将 `sessions.db.bak-v{n}` 复制回 `sessions.db` → 重启（自动重迁移） |
| 设置页报密钥迁移失败事件              | DPAPI 不可用（无凭据服务/CI 环境）       | 明文保留未丢失；修复 DPAPI 环境后重启自动重试；CI 无 DPAPI 时以 mock 覆盖（见测试资产）                                              |
| 升级后看不到历史会话                  | 孤儿行被 v4 过滤，或 30 天清理已执行     | 检查 `migration_v4_dropped_orphans` 计数（孤儿本就无主会话）；备份文件可查证迁移前数据                                               |
| 旧 workspace 无法访问                 | 重新授权机制生效（预期行为）             | 在目录选择对话框重新授权                                                                                                             |
| localStorage 旧数据未清理             | 30 天回滚保险期未到（设计如此）          | 等待 30 天后自动清理；无需手动干预（非会话数据永不清理）                                                                             |
| `PRAGMA user_version` 为 0 但已有旧表 | 旧版本从不写 user_version（生产形态 v0） | 正常：检测链按 v1 起点迁移，幂等跳过后到达 v4                                                                                        |

---

## 8. 测试资产（本指南对应门禁）

| 场景                                              | 资产                                                                                    | 运行命令                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| DB v3→v4 升级 e2e（真实路径 + 全 API 巡检）       | `crates/conex-db/tests/upgrade_e2e.rs`                                                  | `cargo test -p conex-db --test upgrade_e2e`                                                            |
| DB v1/v2/v3 fixture 迁移矩阵（PE-08）             | `crates/conex-db/tests/migrations.rs`                                                   | `cargo test -p conex-db --test migrations`                                                             |
| 密钥迁移失败回退 e2e（启动 A 失败 → 启动 B 恢复） | `apps/crish-desktop/src/api/provider-profiles/migrateLegacyProfiles.upgradeE2e.test.ts` | `npx vitest run apps/crish-desktop/src/api/provider-profiles/migrateLegacyProfiles.upgradeE2e.test.ts` |
| 密钥迁移单测（PE-07）                             | `apps/crish-desktop/src/api/provider-profiles/migrateLegacyProfiles.test.ts`            | 同上文件                                                                                               |
| localStorage→SQLite 迁移 e2e（含 30 天清理）      | `apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.test.ts`        | `npx vitest run apps/crish-desktop/src/api/session-persistence/migrateFromLocalStorage.test.ts`        |

> DPAPI 不可用环境（CI）：密钥迁移测试全部走 mock invoke（`config_profile_apply`），不依赖真实 DPAPI。
> 相关任务书：PE-01（T03.3 收编 PE-07 T07.4-B / T05.2）、PE-07（T07.4 / T07.2）、
> PE-08（T08.7）、PE-11（T11.5.1/T11.5.2/T11.5.3）。
