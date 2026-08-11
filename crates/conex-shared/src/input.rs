//! 输入注入抽象（05 文档 §4 定稿；浏览器线语义对等点见 05 文档 §2.2）。
//!
//! 语义约定：
//! - 坐标一律为物理像素（虚拟桌面原点可负；API 空间换算由 ScaleCoordinator
//!   完成，后端不感知缩放，05 文档 §4.1）；
//! - 双击/三击间隔由后端生成（≤ 系统双击时间，04 文档 §2.1）；
//! - 文本输入内部按 50 字符分块 + 12ms 节流，分块间自查急停（04 文档 §2.3）；
//! - 浏览器线把方法序列映射为既有 `InputCmd` 经 `InputPipeline::dispatch` 注入；
//!   桌面线由既有 `OsInputBackend`（Mutex<Enigo> 内可变）直接实现。

use async_trait::async_trait;

/// 物理像素坐标（虚拟桌面原点可负；API 空间换算由 ScaleCoordinator 完成，
/// 后端不感知缩放）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PhysicalPoint {
    /// 物理横坐标（可负）
    pub x: i32,
    /// 物理纵坐标（可负）
    pub y: i32,
}

/// 鼠标按键（含侧键；桌面线既有实现仅左/中/右，侧键为 S6 对齐扩展）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    /// 左键
    Left,
    /// 中键
    Middle,
    /// 右键
    Right,
    /// 后退侧键
    Back,
    /// 前进侧键
    Forward,
}

/// 点击次数语义（双击/三击间隔由后端生成，≤ 系统双击时间，04 文档 §2.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClickCount {
    /// 单击
    Single,
    /// 双击
    Double,
    /// 三击
    Triple,
}

/// 滚动方向（正/负滚轮增量语义由实现侧换算）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    /// 向上
    Up,
    /// 向下
    Down,
    /// 向左（横向滚轮）
    Left,
    /// 向右（横向滚轮）
    Right,
}

/// 归一化键名 newtype（04 文档 §2.4 键名规范；跨平台解析在实现侧注册表，
/// 共享层不校验）。
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct KeyName(pub String);

/// 输入注入错误（Display 文案与 05 文档 §4.1 定稿一致）。
#[derive(Debug, thiserror::Error)]
pub enum InputBackendError {
    /// 注入失败（设备面）
    #[error("输入注入失败：{0}")]
    Failed(String),
    /// 后端未接线
    #[error("输入后端未接线")]
    Unavailable,
    /// 输入被急停中断（在途批次自查语义，04 文档 §4.3）
    #[error("输入被急停中断")]
    Aborted,
}

/// 输入后端（共享引用调用面；浏览器线 `CdpInputBackend` 映射 `InputCmd`，
/// 桌面线 `OsInputBackend` 对齐实现）。
#[async_trait]
pub trait InputBackend: Send + Sync {
    /// 移动光标（物理像素）。
    async fn mouse_move(&self, p: PhysicalPoint) -> Result<(), InputBackendError>;
    /// 点击系列：带坐标先移动；带修饰键按住点击（ctrl+click）；count 由后端生成间隔。
    async fn click(
        &self,
        btn: MouseButton,
        count: ClickCount,
        p: Option<PhysicalPoint>,
        mods: &[KeyName],
    ) -> Result<(), InputBackendError>;
    /// 按下/抬起分离原语（作用于当前光标位置）。
    async fn button(&self, btn: MouseButton, down: bool) -> Result<(), InputBackendError>;
    /// 拖拽：按下起点 → 分步插值移动 → 终点抬起。
    async fn drag(&self, from: PhysicalPoint, to: PhysicalPoint) -> Result<(), InputBackendError>;
    /// 滚动（方向 + 量；带坐标先移动；带修饰键按住滚动）。
    async fn scroll(
        &self,
        dir: ScrollDirection,
        amount: u32,
        p: Option<PhysicalPoint>,
        mods: &[KeyName],
    ) -> Result<(), InputBackendError>;
    /// 文本输入（内部按 50 字符分块 + 12ms 节流；每块写入前自查急停，04 文档 §2.3）。
    async fn type_text(&self, text: &str) -> Result<(), InputBackendError>;
    /// 组合键（修饰键按序 down → 主键 down/up → 修饰键逆序 up）；
    /// hold_ms = Some 按住后松开。
    async fn key(&self, keys: &[KeyName], hold_ms: Option<u32>) -> Result<(), InputBackendError>;
    /// 光标位置查询（物理坐标）。
    async fn cursor_position(&self) -> Result<PhysicalPoint, InputBackendError>;
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::test_support::block_on;

