use super::*;

mod en;
mod night_and_locale;
mod zh;

const T0: u64 = 1_784_078_400_000;

/// 场景 + 载荷 → 期望文案（D7 §3.3 明细 / §3.3.13 样例逐条对齐）
fn payload(biz_key: &str, digest: Option<&str>, detail: Option<&str>) -> PayloadDigest {
    PayloadDigest {
        session_id: "s-7".to_string(),
        biz_key: biz_key.to_string(),
        digest: digest.map(str::to_string),
        detail: detail.map(str::to_string),
    }
}

fn assert_copy(
    scene: SceneId,
    digest: Option<&str>,
    detail: Option<&str>,
    title: &str,
    body: &str,
) {
    let copy = render_copy(scene, &payload("run-42", digest, detail));
    assert_eq!(copy.title, title, "场景 {scene:?} 标题");
    assert_eq!(copy.body, body, "场景 {scene:?} 正文");
}

fn assert_copy_en(
    scene: SceneId,
    digest: Option<&str>,
    detail: Option<&str>,
    title: &str,
    body: &str,
) {
    let copy = render_copy_with_locale(scene, &payload("run-42", digest, detail), Some("en-US"));
    assert_eq!(copy.title, title, "场景 {scene:?} 英文标题");
    assert_eq!(copy.body, body, "场景 {scene:?} 英文正文");
}
