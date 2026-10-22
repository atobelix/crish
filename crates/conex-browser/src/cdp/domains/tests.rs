use super::*;
use serde_json::Value;

/// 类型面冒烟：关键命令参数序列化字段名 camelCase 正确。
#[test]
fn domains_serialize_camel_case() {
    let p = AttachToTargetParams {
        target_id: "T1".to_string(),
        flatten: true,
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["targetId"], "T1");
    assert_eq!(v["flatten"], true);

    let p = HandleJavaScriptDialogParams {
        accept: false,
        prompt_text: None,
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["accept"], false);
    assert!(v.get("promptText").is_none());

    let p = SetBlockedURLsParams {
        urls: vec!["http://10.0.0.0/8".to_string()],
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["urls"][0], "http://10.0.0.0/8");

    // 帧泵 ack 参数（维度 12 §2.1：sessionId 为 screencast 帧会话标识；
    // Value 形态无损透传——数字（Chrome 151 实测）与字符串均可）
    let p = ScreencastFrameAckParams {
        session_id: Value::String("S1".to_string()),
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["sessionId"], "S1");
    assert_eq!(v.as_object().unwrap().len(), 1, "只含 sessionId 一个字段");
    // Chrome 151 数字形态：保持数字（类型敏感，字符串化被 Chrome 拒绝）
    let p = ScreencastFrameAckParams {
        session_id: Value::from(1),
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(
        v["sessionId"],
        Value::from(1),
        "数字形态保持数字（Chrome 151 校验类型）"
    );
}

/// SetCookieParam wire 序列化回归（N2 缺陷：可选字段 None 曾输出 null，
/// 被 Chrome 151 拒绝）：None 字段必须省略（逐字段断言），
/// Some 字段正常输出；SetCookiesParams / StorageSetCookiesParams 外层
/// 容器同样不得携带 null 键。
#[test]
fn set_cookie_param_omits_none_fields() {
    // 全部可选字段 None：wire 只含 name/value 两键
    let p = SetCookieParam {
        name: "n".to_string(),
        value: "v".to_string(),
        domain: None,
        url: None,
        path: None,
        expires: None,
        http_only: None,
        secure: None,
        same_site: None,
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    let obj = v.as_object().expect("应为对象");
    for key in [
        "domain", "url", "path", "expires", "httpOnly", "secure", "sameSite",
    ] {
        assert!(
            !obj.contains_key(key),
            "可选字段 `{key}` 为 None 时必须省略而非输出 null（Chrome 151 拒绝）"
        );
    }
    assert_eq!(obj.len(), 2, "仅 name/value 两键");
    assert_eq!(v["name"], "n");
    assert_eq!(v["value"], "v");

    // 部分可选字段 Some：对应键存在且值正确，其余仍省略
    let p = SetCookieParam {
        name: "sid".to_string(),
        value: "abc".to_string(),
        domain: Some(".example.com".to_string()),
        url: None,
        path: Some("/".to_string()),
        expires: Some(1_750_000_000.0),
        http_only: Some(true),
        secure: Some(false),
        same_site: Some("Lax".to_string()),
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["domain"], ".example.com");
    assert_eq!(v["path"], "/");
    assert_eq!(v["expires"], 1_750_000_000.0);
    assert_eq!(v["httpOnly"], true);
    assert_eq!(v["secure"], false);
    assert_eq!(v["sameSite"], "Lax");
    assert!(v.get("url").is_none(), "None 的 url 必须省略");

    // url 形态（domain 为 None）：url 键存在，domain 省略
    let p = SetCookieParam {
        name: "sid".to_string(),
        value: "abc".to_string(),
        domain: None,
        url: Some("https://example.com/".to_string()),
        path: None,
        expires: None,
        http_only: None,
        secure: None,
        same_site: None,
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["url"], "https://example.com/");
    assert_eq!(v.as_object().unwrap().len(), 3, "name/value/url 三键");
    assert!(v.get("domain").is_none());

    // 外层容器：SetCookiesParams / StorageSetCookiesParams 的 cookies 数组
    // 内不得出现 null 键（N2 缺陷的完整 wire 面）
    let cookie = SetCookieParam {
        name: "sid".to_string(),
        value: "abc".to_string(),
        domain: Some("example.com".to_string()),
        url: None,
        path: None,
        expires: None,
        http_only: None,
        secure: None,
        same_site: None,
    };
    let set = SetCookiesParams {
        cookies: vec![cookie.clone()],
    };
    let v = serde_json::to_value(&set).expect("序列化失败");
    let wire = serde_json::to_string(&set).expect("序列化失败");
    assert!(
        !wire.contains("null"),
        "Network.setCookies wire 不得含 null：{wire}"
    );
    assert_eq!(v["cookies"][0]["domain"], "example.com");
    assert_eq!(v["cookies"][0].as_object().unwrap().len(), 3);

    let storage = StorageSetCookiesParams {
        cookies: vec![cookie],
        browser_context_id: None,
    };
    let wire = serde_json::to_string(&storage).expect("序列化失败");
    assert!(
        !wire.contains("null"),
        "Storage.setCookies wire 不得含 null：{wire}"
    );
    let v = serde_json::to_value(&storage).expect("序列化失败");
    assert_eq!(v["cookies"][0]["domain"], "example.com");
    assert!(v.get("browserContextId").is_none());
}

/// 结果反序列化冒烟（含容错字段）。
#[test]
fn domains_deserialize_results() {
    let v: BrowserVersionResult = serde_json::from_str(
        r#"{"protocolVersion":"1.3","product":"Chrome/131.0.6778.204",
                "revision":"@abc","userAgent":"ua","jsVersion":"13.1.71","WebKit-Version":"537.36"}"#,
    )
    .expect("版本信息解析失败");
    assert_eq!(v.major_version(), 131);

    let t: TargetInfo = serde_json::from_str(
        r#"{"targetId":"T1","type":"page","title":"t","url":"https://e.com"}"#,
    )
    .expect("目标信息解析失败");
    assert_eq!(t.target_type, "page");

    let ax: AXNode = serde_json::from_str(r#"{"nodeId":7,"childIds":[1,"2"]}"#).unwrap();
    assert_eq!(ax.node_id, "7");
    assert_eq!(ax.child_ids.unwrap(), vec!["1", "2"]);
}

/// DOM.getFrameOwner / SnapshotDocument.frameId 类型面（维度 13 §1.5
/// 跨域递归依赖：owner 定位 + pierce 帧集合筛选）。
#[test]
fn frame_owner_and_document_frame_id_parse() {
    let owner: GetFrameOwnerResult = serde_json::from_str(r#"{"backendNodeId":101,"nodeId":3}"#)
        .expect("getFrameOwner 结果解析失败");
    assert_eq!(owner.backend_node_id, Some(101));
    assert_eq!(owner.node_id, 3);
    // backendNodeId 缺失形态（协议宽松面）
    let owner: GetFrameOwnerResult =
        serde_json::from_str(r#"{"nodeId":3}"#).expect("缺 backendNodeId 应可解析");
    assert!(owner.backend_node_id.is_none());

    // frameId 字段：池下标（Chrome 151 实测形态）/直出字符串/缺失
    let nodes_json = r#"{"parentIndex":[-1],"nodeType":[9],"nodeName":[0],"nodeValue":[-1]}"#;
    let doc: SnapshotDocument = serde_json::from_str(
        &format!(r#"{{"documentURL":0,"title":1,"frameId":2,"nodes":{nodes_json},"layout":{{"nodeIndex":[],"bounds":[]}}}}"#),
    )
    .expect("含 frameId 文档解析失败");
    let strings = vec!["".to_string(), "".to_string(), "F1".to_string()];
    assert_eq!(
        doc.frame_id.as_ref().unwrap().resolve(&strings),
        "F1",
        "frameId 池下标应经字符串池解析（Chrome 151 实测形态）"
    );
    // 直出字符串形态（宽容面）
    let doc: SnapshotDocument = serde_json::from_str(
        &format!(r#"{{"documentURL":0,"title":1,"frameId":"F2","nodes":{nodes_json},"layout":{{"nodeIndex":[],"bounds":[]}}}}"#),
    )
    .expect("直出 frameId 文档解析失败");
    assert_eq!(doc.frame_id.as_ref().unwrap().resolve(&strings), "F2");
    // 缺失 frameId（旧协议）→ None（向后兼容）
    let doc: SnapshotDocument = serde_json::from_str(
        &format!(r#"{{"documentURL":0,"title":1,"nodes":{nodes_json},"layout":{{"nodeIndex":[],"bounds":[]}}}}"#),
    )
    .expect("无 frameId 文档解析失败");
    assert!(doc.frame_id.is_none(), "缺失 frameId 按 None（向后兼容）");
}

/// DOMStorage 域类型面（维度 16 storage_state 注入/导出聚合）：
/// storageId 双字段（securityOrigin + isLocalStorage）与
/// set/get/remove 参数序列化 + get 结果反序列化。
#[test]
fn dom_storage_domain_serialization() {
    let storage_id = StorageId {
        security_origin: "https://example.com".to_string(),
        is_local_storage: true,
    };
    let v = serde_json::to_value(&storage_id).expect("序列化失败");
    assert_eq!(v["securityOrigin"], "https://example.com");
    assert_eq!(v["isLocalStorage"], true);
    assert_eq!(v.as_object().unwrap().len(), 2, "storageId 只含两字段");

    let p = SetDOMStorageItemParams {
        storage_id: storage_id.clone(),
        key: "theme".to_string(),
        value: "dark".to_string(),
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["storageId"]["securityOrigin"], "https://example.com");
    assert_eq!(v["storageId"]["isLocalStorage"], true);
    assert_eq!(v["key"], "theme");
    assert_eq!(v["value"], "dark");

    let p = GetDOMStorageItemsParams {
        storage_id: storage_id.clone(),
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["storageId"]["securityOrigin"], "https://example.com");
    assert_eq!(v.as_object().unwrap().len(), 1, "只含 storageId 一个字段");

    let p = RemoveDOMStorageItemParams {
        storage_id: storage_id.clone(),
        key: "k".to_string(),
    };
    let v = serde_json::to_value(&p).expect("序列化失败");
    assert_eq!(v["storageId"]["securityOrigin"], "https://example.com");
    assert_eq!(v["key"], "k");

    let r: GetDOMStorageItemsResult =
        serde_json::from_str(r#"{"entries":[["theme","dark"],["k","v1"],["odd"]]}"#)
            .expect("结果解析失败");
    assert_eq!(r.entries.len(), 3);
    assert_eq!(
        r.entries[0],
        vec!["theme".to_string(), "dark".to_string()],
        "entries 为 [name, value] 对"
    );
    // 往返：StorageId 反序列化与序列化一致
    let round: StorageId =
        serde_json::from_value(serde_json::to_value(&storage_id).expect("序列化失败"))
            .expect("反序列化失败");
    assert_eq!(round, storage_id);
}
