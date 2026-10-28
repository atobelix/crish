//! 运行时模型单元：运行中切换模型（下一次模型调用生效）。
//!
//! `None` = 跟随引擎当前生效配置；`Some(model)` = 本 run 覆盖。

use std::sync::RwLock;

/// 模型覆盖单元（可克隆共享）
#[derive(Debug, Default)]
pub struct ModelCell {
    model: RwLock<Option<String>>,
}

impl ModelCell {
    /// 构造（None = 跟随引擎默认）
    pub fn new(model: Option<String>) -> Self {
        Self {
            model: RwLock::new(model),
        }
    }

    /// 当前覆盖模型
    pub fn get(&self) -> Option<String> {
        self.model
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 设置覆盖（下一次模型调用生效）
    pub fn set(&self, model: impl Into<String>) {
        *self.model.write().unwrap_or_else(|e| e.into_inner()) = Some(model.into());
    }

    /// 清除覆盖（回到引擎默认）
    pub fn clear(&self) {
        *self.model.write().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_cell_set_and_clear() {
        let cell = ModelCell::new(None);
        assert_eq!(cell.get(), None);
        cell.set("deepseek-v4-flash");
        assert_eq!(cell.get().as_deref(), Some("deepseek-v4-flash"));
        cell.clear();
        assert_eq!(cell.get(), None);
    }
}
