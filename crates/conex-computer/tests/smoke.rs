//! 真实环境冒烟(实机探针,`#[ignore]` 默认不跑,非 CI 门禁):
//! 截屏一次 + 坐标往返 + 会话门面初始化。
//!
//! 运行方式(需交互式桌面会话):
//! ```text
//! cargo test -p conex-computer --test smoke -- --ignored --nocapture
//! ```

#[cfg(windows)]
mod probe {
    use conex_computer::coord::Point;
    use conex_computer::screen::ScreenCapture;
    use conex_computer::{Action, ActionResult, ComputerSession};

    /// 冒烟 1:截屏一次 — 布局查询 → 捕获 → 缩放 → PNG 落盘(temp 目录)
    pub fn capture_once() -> Result<(), String> {
        let mut capture = ScreenCapture::new().map_err(|e| format!("截屏源初始化失败: {e}"))?;
        let layout = capture.layout().clone();
        println!(
            "布局: origin=({},{}) 物理={}x{} 显示器数={}",
            layout.origin_x,
            layout.origin_y,
            layout.phys_w,
            layout.phys_h,
            layout.monitors.len()
        );
        let spec = layout.to_scale_spec();
        println!(
            "缩放规格: {}x{} (fx={:.4}, fy={:.4})",
            spec.target_w,
            spec.target_h,
            spec.fx(),
            spec.fy()
        );
        let frame = capture.capture().map_err(|e| format!("截屏失败: {e}"))?;
        println!(
            "截屏: seq={} 尺寸={}x{} 字节数={}",
            frame.seq,
            frame.width,
            frame.height,
            frame.data.len()
        );
        assert!(
            frame.data.starts_with(&[0x89, b'P', b'N', b'G']),
            "PNG 签名缺失"
        );
        assert_eq!(frame.width, spec.target_w, "帧宽应与 API 空间一致");
        assert_eq!(frame.height, spec.target_h, "帧高应与 API 空间一致");
        let path = std::env::temp_dir().join("conex-computer-smoke.png");
        std::fs::write(&path, &frame.data).map_err(|e| format!("PNG 落盘失败: {e}"))?;
        println!("PNG 已落盘: {}", path.display());
        Ok(())
    }

    /// 冒烟 2:坐标往返 — 真实布局规格下 API→物理→API 双向网格采样,误差 ≤1px
    pub fn coord_roundtrip() -> Result<(), String> {
        let capture = ScreenCapture::new().map_err(|e| format!("截屏源初始化失败: {e}"))?;
        let spec = capture.layout().to_scale_spec();
        let mut worst = (0i32, 0i32);
        let mut x = 0i32;
        while x <= spec.target_w as i32 {
            let mut y = 0i32;
            while y <= spec.target_h as i32 {
                let api = Point::new(x, y);
                let phys = spec.api_to_phys(api);
                let back = spec.phys_to_api(phys);
                let dx = (back.x - x).abs();
                let dy = (back.y - y).abs();
                if dx > worst.0 {
                    worst.0 = dx;
                }
                if dy > worst.1 {
                    worst.1 = dy;
                }
                assert!(
                    dx <= 1 && dy <= 1,
                    "往返误差超 1px: api={api:?} phys={phys:?} back={back:?}"
                );
                y += 97;
            }
            x += 97;
        }
        println!(
            "坐标往返: 网格采样通过,最大误差 ({},{}) ≤ 1px",
            worst.0, worst.1
        );
        Ok(())
    }

    /// 冒烟 3:会话门面初始化 + 光标位置读取(物理→API 换算)
    pub fn session_probe() -> Result<(), String> {
        let mut session = ComputerSession::new().map_err(|e| format!("会话初始化失败: {e}"))?;
        let result = session
            // 冒烟探针无中止需求：显式声明「不中止」，走唯一真源入口。
            .dispatch_with_abort(&Action::CursorPosition, || false)
            .map_err(|e| format!("光标查询失败: {e}"))?;
        let ActionResult::CursorPosition(pos) = result else {
            return Err(format!("预期光标位置结果, 实得 {result:?}"));
        };
        println!("光标位置(API 空间): {pos:?}");
        let spec = *session.scale_spec();
        // 回推物理坐标:API 值应在物理桌面范围内(边界含 0)
        let phys = spec.api_to_phys(pos);
        assert!(phys.x >= spec.origin_x && phys.x <= spec.origin_x + spec.phys_w as i32);
        assert!(phys.y >= spec.origin_y && phys.y <= spec.origin_y + spec.phys_h as i32);
        println!("会话冒烟通过,布局与缩放规格可用");
        Ok(())
    }
}

#[test]
#[ignore]
#[cfg(windows)]
fn smoke_capture_once() {
    if let Err(e) = probe::capture_once() {
        panic!("冒烟失败(截屏): {e}");
    }
}

#[test]
#[ignore]
#[cfg(windows)]
fn smoke_coord_roundtrip() {
    if let Err(e) = probe::coord_roundtrip() {
        panic!("冒烟失败(坐标往返): {e}");
    }
}

#[test]
#[ignore]
#[cfg(windows)]
fn smoke_session_probe() {
    if let Err(e) = probe::session_probe() {
        panic!("冒烟失败(会话门面): {e}");
    }
}
