//! app_preferences 偏好表 CRUD 数据访问面（设计Token与偏好SSOT端到端重构 B1/B2）。

use super::{DbFailure, DbFailureKind, LocalDb};
use rusqlite::OptionalExtension;

/// 偏好表数据行
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AppPreferenceRow {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

impl LocalDb {
    /// 读取单条偏好（若 key 不存在返回 None）。
    pub fn get_preference(&self, key: &str) -> Result<Option<AppPreferenceRow>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare("SELECT key, value, updated_at FROM app_preferences WHERE key = ?1")
            .map_err(|e| self.latch_error("get_preference_prepare", e))?;

        let row = stmt
            .query_row(rusqlite::params![key], |r| {
                Ok(AppPreferenceRow {
                    key: r.get(0)?,
                    value: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })
            .optional()
            .map_err(|e| self.latch_error("get_preference_row", e))?;

        Ok(row)
    }

    /// 读取全量偏好（按 key 升序返回）。
    pub fn list_preferences(&self) -> Result<Vec<AppPreferenceRow>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare("SELECT key, value, updated_at FROM app_preferences ORDER BY key ASC")
            .map_err(|e| self.latch_error("list_preferences_prepare", e))?;

        let rows = stmt
            .query_map([], |r| {
                Ok(AppPreferenceRow {
                    key: r.get(0)?,
                    value: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })
            .map_err(|e| self.latch_error("list_preferences_query", e))?;

        let mut result = Vec::new();
        for item in rows {
            result.push(item.map_err(|e| self.latch_error("list_preferences_row", e))?);
        }

        Ok(result)
    }

    /// 写入或更新偏好（记录指定的时间戳 updated_at）。
    pub fn set_preference(&self, key: &str, value: &str, updated_at: i64) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        conn.execute(
            "INSERT INTO app_preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![key, value, updated_at],
        )
        .map_err(|e| self.latch_error("set_preference_exec", e))?;

        Ok(())
    }

    /// 删除指定偏好的 key（返回是否有行被删除）。
    pub fn delete_preference(&self, key: &str) -> Result<bool, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let count = conn
            .execute("DELETE FROM app_preferences WHERE key = ?1", rusqlite::params![key])
            .map_err(|e| self.latch_error("delete_preference_exec", e))?;

        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_preference_crud() {
        let db = LocalDb::open_in_memory().unwrap();

        // 初始为空
        assert!(db.get_preference("crish_theme").unwrap().is_none());
        assert!(db.list_preferences().unwrap().is_empty());

        // 写入
        db.set_preference("crish_theme", "\"dark\"", 1000).unwrap();
        let p = db.get_preference("crish_theme").unwrap().unwrap();
        assert_eq!(p.key, "crish_theme");
        assert_eq!(p.value, "\"dark\"");
        assert_eq!(p.updated_at, 1000);

        // 更新
        db.set_preference("crish_theme", "\"light\"", 2000).unwrap();
        let p2 = db.get_preference("crish_theme").unwrap().unwrap();
        assert_eq!(p2.value, "\"light\"");
        assert_eq!(p2.updated_at, 2000);

        // 写入第二个 key
        db.set_preference("crish_sidebar_width", "250", 1500).unwrap();
        let list = db.list_preferences().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].key, "crish_sidebar_width");
        assert_eq!(list[1].key, "crish_theme");

        // 删除
        assert!(db.delete_preference("crish_theme").unwrap());
        assert!(!db.delete_preference("crish_theme").unwrap());
        assert!(db.get_preference("crish_theme").unwrap().is_none());
        assert_eq!(db.list_preferences().unwrap().len(), 1);
    }
}
