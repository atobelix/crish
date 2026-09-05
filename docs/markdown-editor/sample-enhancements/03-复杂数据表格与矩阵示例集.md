# 03-复杂数据表格与矩阵示例集 (Enterprise Complex Tables & Matrix Showcase)

> **文档定位**：本文件为 Markdown 混合渲染引擎（Hybrid Rendering Engine）专设的**高复杂度生产级数据报表、API 字典与性能基准矩阵**验证示例集。
> **核心目标**：突破基础三列表格的玩具级别演示，提供贴近现代企业级核心架构、全链路可观测性、分布式共识以及财务收支的真实数据，同时针对渲染器的 **HeightMap 行高拉伸、8–10 列横向滚动、管道转义符 (`\|`)、行内富文本混合、极值单元格与嵌套块容器** 施加立体化的排版压力测试。

---

## 目录索引 (Table of Contents)

- [一、微服务 API 网关契约路由字典 (Microservices API Gateway & Routing Registry)](#一微服务-api-网关契约路由字典-microservices-api-gateway--routing-registry)
  - [1.1 全球边缘网关主路由表（10 列超宽表 + 转义管道 + 状态徽章）](#11-全球边缘网关主路由表10-列超宽表--转义管道--状态徽章)
  - [1.2 网关异常错误码与降级规则映射表（单元格多重 `<br>` 换行拉伸）](#12-网关异常错误码与降级规则映射表单元格多重-br-换行拉伸)
- [二、跨地域分布式云原生数据库基准对比矩阵 (Cross-Region Distributed DB Benchmark)](#二跨地域分布式云原生数据库基准对比矩阵-cross-region-distributed-db-benchmark)
  - [2.1 多集群共识延迟与吞吐性能对齐表（9 列对齐矩阵 + 混合对齐方式）](#21-多集群共识延迟与吞吐性能对齐表9-列对齐矩阵--混合对齐方式)
  - [2.2 极端混沌注入测试表现（空单元格、单字符与超长哈希混合）](#22-极端混沌注入测试表现空单元格单字符与超长哈希混合)
- [三、企业级季度合并财务收支损益表 (Corporate Consolidated P&L Statement)](#三企业级季度合并财务收支损益表-corporate-consolidated-pl-statement)
  - [3.1 2025 年度 Q1-Q4 集团合并损益表（10 列严密货币对齐报表）](#31-2025-年度-q1-q4-集团合并损益表10-列严密货币对齐报表)
  - [3.2 研发核算与 CapEx/OpEx 递延分摊附注表（复杂行内格式与代码混排）](#32-研发核算与-capexopex-递延分摊附注表复杂行内格式与代码混排)
- [四、全链路 DevOps CI/CD 流水线矩阵 (DevOps End-to-End Delivery Pipeline Matrix)](#四全链路-devops-cicd-流水线矩阵-devops-end-to-end-delivery-pipeline-matrix)
  - [4.1 多架构交叉编译与测试套件执行矩阵（8 列状态监控矩阵）](#41-多架构交叉编译与测试套件执行矩阵8-列状态监控矩阵)
  - [4.2 容器镜像安全与合规扫描审计表（包含 Shell 管道符与 CVE 字典）](#42-容器镜像安全与合规扫描审计表包含-shell-管道符与-cve-字典)
- [五、嵌套块与复杂容器嵌套表格测试 (Nested Block & Container Table Stress Suite)](#五嵌套块与复杂容器嵌套表格测试-nested-block--container-table-stress-suite)
  - [5.1 列表项内部嵌套表格（有序列表、无序列表、任务列表嵌套）](#51-列表项内部嵌套表格有序列表无序列表任务列表嵌套)
  - [5.2 引用块（Blockquote）内部嵌套复杂表格（单层与多层引用深度）](#52-引用块blockquote内部嵌套复杂表格单层与多层引用深度)
  - [5.3 折叠容器（`<details>`）内的审计对账表](#53-折叠容器details内的审计对账表)
- [六、极限排版边界与异常压力测试 (Edge Case & Boundary Stress Matrix)](#六极限排版边界与异常压力测试-edge-case--boundary-stress-matrix)
  - [6.1 极端列宽跨度对比表（1 字符列至 350 字符无空格连续串）](#61-极端列宽跨度对比表1-字符列至-350-字符无空格连续串)
  - [6.2 密集连续换行与稀疏矩阵（HeightMap 垂直伸缩与多管道连击）](#62-密集连续换行与稀疏矩阵heightmap-垂直伸缩与多管道连击)
- [七、渲染引擎排版与 HeightMap 验收要点 (Engine Verification Checklist)](#七渲染引擎排版与-heightmap-验收要点-engine-verification-checklist)

---

## 一、微服务 API 网关契约路由字典 (Microservices API Gateway & Routing Registry)

本章节模拟企业级全球微服务边缘 API 网关（如 Envoy / Kong / 自研 Rust 网关）的路由规则与服务治理定义表。

### 1.1 全球边缘网关主路由表（10 列超宽表 + 转义管道 + 状态徽章）

*测试重点：10 列横向展开、自适应列宽与横向平滑滚动；单元格内包含正则表达式管道转义 `\|`；混合加粗、行内代码、`<kbd>` 标签、徽章状态圆点与超链接。*

| 路由服务 ID | 方法 | 网关匹配 Pattern (RegEx / Prefix) | 上游集群目标 | 鉴权协议 | 限流策略 (QPS / Burst) | 超时 SLA | 重试策略 | 熔断阈值 | 部署运行态 |
| :--- | :---: | :--- | :--- | :---: | :---: | :---: | :--- | :---: | :---: |
| `gw-auth-v2` | **POST** | `/api/v2/auth/(login\|token\|refresh)` | `cluster.auth.internal:8443` | `<kbd>OAuth2</kbd>` | `5000` / `8000` | `150ms` | 指数退避 (3次) | 错误率 > 5% | 🟢 `HEALTHY` |
| `gw-order-tx` | **POST** | `/api/v3/orders/{order_id}/checkout` | `cluster.order-tx.internal:9001` | `<kbd>mTLS</kbd>` + `JWT` | `12000` / `15000` | `250ms` | **禁止重试** (*幂等要求*) | 错误率 > 2% | 🟢 `HEALTHY` |
| `gw-bill-calc` | **GET** | `/v1/(billing\|invoicing)/calculate` | `cluster.billing.internal:8080` | `<kbd>HMAC-SHA256</kbd>` | `3000` / `4500` | `450ms` | 线性退避 (2次, 间隔50ms) | 慢调用比例 > 15% | 🟡 `DEGRADED` |
| `gw-user-prof` | **PUT** | `/api/v1/users/([0-9a-f]{8}-[0-9a-f]{4})/profile` | `cluster.user.internal:8081` | `<kbd>JWT-RS256</kbd>` | `8000` / `10000` | `200ms` | 指数退避 (3次) | 连续错误 50 次 | 🟢 `HEALTHY` |
| `gw-search-es` | **GET** | `/api/v2/search/items?q=(.*)` | `cluster.es-proxy.internal:9200` | `API-Key` | `25000` / `30000` | `800ms` | 不重试 | 错误率 > 10% | 🟢 `HEALTHY` |
| `gw-legacy-crm`| ~~**ANY**~~ | `/legacy/(v0\|v1)/crm/.*` | `192.168.10.124:7070` | `<kbd>Basic-Auth</kbd>` | `500` / `800` | `1500ms` | 单次重试 | 连续错误 10 次 | 🔴 `TRIPPED` |
| `gw-event-pub` | **POST** | `/events/(metrics\|audit\|telemetry)` | `cluster.kafka-ingest.internal:9092` | `<kbd>mTLS</kbd>` | `50000` / `80000` | `50ms` | 内存缓冲异步重试 | 无 | 🟢 `HEALTHY` |
| `gw-file-oss`  | **POST** | `/oss/upload/(public\|restricted)/{bucket}` | `cluster.minio.internal:9000` | `<kbd>S3-SigV4</kbd>` | `2000` / `3000` | `5000ms` | 分片断点续传重试 | 连接超时 > 3次 | ⚪ `STANDBY` |

---

### 1.2 网关异常错误码与降级规则映射表（单元格多重 `<br>` 换行拉伸）

*测试重点：单行单元格内包含大量 `<br>` 引起的非均匀行高拉伸；测试 HeightMap 对每行实际渲染尺寸的感知，确保光标选区与虚拟滚动高度不坍缩。*

| 错误类别代号 | HTTP 映射 | 触发条件与排查准则 | 降级容灾返回体 (JSON Mock) | 联动网关指令 | 负责人与跟进 Runbook |
| :--- | :---: | :--- | :--- | :---: | :--- |
| `ERR_AUTH_001` | `401` | **1. 凭证缺失**：请求头无 `Authorization`<br>**2. 签名失效**：JWT 过期超过公差 60s<br>**3. 密钥轮转**：KMS 缓存未同步到边缘节点 | `{"code": 40101,`<br>` "msg": "TOKEN_EXPIRED",`<br>` "retry_after": 0}` | `<kbd>PURGE_CACHE</kbd>`<br>`<kbd>SYNC_KMS</kbd>` | 👤 安全组 / 张工程师<br>📖 [Runbook-Auth-401](https://internal.wiki/sec/runbook-401) |
| `ERR_ROUTE_404`| `404` | **1. 路径无匹配**：未注册的路由前缀<br>**2. 版本废弃**：API 版本已下线但客户端仍在发起调用<br>**3. 金丝雀权重**：灰度分流比设置为 0% | `{"code": 40400,`<br>` "msg": "UPSTREAM_NOT_FOUND",`<br>` "trace_id": "c7f-99a"}` | `<kbd>LOG_DRIFT</kbd>` | 👤 网关组 / 李架构师<br>📖 [Runbook-Route-404](https://internal.wiki/gw/404) |
| `ERR_RATE_429` | `429` | **1. 令牌桶耗尽**：租户单秒请求超出配额<br>**2. IP 黑名单触发**：10s 内异常报错超 200 次<br>**3. DDoS 协同清洗**：触发 CDN 联动防护机制 | `{"code": 42999,`<br>` "msg": "TOO_MANY_REQUESTS",`<br>` "backoff_ms": 1200}` | `<kbd>SHED_LOAD</kbd>`<br>`<kbd>RATE_LIMIT</kbd>` | 👤 运维组 / 王SRE<br>📖 [Runbook-Limit-429](https://internal.wiki/sre/429) |
| `ERR_CIRCUIT_503`| `503` | **1. 熔断器切入 Open**：滑动窗口错误率超标<br>**2. 上游全健康检查失败**：健康节点数为 0<br>**3. 线程池打满**：排队队列长度超过 2048 限制 | `{"code": 50350,`<br>` "msg": "SERVICE_DEGRADED",`<br>` "data": {"mock": true}}` | `<kbd>TRIP_BREAKER</kbd>`<br>`<kbd>SWITCH_MOCK</kbd>`<br>`<kbd>ALERT_P0</kbd>` | 👤 应急响应组 (轮值)<br>📖 [P0-Breaker-Mitigation](https://internal.wiki/p0/mitigate) |

---

## 二、跨地域分布式云原生数据库基准对比矩阵 (Cross-Region Distributed DB Benchmark)

本章节展示多地域（亚太-东京、美东-弗吉尼亚、欧洲-法兰克福）分布式多主共识数据库在高并发、网络抖动下的压测性能与成本指标。

### 2.1 多集群共识延迟与吞吐性能对齐表（9 列对齐矩阵 + 混合对齐方式）

*测试重点：数字与百分比列右对齐、枚举状态列居中、拓扑描述列左对齐；行内包含物理单位（`ms`、`kQPS`、`MB/s`）、数学统计符号（$\Delta$、$\sigma$）以及对比高亮。*

| 集群地域 (Region / AZ) | 共识算法实现 | 节点拓扑 (Node/Replica) | 写入延迟 P50 (ms) | 写入延迟 P95 (ms) | 写入延迟 P99 (ms) | 吞吐能力 (kQPS) | 网络抖动 $\sigma$ (ms) | 架构健康度 |
| :--- | :--- | :---: | ---: | ---: | ---: | ---: | ---: | :---: |
| **AP-East-1 (HK / Tokyo)** | Multi-Raft + Percolator | `15 Nodes / 5 Replicas` | `8.42` | `18.60` | `32.45` | `142.8` | `0.45` | 🟢 `Optimum` |
| **US-East-1 (N. Virginia)** | Multi-Paxos + TrueTime | `21 Nodes / 7 Replicas` | `12.15` | `24.80` | `46.12` | `198.5` | `0.82` | 🟢 `Optimum` |
| **EU-Central-1 (Frankfurt)**| Raft + HLC (Logical Clock)| `9 Nodes / 3 Replicas` | `14.80` | `31.25` | `58.90` | `88.2` | `1.15` | 🟡 `Moderate` |
| **Global Dual-Region Sync** | WAN-BFT / Pipelined Raft | `24 Nodes / Cross-WAN` | `112.40` | `168.90` | `245.00` | `45.6` | `8.40` | 🟡 `Degraded` |
| **SA-East-1 (São Paulo)** | Leaderless Quorum (Dynamo)| `6 Nodes / 3 Replicas` | `19.30` | `42.10` | `85.70` | `34.0` | `2.85` | 🟢 `Optimum` |
| **Edge-Cluster-PoP-09** | Lightweight Raft (SQLite3)| `3 Nodes / Micro-PoP` | `2.15` | `4.60` | `9.80` | `18.5` | `0.12` | 🟢 `Optimum` |
| **Disaster Recovery (Cold)**| Asynchronous Log Shipping | `Standby / Passive` | `850.00` | `1420.00` | `2800.00` | `5.2` | `24.50` | 🔴 `Lagging` |

---

### 2.2 极端混沌注入测试表现（空单元格、单字符与超长哈希混合）

*测试重点：空单元格（`| |`）、单字符极短单元格（`-`、`X`、`✓`）、长达 64-128 位的超长无空格哈希指纹、混合行内富文本。*

| 演练批次 | 节点 | 注入故障类型 | 恢复时长 | 数据丢失 (RPO) | 共识冻结状态 | 校验指纹 (SHA-256 Digest) | 判定 |
| :---: | :---: | :--- | :---: | :---: | :---: | :--- | :---: |
| `001` | A | `Kernel-OOM-Kill` | `1.2s` | `0` | - | `9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08` | ✓ |
| `002` | B | `Network-Partition-50%` | `4.8s` | `0` | `PARTIAL` | `5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8` | ✓ |
| `003` | C | `Disk-I/O-Hang-30000ms` | `32.0s` | | `TOTAL` | `4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a` | ⚠️ |
| `004` | D | | `0.1s` | `0` | - | `ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d` | ✓ |
| `005` | E | `Clock-Skew-Jump +500ms` | `12.5s` | `0` | `SPLIT_BRAIN_AVOID` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | ✓ |
| `006` | - | `Corrupted-WAL-Segment` | | | `UNRECOVERED` | `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad` | ✗ |

---

## 三、企业级季度合并财务收支损益表 (Corporate Consolidated P&L Statement)

本章节模拟上市公司级财务审计核算总表，包含 10 列严格对齐的收支科目、跨季度环比/同比变化量、正负货币符号与附注说明。

### 3.1 2025 年度 Q1-Q4 集团合并损益表（10 列严密货币对齐报表）

*测试重点：10 列高密度排版；财务金额正负号（`+$`、`-$`、小括号表示负数）；右对齐与居中交织；单元格内百分比与徽章。*

| 核算科目编号 | 损益核算科目 (GAAP / IFRS) | 2024-FY 决算 | 2025-Q1 实际 | 2025-Q2 实际 | 2025-Q3 实际 | 2025-Q4 预估 | 环比变化 (QoQ) | 同比增长 (YoY) | 审计核销状态 |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |
| `REV-1001` | **企业云软件订阅收入 (ARR)** | `$42,500,000` | `$12,850,000` | `$13,420,000` | `$14,110,000` | `$15,200,000` | `+7.73%` | `+28.45%` | 🟢 `AUDITED` |
| `REV-1002` | 专业咨询与专家实施服务 | `$8,400,000` | `$2,100,000` | `$2,050,000` | `$2,180,000` | `$2,300,000` | `+5.50%` | `+2.38%` | 🟢 `AUDITED` |
| `COGS-201` | 基础设施与云算力承载成本 | `($14,200,000)`| `($3,800,000)`| `($3,950,000)`| `($4,100,000)`| `($4,350,000)`| `-6.10%` | `+18.31%` | 🟢 `AUDITED` |
| `COGS-202` | 全球多语言客户支持人工成本 | `($4,800,000)`| `($1,250,000)`| `($1,300,000)`| `($1,320,000)`| `($1,350,000)`| `-2.27%` | `+7.50%` | 🟢 `AUDITED` |
| **GP-TOTAL** | **毛利总额 (Gross Profit)** | **`$31,900,000`**| **`$9,900,000`**| **`$10,220,000`**| **`$10,870,000`**| **`$11,800,000`**| **`+8.56%`** | **`+34.12%`** | 🟢 `AUDITED` |
| `OPEX-301` | 基础架构与新算法研发支出 (R&D) | `($12,500,000)`| `($3,600,000)`| `($3,850,000)`| `($4,050,000)`| `($4,200,000)`| `-3.70%` | `+24.00%` | 🟡 `REVIEWING` |
| `OPEX-302` | 全球市场拓展与销售佣金 (S&M) | `($9,800,000)` | `($2,800,000)`| `($3,100,000)`| `($3,250,000)`| `($3,400,000)`| `-4.62%` | `+16.33%` | 🟢 `AUDITED` |
| `OPEX-303` | 行政总务与法务合规开支 (G&A) | `($3,200,000)` | `($850,000)`  | `($880,000)`  | `($900,000)`  | `($920,000)`  | `-2.22%` | `+6.25%` | 🟢 `AUDITED` |
| **EBITDA** | **息税折旧摊销前利润 (EBITDA)**| **`$6,400,000`** | **`$2,650,000`**| **`$2,390,000`**| **`$2,670,000`**| **`$3,280,000`**| **`+22.85%`**| **`+68.75%`** | 🟢 `AUDITED` |
| `TAX-401`  | 递延所得税与离岸清算扣缴 | `($1,100,000)` | `($420,000)`  | `($380,000)`  | `($450,000)`  | `($520,000)`  | `-15.56%`| `+35.00%` | 🟡 `ESTIMATED` |
| **NET-INC**| **净利润 (Net Net Income)** | **`$5,300,000`** | **`$2,230,000`**| **`$2,010,000`**| **`$2,220,000`**| **`$2,760,000`**| **`+24.32%`**| **`+75.47%`** | 🟢 `VERIFIED` |

---

### 3.2 研发核算与 CapEx/OpEx 递延分摊附注表（复杂行内格式与代码混排）

*测试重点：单元格内嵌套 SQL、会计科目公式、多行换行核销依据，以及包含 `\|` 管道逻辑运算。*

| 核销凭证号 | 项目资产归属 | 会计分类 | 金额 (USD) | 摊销计算公式 / 逻辑表达式 | 审计审查要点与凭据链接 |
| :--- | :--- | :---: | ---: | :--- | :--- |
| `VCH-2025-081` | 统一混合渲染器内核 v3.0 | `CapEx (资本化)` | `$1,450,000.00` | `Amort = Cost / 36;`<br>`IF (deploy_prod == true \|\| cert_pass == 1)` | 1. 软件资产资本化阶段性评估报告<br>2. 研发工时工单打卡记录核验<br>🔗 [Doc-Audit-081](https://finance.internal/audit/081) |
| `VCH-2025-094` | GPU 集群模型微调租赁支出 | `OpEx (费用化)` | `$890,420.50` | `Cost = sum(gpu_hours * price_per_hour);`<br>`WHERE cluster = 'h100-nvlink'` | 1. 对应 AWS/GCP 账单原始 CSV 凭据<br>2. 跨国税收抵扣预提清单<br>🔗 [Doc-Audit-094](https://finance.internal/audit/094) |
| `VCH-2025-102` | 全球数据合规审计及 ISO 认证 | `OpEx (费用化)` | `$125,000.00` | `Fee = fixed_retainer + travel_allowance;` | 1. 普华永道 (PwC) 审计签字确认单<br>2. 涉外增值税完税专用发票<br>🔗 [Doc-Audit-102](https://finance.internal/audit/102) |
| `VCH-2025-119` | 知识产权专利申请与买断 | `CapEx (资本化)` | `$340,000.00` | `Asset = PurchasePrice + FilingFees;` | 1. 专利局实质审查合格通知书<br>2. 知识产权转让公证合同<br>🔗 [Doc-Audit-119](https://finance.internal/audit/119) |

---

## 四、全链路 DevOps CI/CD 流水线矩阵 (DevOps End-to-End Delivery Pipeline Matrix)

本章节展示多架构跨平台（Linux x86_64, Linux AArch64, macOS Apple Silicon, Windows Server）编译、多语言混编、质量静态扫描与发布制品的自动化构建矩阵。

### 4.1 多架构交叉编译与测试套件执行矩阵（8 列状态监控矩阵）

*测试重点：8 列典型宽度矩阵；展示 CI 阶段状态、执行器标签、构建耗时、并发 Worker 数量以及产物大小。*

| 阶段 (Stage) | 架构与操作系统 (Target Arch / OS) | 执行器标签 (Runner) | 耗时 (Wall Time) | 并发数 | 核心指令 / 命令行触发 | 产物形态 (Artifact) | 任务终态 |
| :--- | :--- | :--- | ---: | :---: | :--- | :--- | :---: |
| `01-Lint` | `All / Multi-OS Node.js 22` | `<kbd>github-hosted-ubuntu</kbd>` | `1m 12s` | 8 | `npm run typecheck && npm run lint` | `eslint-report.json` (4.2 MB) | 🟢 `PASSED` |
| `02-Rust-Core` | `x86_64-unknown-linux-gnu` | `<kbd>c6i.4xlarge-baremetal</kbd>` | `4m 38s` | 16 | `cargo build --release --workspace` | `libconex_core.so` (18.4 MB) | 🟢 `PASSED` |
| `02-Rust-Core` | `aarch64-unknown-linux-gnu` | `<kbd>c7g.4xlarge-graviton3</kbd>` | `5m 02s` | 16 | `cross build --target aarch64 --release` | `libconex_core.so` (17.8 MB) | 🟢 `PASSED` |
| `02-Rust-Core` | `aarch64-apple-darwin (M3 Pro)` | `<kbd>mac-mini-m3-fleet-04</kbd>` | `3m 15s` | 12 | `cargo test --workspace --target ...` | `conex-desktop.dmg` (64.2 MB) | 🟢 `PASSED` |
| `02-Rust-Core` | `x86_64-pc-windows-msvc` | `<kbd>win-srv-2022-executor</kbd>` | `8m 45s` | 8 | `cargo.exe build --release --locked` | `conex-setup.exe` (78.9 MB) | 🟡 `SLOW` |
| `03-Unit-Test` | `Browser / Vitest Headless` | `<kbd>ubuntu-latest-parallel</kbd>` | `2m 20s` | 4 | `vitest run --coverage --project=unit` | `coverage/lcov.info` (12.1 MB) | 🟢 `PASSED` |
| `04-E2E-Playwright`| `Chromium + WebKit + Firefox` | `<kbd>k8s-pod-dind-cluster</kbd>` | `12m 40s` | 12 | `playwright test tests/e2e/` | `playwright-report/` (145 MB) | 🟢 `PASSED` |
| `05-Security` | `Container Vulnerability Check` | `<kbd>security-scanner-agent</kbd>` | `1m 55s` | 2 | `trivy image --severity HIGH,CRITICAL` | `sarif-vulnerability.json` | 🟢 `PASSED` |

---

### 4.2 容器镜像安全与合规扫描审计表（包含 Shell 管道符与 CVE 字典）

*测试重点：单元格内包含 Shell 管道符 `\|`（例如 `docker scan \| grep`）、代码块反引号、严重级别徽章与修复指令。*

| 镜像组件名称 | 扫描镜像 Tag | 漏洞编号 (CVE ID) | 严重级别 | 触发代码包与引入版本 | 修复建议版本 | 快速验证与修复指令 (Shell Pipe Escaped) |
| :--- | :--- | :---: | :---: | :--- | :--- | :--- |
| `conex/gateway` | `v2.4.1-alpine` | [CVE-2025-14201](https://cve.mitre.org) | 🔴 `CRITICAL` | `openssl@3.0.8-r0` | `openssl>=3.0.13-r0` | `apk update \|\| apk add --upgrade openssl` |
| `conex/worker` | `v1.9.0-slim` | [CVE-2024-45337](https://cve.mitre.org) | 🟠 `HIGH` | `golang.org/x/crypto@v0.18.0` | `golang.org/x/crypto@v0.21.0` | `go get -u golang.org/x/crypto \| go mod tidy` |
| `conex/frontend`| `sha-88fa29c` | [CVE-2025-22150](https://cve.mitre.org) | 🟡 `MEDIUM` | `axios@1.6.2` | `axios>=1.7.4` | `npm audit fix --force \| tee audit.log` |
| `conex/db-proxy`| `v3.1.2-distroless` | [CVE-2024-38526](https://cve.mitre.org) | 🟢 `LOW` | `pypa-urllib3@2.0.7` | `pypa-urllib3>=2.2.2` | `pip install --upgrade urllib3 \|\| echo "retry"` |

---

## 五、嵌套块与复杂容器嵌套表格测试 (Nested Block & Container Table Stress Suite)

本章节验证混合渲染器在不同缩进层级、块级容器（列表、引用、折叠卡片）内渲染表格时的**几何缩进守恒与边距测量**。

### 5.1 列表项内部嵌套表格（有序列表、无序列表、任务列表嵌套）

1. **第一层有序列表项：微服务数据库集群拆分现状**
   
   以下为当前订单库、账务库、库存库的垂直拆分与分库分表键对照：

   | 数据库标识 (DB Name) | 拆分策略 (Sharding Mode) | 分片键 (Shard Key) | 物理节点数 | 单库容量上限 | 备份频次 |
   | :--- | :---: | :--- | ---: | ---: | :---: |
   | `db_orders_cluster` | 范围 + 散列分片 | `user_id % 64` | 32 组 (Master-Slave) | 10 TB | 每日全量 + 实时增量 |
   | `db_account_ledger` | 按租户与年份物理隔离 | `(tenant_id, fiscal_year)` | 16 组 (Raft 3节点) | 25 TB | 实时三地容灾 |
   | `db_stock_inventory`| 全局分布式缓存同步 | `sku_id_hash` | 8 组 (Redis-Cluster) | 2 TB | 每日两次快照 |

   * 说明：分库分表迁移将于下月凌晨系统维护窗口执行，要求业务写入暂停时间不超过 3 分钟。

2. **第二层无序任务清单与操作矩阵嵌套**
   - [x] 完成只读备库搭建与数据校验
   - [x] 验证网关双写分流（Shadow Traffic）
   - [ ] 线上生产流量切换并核验：
     
     | 检查项序号 | 验证指标 | 阈值标准 | 当前采样值 | 判定结论 |
     | :---: | :--- | :--- | ---: | :---: |
     | `CHK-01` | 主从复制延迟 (Replica Lag) | `< 50ms` | `12ms` | 🟢 正常 |
     | `CHK-02` | 连接池活跃占用率 | `< 75%` | `48%` | 🟢 正常 |
     | `CHK-03` | 慢查询计数 (Execution > 200ms)| `0 / min` | `3 / min` | 🟡 警告 (可控) |

---

### 5.2 引用块（Blockquote）内部嵌套复杂表格（单层与多层引用深度）

> [!IMPORTANT]
> **以下内容属于首席架构师批准的灾备演练基线规则，禁止未经审计私自更改：**
> 
> | 演练等级 | 故障模拟范围 | 涉及团队 | 启动审批权限 | 熔断撤退时限 | 演练频率 |
> | :---: | :--- | :--- | :--- | :---: | :---: |
> | `Tier-1` | 单可用区 (AZ) 网络光缆切断 | SRE、基础设施组 | 基础架构总监 | `15 分钟` | 每季度一次 |
> | `Tier-2` | 核心认证中心数据库机房宕机 | SRE、安全组、交易组 | 事业部 CTO | `30 分钟` | 每半年一次 |
> | `Tier-3` | 跨国海底光缆大规模拥塞丢包 | 全研发团队联动 | 集团执行副总裁 | `60 分钟` | 每年一次 |
>
> > [!NOTE]
> > **双层嵌套引用深入测试（Nested Blockquote Level 2）：**
> > 
> > | 嵌套参数 | 数据类型 | 默认缺省值 | 含义解释与约束说明 |
> > | :--- | :---: | :---: | :--- |
> > | `failover.auto_promote` | `boolean` | `true` | 是否允许主库宕机后 Raft 集群在 3000ms 内自动选主提权 |
> > | `failover.max_lag_bytes` | `uint64` | `1048576` | 从库同步落后最大允许字节数，超过该值时剔除候选资格 |

---

### 5.3 折叠容器（`<details>`）内的审计对账表

<details>
<summary><b>点击展开：2025 财年未决历史账项明细（共 4 笔高风险关联账项）</b></summary>

| 传票流水号 | 记账日期 | 发生机构 | 借方金额 (Dr) | 贷方金额 (Cr) | 对冲状态 | 异常备注说明 |
| :--- | :---: | :--- | ---: | ---: | :---: | :--- |
| `TX-9901-A` | `2025-01-14` | 硅谷离岸研发中心 | `$45,000.00` | `$0.00` | 🔴 未平 | 银行跨境 Swift 手续费结算单据遗失，正在补办公证 |
| `TX-9902-B` | `2025-02-28` | 新加坡亚太销售中心 | `$0.00` | `$120,400.00` | 🟡 挂账 | 客户预付款汇入但商务合同尚未完成签署盖章流程 |
| `TX-9903-C` | `2025-03-12` | 伦敦数据中心托管商 | `$88,200.00` | `$0.00` | 🟢 已核 | 已在 3 月底对账闭环，冲抵机房电力超标罚金 |
| `TX-9904-D` | `2025-03-31` | 集团投资与资产管理 | `$0.00` | `$500,000.00` | 🔴 未平 | 产业引导基金跟投专项款项，待董事会第三季度决议生效 |

</details>

---

## 六、极限排版边界与异常压力测试 (Edge Case & Boundary Stress Matrix)

本章节专门为渲染器的鲁棒性（Robustness）测试设计，包含极端长度、极端空白、高频换行与连续转义符。

### 6.1 极端列宽跨度对比表（1 字符列至 350 字符无空格连续串）

*测试重点：列 1 只有单字符、列 2 空白、列 4 为极长连续无空格字符（如 JWT 字符串与加密公钥），检验 CSS 换行断字规则（`word-break: break-all`）与表格宽度约束。*

| # | 空 | 标识 | 超长连续不可断行密文字符串 (Base64 / JWT / Public Key) | 状态 | 备注说明 |
| :-: | :---: | :---: | :--- | :---: | :--- |
| 1 | | A | `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImNvbmV4LWFwaS0yMDI1LWsxIn0.eyJpc3MiOiJhdXRoLmNvbmV4LmlvIiwic3ViIjoidXNyXzA5YWY4OGRhOTk4YzA4YzEiLCJhdWQiOlsiYXBpLmdhdGV3YXkiLCJiaWxsaW5nLnN2YyJdLCJleHAiOjE3NzI4MTkyMDAsIm5iZiI6MTcwOTY4MzIwMCwiaWF0IjoxNzA5NjgzMjAwLCJqdGkiOiJjZjhhMmIxNC1kZTEyLTQxNWYtODhhMi00OWFlMDI5ODU2MTEiLCJyb2xlcyI6WyJzeXN0ZW1fYWRtaW4iLCJmaW5hbmNlX2F1ZGl0b3IiLCJkZXZvcHNfb3BlcmF0b3IiXX0.k9zWq6s5L3V2X8p1...` | ✓ | 标准 JWT 长度测试 |
| 2 | | B | `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` | ✓ | 160 字符连续 Hex 字符串 |
| 3 | | C | `https://gateway.internal.cluster.corp.domain.net:9443/v1/subsystem/organization/tenants/998124/workspaces/882194/deployments/cluster-ap-northeast-1b/services/payment-gateway-proxy/metrics?filter=metric_name%3Dhttp_requests_total%7Bstatus%3D500%7D&step=15s&range=24h&timezone=Asia%2FShanghai` | ✓ | 260 字符超长无空格 URL |
| 4 | | D | `-` | ✗ | 单横线测试 |

---

### 6.2 密集连续换行与稀疏矩阵（HeightMap 垂直伸缩与多管道连击）

*测试重点：单单元格内包含多达 8 个连续 `<br>` 换行；测试多列管道转义连击 `\|\|`；测试空值占比达到 70% 的稀疏矩阵表现。*

| 索引编号 | 多管道连击转义测试 (`\|`) | 8 阶连续换行拉伸单元格 (HeightMap Stress) | 稀疏列 A | 稀疏列 B | 稀疏列 C | 终检 |
| :---: | :--- | :--- | :---: | :---: | :---: | :---: |
| `SP-001` | `val = a \|\| b \|\| c \|\| d;` | Line 1: 初始化配置装载<br>Line 2: 校验内核版本兼容性<br>Line 3: 分配内存共享缓冲区<br>Line 4: 挂载虚拟文件系统<br>Line 5: 启动监听套接字 0.0.0.0:80<br>Line 6: 注册 Consul 节点发现<br>Line 7: 上报网关首次心跳信号<br>Line 8: 服务正式就绪接收外部流量 | `Active` | | | 🟢 |
| `SP-002` | `cmd: sed 's/\|/_/g' \| grep -E 'x\|y'`| 紧凑单行对比测试 | | `Pending` | | 🟡 |
| `SP-003` | `regex: ^(\|[0-9]+\|)+$` | 行内代码测试：`fmt.Sprintf("\|%d\|", id)` | | | `Failed` | 🔴 |
| `SP-004` | `a\|b\|c` | Line A: 第一行附注说明<br>Line B: 第二行附注说明 | | | | ⚪ |

---

## 七、渲染引擎排版与 HeightMap 验收要点 (Engine Verification Checklist)

为了保障本示例集在编辑器运行期具备零位移、零闪烁与完美的交互响应，请根据以下技术清单核验混合渲染引擎各子系统：

1. **HeightMap 行高测量真实度 (HeightMap Line Measurement)**：
   - 验证 `1.2` 节与 `6.2` 节中的多重 `<br>` 单元格：渲染层必须动态拉伸该行的高度节点（`HeightMap.updateLine(lineIndex, domHeight)`），避免光标点击下方文本时产生上下偏移（Jitter）。
   - 验证表格滚动离开视口再滚回时，虚拟滚动高度计算的绝对恒等性（Zero Drift）。
2. **列宽分配算法与横向滚动机制 (Column Width Allocation & Horizontal Scroll)**：
   - 在 10 列超宽表格（`1.1` 节、`3.1` 节）中，容器应保持自身的视口边界，并在超出时启用内部平滑水平滚动条（`overflow-x: auto`），禁止将外层页面布局撑爆。
   - 对齐模式测试：核对 `:---:` 居中列、`---:` 右对齐列在包含 RichText 元素（如徽章、代码块）时依然维持垂直和水平对称。
3. **转义管道符解析与 AST 鲁棒性 (Escaped Pipe Parsing & AST Robustness)**：
   - 验证在 `\|` 出现在正则表达式、代码块或 SQL 查询时，词法解析器不会将其误切为单元格分隔符（`table_pipe`），保证整行列数严格守恒。
4. **两步点击状态机与选区映射 (Cell Selection & 2-Click Edit State Machine)**：
   - 单击单元格：激活单元格选区（`is-cell-selected` 高亮边框），支持 <kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> / <kbd>Enter</kbd> 跨单元格快速导航。
   - 双击单元格：切换为文本行内编辑（`is-cell-editing`），行内富文本平滑无缝展开为原始 Markdown 语法，光标精确定位至点击字符处。
5. **块级容器边界守恒 (Container Indentation Invariance)**：
   - 在 `5.1` 节（列表缩进 4 空格）与 `5.2` 节（引用块 `>` 缩进）中，表格应在容器的边距计算约束内自适应渲染，左边框与缩进引导线严格对齐。
