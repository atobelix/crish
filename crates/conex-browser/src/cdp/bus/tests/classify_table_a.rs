use super::*;

/// 分类 router 冒烟：导航/对话框/网络/目标事件全表转译。
#[test]
fn bus_classify_smoke() {
    let e = raw(
        "Page.frameNavigated",
        json!({ "frame": { "id": "F1", "url": "https://e.com", "parentId": null } }),
        Some("S1"),
    );
    assert_eq!(
        classify(&e).unwrap(),
        BrowserEvent::Navigated {
            session: "S1".to_string(),
            frame: "F1".to_string(),
            url: "https://e.com".to_string(),
            main: true,
        }
    );

    let e = raw(
        "Target.attachedToTarget",
        json!({
            "sessionId": "S2",
            "targetInfo": { "targetId": "T2", "type": "page", "title": "t", "url": "u" },
            "waitingForDebugger": false
        }),
        None,
    );
    assert_eq!(
        classify(&e).unwrap(),
        BrowserEvent::SessionAttached {
            target_id: "T2".to_string(),
            session: "S2".to_string()
        }
    );

    let e = raw(
        "Page.javascriptDialogOpening",
        json!({ "url": "https://e.com", "message": "hello", "type": "alert", "defaultPrompt": null }),
        Some("S1"),
    );
    assert!(matches!(
        classify(&e).unwrap(),
        BrowserEvent::DialogOpened(_)
    ));

    // 未知事件宽容忽略
    let e = raw("Foo.bar", json!({}), None);
    assert!(classify(&e).is_err());
}

// ---------- 全事件转译表（评审 P2 补强：wire → typed 逐变体断言） ----------

/// Target 域：targetCreated / targetInfoChanged / targetDestroyed / attachedToTarget。
#[test]
fn bus_table_target_domain() {
    let info = json!({
        "targetId": "T1",
        "type": "page",
        "title": "标题",
        "url": "https://a.example",
        "attached": true,
        "browserContextId": "BC1",
        "openerId": "T0",
    });
    // targetCreated → TargetCreated 全字段透传
    let got = classify(&raw(
        "Target.targetCreated",
        json!({ "targetInfo": info }),
        None,
    ))
    .expect("targetCreated 应转译");
    match got {
        BrowserEvent::TargetCreated(t) => {
            assert_eq!(t.target_id, "T1");
            assert_eq!(t.target_type, "page");
            assert_eq!(t.title, "标题");
            assert_eq!(t.url, "https://a.example");
            assert_eq!(t.attached, Some(true));
            assert_eq!(t.browser_context_id.as_deref(), Some("BC1"));
            assert_eq!(t.opener_id.as_deref(), Some("T0"));
        }
        other => panic!("应为 TargetCreated，实际 {other:?}"),
    }
    // targetInfoChanged → TargetInfoChanged
    let got = classify(&raw(
        "Target.targetInfoChanged",
        json!({ "targetInfo": info }),
        None,
    ))
    .expect("targetInfoChanged 应转译");
    assert!(matches!(got, BrowserEvent::TargetInfoChanged(t) if t.target_id == "T1"));
    // targetDestroyed → TargetDestroyed
    let got = classify(&raw(
        "Target.targetDestroyed",
        json!({ "targetId": "T9" }),
        None,
    ))
    .expect("targetDestroyed 应转译");
    assert_eq!(
        got,
        BrowserEvent::TargetDestroyed {
            target_id: "T9".to_string()
        }
    );
    // attachedToTarget → SessionAttached（双层路由建立点）
    let got = classify(&raw(
        "Target.attachedToTarget",
        json!({
            "sessionId": "S2",
            "targetInfo": { "targetId": "T2", "type": "page", "title": "t", "url": "u" },
            "waitingForDebugger": false,
        }),
        None,
    ))
    .expect("attachedToTarget 应转译");
    assert_eq!(
        got,
        BrowserEvent::SessionAttached {
            target_id: "T2".to_string(),
            session: "S2".to_string()
        }
    );
    // detachedFromTarget → 显式忽略
    assert!(
        classify(&raw(
            "Target.detachedFromTarget",
            json!({ "sessionId": "S2" }),
            None
        ))
        .is_err(),
        "detachedFromTarget 不订阅"
    );
}

