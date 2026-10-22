use super::*;

/// 非法 JSON / 空对象 / 往返序列化。
#[test]
fn parse_tolerance_and_roundtrip() {
    assert!(matches!(
        parse_storage_state("{ not json !!"),
        Err(StorageStateError::Json(_))
    ));
    let empty = parse_storage_state("{}").expect("空对象");
    assert!(empty.cookies.is_empty() && empty.origins.is_empty());
    assert_eq!(empty.to_json(), r#"{"cookies":[],"origins":[]}"#);
    // 往返：导出 → 序列化 → 解析 → 注入参数一致
    let cookies = vec![cdp_cookie(|c| {
        c.name = "roundtrip".to_string();
    })];
    let state = export_storage_state(&cookies, ExportAuthorization::Confirmed).expect("导出");
    let json = state.to_json();
    let reparsed = parse_storage_state(&json).expect("重解析");
    assert_eq!(state, reparsed, "导出 → 序列化 → 解析往返一致");
}

// -------------------------------------------------------------------
// localStorage 注入/导出执行面（§5.3 / J1b 接线点）
// -------------------------------------------------------------------

/// 记录型 mock 通道（注入执行面断言：调用序与参数）。
#[derive(Default)]
struct RecordingChannel {
    calls: std::sync::Mutex<Vec<ChannelCall>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ChannelCall {
    InitScript(String),
    SetItem {
        origin: String,
        key: String,
        value: String,
    },
    GetItems(String),
}

#[async_trait]
impl LocalStorageChannel for RecordingChannel {
    async fn add_init_script(&self, source: &str) -> Result<(), StorageStateError> {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(ChannelCall::InitScript(source.to_string()));
        Ok(())
    }

    async fn set_dom_storage_item(
        &self,
        security_origin: &str,
        key: &str,
        value: &str,
    ) -> Result<(), StorageStateError> {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(ChannelCall::SetItem {
                origin: security_origin.to_string(),
                key: key.to_string(),
                value: value.to_string(),
            });
        Ok(())
    }

    async fn get_dom_storage_items(
        &self,
        security_origin: &str,
    ) -> Result<Vec<(String, String)>, StorageStateError> {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(ChannelCall::GetItems(security_origin.to_string()));
        Ok(vec![("theme".to_string(), "dark".to_string())])
    }
}

/// 双 origin 注入计划 fixture（每 origin 含守卫脚本与直写条目）。
fn example_plan() -> ImportPlan {
    let json = r#"{
            "cookies": [],
            "origins": [
                {
                    "origin": "https://example.com",
                    "localStorage": [
                        { "name": "theme", "value": "dark" },
                        { "name": "token", "value": "abc" }
                    ]
                },
                {
                    "origin": "https://sub.example.org",
                    "localStorage": [ { "name": "k", "value": "v" } ]
                }
            ]
        }"#;
    build_import_plan(&parse_storage_state(json).expect("解析"))
}

/// 注入执行（§5.3）：脚本注册 + 直写调用序与参数断言（mock 通道）。
#[tokio::test]
async fn inject_origin_scripts_executes_channel() {
    let channel = RecordingChannel::default();
    let plan = example_plan();
    let stats = inject_origin_scripts(&channel, &plan).await.expect("注入");
    assert_eq!(stats.scripts, 2, "每 origin 一条守卫脚本");
    assert_eq!(stats.items, 3, "直写条目总数");
    let calls = channel.calls.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(calls.len(), 5);
    // 调用序：每 origin 先注册守卫脚本，再逐条直写
    assert!(
        matches!(&calls[0], ChannelCall::InitScript(s)
                if s.contains(r#"window.location.origin !== "https://example.com""#)),
        "脚本须含 origin 守卫且指向目标 origin"
    );
    assert!(
        matches!(&calls[1], ChannelCall::SetItem { origin, key, value }
                if origin == "https://example.com" && key == "theme" && value == "dark")
    );
    assert!(matches!(&calls[2], ChannelCall::SetItem { origin, key, .. }
                if origin == "https://example.com" && key == "token"));
    assert!(matches!(&calls[3], ChannelCall::InitScript(s) if s.contains("sub.example.org")));
    assert!(
        matches!(&calls[4], ChannelCall::SetItem { origin, key, value }
                if origin == "https://sub.example.org" && key == "k" && value == "v")
    );
}

/// origin 守卫（storageId securityOrigin）：非法 origin 拒绝——任何 CDP
/// 命令均不发出（防御性再检，正常 parse 已拦截非法 origin）。
#[tokio::test]
async fn inject_origin_scripts_rejects_illegal_origin() {
    let channel = RecordingChannel::default();
    // 手工构造带非法 origin 的计划（验证执行面防御性再检）
    let plan = ImportPlan {
        cookies: vec![],
        origin_scripts: vec![OriginScript {
            origin: "javascript:alert(1)".to_string(),
            source: "(() => {})();".to_string(),
            items: vec![StorageItem {
                name: "k".to_string(),
                value: "v".to_string(),
            }],
        }],
        stats: ImportStats::default(),
    };
    assert!(matches!(
        inject_origin_scripts(&channel, &plan).await,
        Err(StorageStateError::InvalidOrigin { .. })
    ));
    assert!(
        channel
            .calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty(),
        "非法 origin 不得发出任何 CDP 命令"
    );
}

/// 幂等（重复导入覆盖语义）：同 (origin, key) 二次注入值一致、无错误；
/// 变更值重导 → 最后一次值胜（直写 setItem 覆盖语义）。
#[tokio::test]
async fn inject_origin_scripts_idempotent_overwrite() {
    let channel = RecordingChannel::default();
    let json = r#"{"cookies":[],"origins":[{"origin":"https://example.com","localStorage":[{"name":"theme","value":"dark"}]}]}"#;
    let plan = build_import_plan(&parse_storage_state(json).expect("解析"));
    inject_origin_scripts(&channel, &plan)
        .await
        .expect("首次导入");
    inject_origin_scripts(&channel, &plan)
        .await
        .expect("重复导入（同值）");
    let set_values = |channel: &RecordingChannel| -> Vec<String> {
        channel
            .calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter_map(|c| match c {
                ChannelCall::SetItem { key, value, .. } if key == "theme" => Some(value.clone()),
                _ => None,
            })
            .collect()
    };
    assert_eq!(
        set_values(&channel),
        vec!["dark", "dark"],
        "同值重复导入稳定无错"
    );
    // 变更值重导 → 覆盖语义（最后一次值胜）
    let json2 = r#"{"cookies":[],"origins":[{"origin":"https://example.com","localStorage":[{"name":"theme","value":"light"}]}]}"#;
    let plan2 = build_import_plan(&parse_storage_state(json2).expect("解析"));
    inject_origin_scripts(&channel, &plan2)
        .await
        .expect("覆盖导入");
    assert_eq!(
        set_values(&channel),
        vec!["dark", "dark", "light"],
        "覆盖语义：最后一次值胜"
    );
}

/// 导出聚合读取（§5.2 可选）：getDOMStorageItems 按 origin 读取（含尾部
/// 斜杠归一化）+ origin 守卫（非法 origin 不发命令）。
#[tokio::test]
async fn collect_local_storage_reads_with_guard() {
    let channel = RecordingChannel::default();
    let origins = collect_local_storage(
        &channel,
        &[
            "https://example.com".to_string(),
            "https://example.com/".to_string(),
        ],
    )
    .await
    .expect("读取");
    assert_eq!(origins.len(), 2);
    assert_eq!(origins[0].origin, "https://example.com");
    assert_eq!(origins[1].origin, "https://example.com", "尾部斜杠归一化");
    assert_eq!(origins[0].local_storage[0].name, "theme");
    {
        let calls = channel.calls.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0],
            ChannelCall::GetItems("https://example.com".to_string())
        );
    }

    // 非法 origin 拒绝：不发出任何读取命令
    let channel2 = RecordingChannel::default();
    assert!(matches!(
        collect_local_storage(&channel2, &["file:///etc/passwd".to_string()]).await,
        Err(StorageStateError::InvalidOrigin { .. })
    ));
    assert!(
        channel2
            .calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty(),
        "非法 origin 不得发出读取命令"
    );
}

/// 导出扩展面（§5.2）：授权拒绝先于任何 CDP 命令；确认后 cookie + origins
/// 合并。
#[tokio::test]
async fn export_with_origins_auth_and_merge() {
    let channel = RecordingChannel::default();
    let cookies = vec![cdp_cookie(|c| {
        c.name = "sid".to_string();
    })];
    // 授权拒绝：通道零调用
    assert!(matches!(
        export_storage_state_with_origins(
            &cookies,
            &["https://example.com".to_string()],
            ExportAuthorization::Denied,
            &channel,
        )
        .await,
        Err(StorageStateError::NotAuthorized)
    ));
    assert!(
        channel
            .calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty(),
        "授权拒绝不得发出任何 CDP 命令"
    );
    // 确认后：cookie + origins 聚合
    let state = export_storage_state_with_origins(
        &cookies,
        &["https://example.com".to_string()],
        ExportAuthorization::Confirmed,
        &channel,
    )
    .await
    .expect("导出");
    assert_eq!(state.cookies.len(), 1);
    assert_eq!(state.origins.len(), 1);
    assert_eq!(state.origins[0].local_storage[0].name, "theme");
}

/// 导出 origins 推导（§5.2 聚合来源）：唯一 host 一个 origin、协议按
/// secure 标志（任一 secure cookie → https）、前导点去除、非法 host
/// 跳过、输出字典序确定。
#[test]
fn export_origins_from_cookies_derives() {
    let cookies = vec![
        cdp_cookie(|c| {
            c.domain = ".example.com".to_string();
            c.secure = true;
        }),
        cdp_cookie(|c| {
            c.domain = "example.com".to_string();
            c.secure = false; // 同 host 混合 → 任一 secure 即 https
        }),
        cdp_cookie(|c| {
            c.domain = "example.org".to_string();
            c.secure = false; // 纯非 secure → http
        }),
        cdp_cookie(|c| {
            c.domain = "exa mple.com".to_string(); // 含空格 → 无法构成合法 origin
        }),
        cdp_cookie(|c| {
            c.domain = "".to_string(); // 空 host → 跳过
        }),
        cdp_cookie(|c| {
            c.domain = "localhost".to_string();
            c.secure = false;
        }),
    ];
    let origins = export_origins_from_cookies(&cookies);
    assert_eq!(
        origins,
        vec![
            "http://example.org".to_string(),
            "http://localhost".to_string(),
            "https://example.com".to_string(),
        ],
        "去点 + secure 判定 + 非法跳过 + 字典序"
    );
    assert!(
        export_origins_from_cookies(&[]).is_empty(),
        "空 cookie 列表 → 空 origins"
    );
}