    /// mock 输入后端：调用轨迹记录（Arc 句柄供 trait 对象外断言）
    struct MockInputBackend {
        trace: Arc<Mutex<Vec<String>>>,
        calls: AtomicUsize,
    }

    impl MockInputBackend {
        fn new(trace: Arc<Mutex<Vec<String>>>) -> Self {
            Self {
                trace,
                calls: AtomicUsize::new(0),
            }
        }

        fn record(&self, entry: String) {
            self.trace.lock().expect("轨迹锁").push(entry);
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl InputBackend for MockInputBackend {
        async fn mouse_move(&self, p: PhysicalPoint) -> Result<(), InputBackendError> {
            self.record(format!("mouse_move({},{})", p.x, p.y));
            Ok(())
        }

        async fn click(
            &self,
            btn: MouseButton,
            count: ClickCount,
            p: Option<PhysicalPoint>,
            mods: &[KeyName],
        ) -> Result<(), InputBackendError> {
            self.record(format!("click({btn:?},{count:?},{p:?},{mods:?})"));
            Ok(())
        }

        async fn button(&self, btn: MouseButton, down: bool) -> Result<(), InputBackendError> {
            self.record(format!("button({btn:?},{down})"));
            Ok(())
        }

        async fn drag(
            &self,
            from: PhysicalPoint,
            to: PhysicalPoint,
        ) -> Result<(), InputBackendError> {
            self.record(format!("drag({from:?},{to:?})"));
            Ok(())
        }

        async fn scroll(
            &self,
            dir: ScrollDirection,
            amount: u32,
            p: Option<PhysicalPoint>,
            mods: &[KeyName],
        ) -> Result<(), InputBackendError> {
            self.record(format!("scroll({dir:?},{amount},{p:?},{mods:?})"));
            Ok(())
        }

        async fn type_text(&self, text: &str) -> Result<(), InputBackendError> {
            // 按字符数记录（04 文档 §2.3 分块语义在实现侧）
            self.record(format!("type_text({})", text.chars().count()));
            Ok(())
        }

        async fn key(
            &self,
            keys: &[KeyName],
            hold_ms: Option<u32>,
        ) -> Result<(), InputBackendError> {
            self.record(format!("key({keys:?},{hold_ms:?})"));
            Ok(())
        }

        async fn cursor_position(&self) -> Result<PhysicalPoint, InputBackendError> {
            self.record("cursor_position()".to_string());
            Ok(PhysicalPoint { x: -100, y: 300 })
        }
    }

    #[test]
    fn physical_point_serde_roundtrip() {
        let p = PhysicalPoint { x: -100, y: 300 };
        let json = serde_json::to_string(&p).expect("序列化失败");
        assert_eq!(json, r#"{"x":-100,"y":300}"#);
        assert_eq!(
            serde_json::from_str::<PhysicalPoint>(&json).expect("反序列化失败"),
            p
        );
    }

    #[test]
    fn mouse_button_serde_roundtrip() {
        for (btn, name) in [
            (MouseButton::Left, "left"),
            (MouseButton::Middle, "middle"),
            (MouseButton::Right, "right"),
            (MouseButton::Back, "back"),
            (MouseButton::Forward, "forward"),
        ] {
            assert_eq!(
                serde_json::to_string(&btn).expect("序列化失败"),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<MouseButton>(&format!("\"{name}\"")).expect("反序列化失败"),
                btn
            );
        }
    }

    #[test]
    fn click_count_serde_roundtrip() {
        for (count, name) in [
            (ClickCount::Single, "single"),
            (ClickCount::Double, "double"),
            (ClickCount::Triple, "triple"),
        ] {
            assert_eq!(
                serde_json::to_string(&count).expect("序列化失败"),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<ClickCount>(&format!("\"{name}\"")).expect("反序列化失败"),
                count
            );
        }
    }

    #[test]
    fn scroll_direction_serde_roundtrip() {
        for (dir, name) in [
            (ScrollDirection::Up, "up"),
            (ScrollDirection::Down, "down"),
            (ScrollDirection::Left, "left"),
            (ScrollDirection::Right, "right"),
        ] {
            assert_eq!(
                serde_json::to_string(&dir).expect("序列化失败"),
                format!("\"{name}\"")
            );
            assert_eq!(
                serde_json::from_str::<ScrollDirection>(&format!("\"{name}\""))
                    .expect("反序列化失败"),
                dir
            );
        }
    }

    #[test]
    fn key_name_serde_roundtrip() {
        let key = KeyName("ctrl".to_string());
        assert_eq!(serde_json::to_string(&key).expect("序列化失败"), "\"ctrl\"");
        assert_eq!(
            serde_json::from_str::<KeyName>("\"ctrl\"").expect("反序列化失败"),
            key
        );
    }

    #[test]
    fn input_backend_error_display() {
        assert_eq!(
            InputBackendError::Failed("拒绝注入".to_string()).to_string(),
            "输入注入失败：拒绝注入"
        );
        assert_eq!(InputBackendError::Unavailable.to_string(), "输入后端未接线");
        assert_eq!(InputBackendError::Aborted.to_string(), "输入被急停中断");
    }

    #[test]
    fn input_backend_object_safe_and_smoke() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Box<dyn InputBackend>>();

        let trace = Arc::new(Mutex::new(Vec::new()));
        let backend: Box<dyn InputBackend> = Box::new(MockInputBackend::new(trace.clone()));

        block_on(backend.mouse_move(PhysicalPoint { x: 10, y: 20 })).expect("移动失败");
        block_on(backend.click(
            MouseButton::Left,
            ClickCount::Double,
            Some(PhysicalPoint { x: 1, y: 2 }),
            &[KeyName("ctrl".to_string())],
        ))
        .expect("点击失败");
        block_on(backend.button(MouseButton::Right, false)).expect("按键失败");
        block_on(backend.drag(
            PhysicalPoint { x: 0, y: 0 },
            PhysicalPoint { x: 100, y: 100 },
        ))
        .expect("拖拽失败");
        block_on(backend.scroll(ScrollDirection::Down, 3, None, &[])).expect("滚动失败");
        block_on(backend.type_text("你好")).expect("输入失败");
        block_on(backend.key(
            &[KeyName("ctrl".to_string()), KeyName("c".to_string())],
            None,
        ))
        .expect("组合键失败");
        let pos = block_on(backend.cursor_position()).expect("光标查询失败");
        assert_eq!(pos, PhysicalPoint { x: -100, y: 300 });

        // 调用轨迹按序覆盖八个方法
        let trace = trace.lock().expect("轨迹锁");
        assert_eq!(
            trace.as_slice(),
            [
                "mouse_move(10,20)",
                "click(Left,Double,Some(PhysicalPoint { x: 1, y: 2 }),[KeyName(\"ctrl\")])",
                "button(Right,false)",
                "drag(PhysicalPoint { x: 0, y: 0 },PhysicalPoint { x: 100, y: 100 })",
                "scroll(Down,3,None,[])",
                "type_text(2)",
                "key([KeyName(\"ctrl\"), KeyName(\"c\")],None)",
                "cursor_position()",
            ]
        );
    }
}