/// 导航面：frameStartedNavigating / frameNavigated 主次帧 / navigatedWithinDocument /
/// domContent / load 生命周期。
#[test]
fn bus_table_navigation_domain() {
    // frameStartedNavigating → NavigationStarted（FrameInfo 全字段宽容解析）
    let got = classify(&raw(
        "Page.frameStartedNavigating",
        json!({ "frame": { "id": "F1", "url": "https://n.example" } }),
        Some("S1"),
    ))
    .expect("frameStartedNavigating 应转译");
    assert_eq!(
        got,
        BrowserEvent::NavigationStarted {
            session: "S1".to_string(),
            frame: "F1".to_string(),
            url: "https://n.example".to_string()
        }
    );
    // frameNavigated 主帧（parentId 缺省）→ main=true
    let got = classify(&raw(
        "Page.frameNavigated",
        json!({ "frame": { "id": "F1", "url": "https://e.com", "parentId": null } }),
        Some("S1"),
    ))
    .expect("frameNavigated 应转译");
    assert_eq!(
        got,
        BrowserEvent::Navigated {
            session: "S1".to_string(),
            frame: "F1".to_string(),
            url: "https://e.com".to_string(),
            main: true
        }
    );
    // frameNavigated 子帧（parentId 存在）→ main=false
    let got = classify(&raw(
        "Page.frameNavigated",
        json!({ "frame": { "id": "F2", "url": "https://i.example", "parentId": "F1" } }),
        Some("S1"),
    ))
    .expect("子帧应转译");
    assert_eq!(
        got,
        BrowserEvent::Navigated {
            session: "S1".to_string(),
            frame: "F2".to_string(),
            url: "https://i.example".to_string(),
            main: false
        }
    );
    // navigatedWithinDocument（SPA pushState/hash）
    let got = classify(&raw(
        "Page.navigatedWithinDocument",
        json!({ "frameId": "F1", "url": "https://e.com/#/route" }),
        Some("S1"),
    ))
    .expect("navigatedWithinDocument 应转译");
    assert_eq!(
        got,
        BrowserEvent::NavigatedWithinDocument {
            session: "S1".to_string(),
            frame: "F1".to_string(),
            url: "https://e.com/#/route".to_string()
        }
    );
    // domContentEventFired / loadEventFired → Lifecycle
    let got = classify(&raw(
        "Page.domContentEventFired",
        json!({ "timestamp": 1.0 }),
        Some("S1"),
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::Lifecycle {
            session: "S1".to_string(),
            frame: String::new(),
            kind: LifecycleKind::DomContent
        }
    );
    let got = classify(&raw(
        "Page.loadEventFired",
        json!({ "timestamp": 2.0 }),
        Some("S1"),
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::Lifecycle {
            session: "S1".to_string(),
            frame: String::new(),
            kind: LifecycleKind::Load
        }
    );
}

/// DOM 域七子类 + frameAttached/frameDetached 归并 → DomChanged 全子类。
#[test]
fn bus_table_dom_domain() {
    let cases = [
        ("DOM.documentUpdated", DomChangeKind::DocumentUpdated),
        ("DOM.childNodeInserted", DomChangeKind::ChildNodeInserted),
        ("DOM.childNodeRemoved", DomChangeKind::ChildNodeRemoved),
        (
            "DOM.characterDataModified",
            DomChangeKind::CharacterDataModified,
        ),
        ("DOM.attributeModified", DomChangeKind::AttributeModified),
        ("DOM.attributeRemoved", DomChangeKind::AttributeRemoved),
        ("DOM.setChildNodes", DomChangeKind::SetChildNodes),
    ];
    for (method, kind) in cases {
        let got = classify(&raw(method, json!({}), Some("S1"))).expect("应转译");
        assert_eq!(
            got,
            BrowserEvent::DomChanged {
                session: "S1".to_string(),
                kind
            },
            "{method}"
        );
    }
    // frameAttached / frameDetached 归入 DOM 合并窗口子类
    let got = classify(&raw(
        "Page.frameAttached",
        json!({ "frameId": "F3", "parentFrameId": "F1" }),
        Some("S1"),
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::DomChanged {
            session: "S1".to_string(),
            kind: DomChangeKind::FrameAttached
        }
    );
    let got = classify(&raw(
        "Page.frameDetached",
        json!({ "frameId": "F3", "reason": "remove" }),
        Some("S1"),
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::DomChanged {
            session: "S1".to_string(),
            kind: DomChangeKind::FrameDetached
        }
    );
    // session 缺省 → 空串（宽容解析）
    let got = classify(&raw("DOM.documentUpdated", json!({}), None)).unwrap();
    assert_eq!(
        got,
        BrowserEvent::DomChanged {
            session: String::new(),
            kind: DomChangeKind::DocumentUpdated
        }
    );
}

/// 对话框/弹窗面：javascriptDialogOpening（含 defaultPrompt）/ javascriptDialogClosed /
/// windowOpen。
#[test]
fn bus_table_dialog_domain() {
    // opening：全字段 + defaultPrompt 透传
    let got = classify(
        &raw(
            "Page.javascriptDialogOpening",
            json!({ "url": "https://e.com", "message": "确认操作？", "type": "prompt", "defaultPrompt": "默认值" }),
            Some("S1"),
        ),
    )
    .expect("opening 应转译");
    match got {
        BrowserEvent::DialogOpened(info) => {
            assert_eq!(info.session, "S1");
            assert_eq!(info.dialog_type, "prompt");
            assert_eq!(info.message, "确认操作？");
            assert_eq!(info.url, "https://e.com");
            assert_eq!(info.default_prompt.as_deref(), Some("默认值"));
        }
        other => panic!("应为 DialogOpened，实际 {other:?}"),
    }
    // defaultPrompt 为 null → None
    let got = classify(&raw(
        "Page.javascriptDialogOpening",
        json!({ "url": "u", "message": "m", "type": "alert", "defaultPrompt": null }),
        Some("S1"),
    ))
    .unwrap();
    assert!(matches!(got, BrowserEvent::DialogOpened(info) if info.default_prompt.is_none()));
    // closed：result=true/false
    let got = classify(&raw(
        "Page.javascriptDialogClosed",
        json!({ "result": true, "userGesture": true }),
        Some("S1"),
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::DialogClosed {
            session: "S1".to_string(),
            accepted: true
        }
    );
    let got = classify(&raw(
        "Page.javascriptDialogClosed",
        json!({ "result": false }),
        Some("S1"),
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::DialogClosed {
            session: "S1".to_string(),
            accepted: false
        }
    );
    // windowOpen → WindowOpenRequested
    let got = classify(
        &raw("Page.windowOpen", json!({ "url": "https://pop.example", "windowName": "w", "windowFeatures": ["width=100"], "userGesture": true }), Some("S1")),
    )
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::WindowOpenRequested {
            url: "https://pop.example".to_string(),
            session: "S1".to_string()
        }
    );
}
