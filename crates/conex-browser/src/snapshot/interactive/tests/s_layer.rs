//! S 层强正信号（S1-S7）用例（自 interactive.rs 平移）。

use super::*;

/// S2：原生交互标签全清单。
#[test]
fn s2_native_tags() {
    let a = attrs(&[]);
    for tag in [
        "button", "input", "select", "textarea", "a", "details", "summary", "option", "optgroup",
    ] {
        let c = ctx(
            tag,
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0,
            }),
        );
        assert_eq!(
            decide(&c),
            Decision::Interactive(RuleHit::S2NativeTag),
            "标签 {tag} 应命中 S2"
        );
    }
}

/// S3：ARIA role 属性交互角色集。
#[test]
fn s3_role_attribute() {
    let a = attrs(&[("role", "button")]);
    assert_eq!(
        decide(&ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0
            })
        )),
        Decision::Interactive(RuleHit::S3RoleAttr)
    );
    for role in ["checkbox", "combobox", "tab", "textbox", "searchbox"] {
        let a = attrs(&[("role", role)]);
        assert_eq!(
            decide(&ctx(
                "span",
                &a,
                visible(),
                Some(Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 50.0,
                    height: 20.0
                })
            )),
            Decision::Interactive(RuleHit::S3RoleAttr),
            "role={role} 应命中 S3"
        );
    }
}

/// S4：AX role 交互角色集（含 menubar/tree/grid 扩展）。
#[test]
fn s4_ax_role() {
    let a = attrs(&[]);
    for role in ["menubar", "tree", "grid", "button"] {
        let ax = AxInfo {
            present: true,
            role: Some(role.to_string()),
            ..AxInfo::default()
        };
        let c = DecideCtx {
            tag: "div",
            attributes: &a,
            ax: &ax,
            bounds: Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0,
            }),
            ..ctx("div", &a, visible(), None)
        };
        assert_eq!(
            decide(&c),
            Decision::Interactive(RuleHit::S4AxRole),
            "AX role={role} 应命中 S4"
        );
    }
}

/// S5：AX 交互属性任一为真。
#[test]
fn s5_ax_properties() {
    let a = attrs(&[]);
    for prop in [
        "focusable",
        "editable",
        "checked",
        "expanded",
        "pressed",
        "required",
        "autocomplete",
    ] {
        let mut ax = AxInfo {
            present: true,
            ..AxInfo::default()
        };
        match prop {
            "focusable" => ax.properties.focusable = true,
            "editable" => ax.properties.editable = true,
            "checked" => ax.properties.checked = true,
            "expanded" => ax.properties.expanded = true,
            "pressed" => ax.properties.pressed = true,
            "required" => ax.properties.required = true,
            "autocomplete" => ax.properties.autocomplete = true,
            _ => {}
        }
        let c = DecideCtx {
            tag: "div",
            attributes: &a,
            ax: &ax,
            bounds: Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0,
            }),
            ..ctx("div", &a, visible(), None)
        };
        assert_eq!(
            decide(&c),
            Decision::Interactive(RuleHit::S5AxProperty),
            "{prop} 应命中 S5"
        );
    }
}

/// S6：内联事件属性（onclick/onkeydown/tabindex）。
#[test]
fn s6_inline_events() {
    let a = attrs(&[("onclick", "fn()")]);
    assert_eq!(
        decide(&ctx(
            "div",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0
            })
        )),
        Decision::Interactive(RuleHit::S6InlineEvent)
    );
    let a = attrs(&[("tabindex", "0")]);
    assert_eq!(
        decide(&ctx(
            "span",
            &a,
            visible(),
            Some(Bounds {
                x: 0.0,
                y: 0.0,
                width: 50.0,
                height: 20.0
            })
        )),
        Decision::Interactive(RuleHit::S6InlineEvent)
    );
}

/// S7：大 iframe（宽高均 > 100px）；小 iframe 不命中。
#[test]
fn s7_big_iframe() {
    let a = attrs(&[]);
    let big = Bounds {
        x: 0.0,
        y: 0.0,
        width: 300.0,
        height: 200.0,
    };
    assert_eq!(
        decide(&ctx("iframe", &a, visible(), Some(big))),
        Decision::Interactive(RuleHit::S7BigIframe)
    );
    let small = Bounds {
        x: 0.0,
        y: 0.0,
        width: 50.0,
        height: 30.0,
    };
    assert_eq!(
        decide(&ctx("iframe", &a, visible(), Some(small))),
        Decision::NotInteractive
    );
}

/// S1：getEventListeners 通道默认关闭（T-4），开启时命中。
#[test]
fn s1_listener_channel_gated() {
    let a = attrs(&[]);
    let mut c = ctx(
        "div",
        &a,
        visible(),
        Some(Bounds {
            x: 0.0,
            y: 0.0,
            width: 50.0,
            height: 20.0,
        }),
    );
    c.has_click_listener = true;
    assert_eq!(
        decide(&c),
        Decision::NotInteractive,
        "通道默认关闭，S1 不生效"
    );
    c.listener_channel_enabled = true;
    assert_eq!(decide(&c), Decision::Interactive(RuleHit::S1Listener));
}
