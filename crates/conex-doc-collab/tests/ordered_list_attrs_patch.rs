//! 有序列表编号属性的增量写入契约。

use conex_doc_collab::{BlockId, BlockKind, BlockProps, DocSession, Op, Origin};
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

const ORDERED_ITEM_NUMBER_ATTR: &str = "conex_md_ordered_item_number";

fn bid(s: &str) -> BlockId {
    BlockId::from_str(s).expect("uuid")
}

fn insert_ordered_item(session: &mut DocSession, id: BlockId) {
    let mut props = BlockProps::default();
    props
        .attrs
        .insert(ORDERED_ITEM_NUMBER_ATTR.into(), serde_json::json!(5));
    props
        .attrs
        .insert("existing_attr".into(), serde_json::json!("keep"));
    session
        .apply(
            Origin::User,
            &[Op::Insert {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::OrderedItem,
                props,
            }],
        )
        .expect("insert ordered item");
}

#[test]
fn patch_attrs_preserves_ordinal_and_supports_explicit_removal() {
    let id = bid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    let mut session = DocSession::new("ordered-item-attrs-patch");
    insert_ordered_item(&mut session, id);

    // 折叠与 note 部分属性更新只改指定键，编号和其它属性仍保留。
    session
        .apply(
            Origin::User,
            &[Op::PatchAttrs {
                id,
                set: BTreeMap::from([(String::from("collapsed"), serde_json::json!(true))]),
                remove: BTreeSet::new(),
            }],
        )
        .expect("patch collapse attr");
    session
        .apply(
            Origin::Agent,
            &[Op::PatchAttrs {
                id,
                set: BTreeMap::from([(String::from("note_attr"), serde_json::json!("value"))]),
                remove: BTreeSet::new(),
            }],
        )
        .expect("patch note attr");

    let attrs = &session.tree().get(&id).expect("ordered item").props.attrs;
    assert_eq!(
        attrs
            .get(ORDERED_ITEM_NUMBER_ATTR)
            .and_then(serde_json::Value::as_u64),
        Some(5)
    );
    assert_eq!(
        attrs.get("collapsed").and_then(serde_json::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        attrs
            .get("existing_attr")
            .and_then(serde_json::Value::as_str),
        Some("keep")
    );
    assert_eq!(
        attrs.get("note_attr").and_then(serde_json::Value::as_str),
        Some("value")
    );

    // 重叠键先删除再写入，最终保留 set 中的新值。
    session
        .apply(
            Origin::Agent,
            &[Op::PatchAttrs {
                id,
                set: BTreeMap::from([(String::from("note_attr"), serde_json::json!("updated"))]),
                remove: BTreeSet::from([String::from("note_attr")]),
            }],
        )
        .expect("set wins over removal for the same key");
    let attrs = &session.tree().get(&id).expect("ordered item").props.attrs;
    assert_eq!(
        attrs.get("note_attr").and_then(serde_json::Value::as_str),
        Some("updated")
    );

    // 删除通过 remove 明确表达；其它键不受影响。
    session
        .apply(
            Origin::User,
            &[Op::PatchAttrs {
                id,
                set: BTreeMap::new(),
                remove: BTreeSet::from([String::from(ORDERED_ITEM_NUMBER_ATTR)]),
            }],
        )
        .expect("remove ordinal attr");
    let attrs = &session.tree().get(&id).expect("ordered item").props.attrs;
    assert!(!attrs.contains_key(ORDERED_ITEM_NUMBER_ATTR));
    assert_eq!(
        attrs.get("collapsed").and_then(serde_json::Value::as_bool),
        Some(true)
    );
    assert_eq!(
        attrs.get("note_attr").and_then(serde_json::Value::as_str),
        Some("updated")
    );
}

#[test]
fn update_props_remains_a_full_replacement() {
    let id = bid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    let mut session = DocSession::new("ordered-item-full-props-replacement");
    insert_ordered_item(&mut session, id);

    let mut replacement = BlockProps::default();
    replacement
        .attrs
        .insert("collapsed".into(), serde_json::json!(true));
    session
        .apply(
            Origin::User,
            &[Op::UpdateProps {
                id,
                props: replacement,
            }],
        )
        .expect("replace full props");

    let attrs = &session.tree().get(&id).expect("ordered item").props.attrs;
    assert_eq!(
        attrs.get("collapsed").and_then(serde_json::Value::as_bool),
        Some(true)
    );
    assert!(!attrs.contains_key(ORDERED_ITEM_NUMBER_ATTR));
    assert!(!attrs.contains_key("existing_attr"));
}
