//! 工作区根注册与激活（`WorkspaceRegistry` 的写路径）。
//!
//! 三条入口共用同一不变量：先完整 canonicalize 与授权校验，再一次持锁提交
//! `roots`/`recent`/`active`，外部授权（asset scope）同步失败时不留下部分状态。
//! - Dialog：原生目录选择器结果（唯一新授权入口）；
//! - RecentList：历史 recent 根或默认应用根的复授权；
//! - DefaultAppRoot：启动时内部登记的默认根激活（不接收 renderer 路径）。

use super::*;

impl WorkspaceRegistry {
    /// 注册授权根。Dialog 为唯一新授权入口；RecentList/DefaultAppRoot 仅复授权
    /// （路径必须在 recent 列表内或等于默认应用根），否则 `workspace_not_granted`。
    #[cfg(test)]
    pub(crate) fn register(
        &self,
        path: &Path,
        source: RegisterSource,
    ) -> Result<PathBuf, FileCommandError> {
        if source == RegisterSource::Dialog {
            return self
                .register_dialog_paths(&[path.to_path_buf()], true)?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    FileCommandError::new(ERR_WORKSPACE_NOT_GRANTED, "no selected workspace")
                });
        }
        if source == RegisterSource::RecentList {
            return self
                .register_recent_paths(&[path.to_path_buf()], path, true)
                .map(|registered| registered.primary);
        }
        if path.as_os_str().is_empty() {
            return Err(FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                "path is empty",
            ));
        }
        let path_str = path.to_string_lossy();
        if path_str.contains('\0') {
            return Err(FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                "path contains NUL byte",
            ));
        }
        // 根不可达（盘符移除/无法解析）→ 明确拒绝，绝不裸用传入根（T07.2 用例 13）
        let canonical = canonicalize_root(path).map_err(|e| {
            FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                format!("cannot resolve workspace root `{path_str}`: {}", e.message),
            )
        })?;
        if !canonical.is_dir() {
            return Err(FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                format!("not a directory: `{}`", canonical.display()),
            ));
        }

        let mut inner = self.inner.lock().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("workspace registry lock poisoned: {e}"),
            )
        })?;

        match source {
            RegisterSource::Dialog => unreachable!("Dialog uses register_dialog_paths"),
            RegisterSource::RecentList => unreachable!("RecentList uses register_recent_paths"),
            RegisterSource::DefaultAppRoot => {
                // 复授权：仅默认应用根（启动内部注册使用）
                if !is_default_app_root(&canonical) {
                    return Err(FileCommandError::new(
                        ERR_WORKSPACE_NOT_GRANTED,
                        format!("not the default app root: `{}`", canonical.display()),
                    ));
                }
            }
        }

        let mut next_recent = inner.recent.clone();
        if !next_recent.iter().any(|item| paths_equal(item, &canonical)) {
            next_recent.push(canonical.clone());
        }
        if next_recent != inner.recent {
            persist_recent_list(&inner.config_dir, &next_recent)?;
        }

        // 去重 + 置为活动根（最近授权者）
        inner
            .roots
            .retain(|root| !paths_equal(&root.path, &canonical));
        inner.roots.push(WorkspaceRoot {
            path: canonical.clone(),
            source,
        });
        inner.active = Some(inner.roots.len() - 1);
        inner.recent = next_recent;

        Ok(canonical)
    }

    /// RecentList 批量复授权：先验证全部路径与 primary，再一次更新 roots。
    /// 不接受任何 Dialog 来源的新授权；路径必须已经在 recent 或等于默认应用根。
    #[cfg(test)]
    pub(super) fn register_recent_paths(
        &self,
        paths: &[PathBuf],
        primary_path: &Path,
        activate_primary: bool,
    ) -> Result<RegisteredWorkspaceBatch, FileCommandError> {
        self.register_recent_paths_with(paths, primary_path, activate_primary, |_| Ok(()))
    }

    /// 在近期列表提交前同步外部授权；回调失败时注册表与近期文件保持不变。
    pub(super) fn register_recent_paths_with<F>(
        &self,
        paths: &[PathBuf],
        primary_path: &Path,
        activate_primary: bool,
        sync_scope: F,
    ) -> Result<RegisteredWorkspaceBatch, FileCommandError>
    where
        F: FnOnce(&[PathBuf]) -> Result<(), FileCommandError>,
    {
        if paths.is_empty() {
            return Err(FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                "path list is empty",
            ));
        }

        // 显式 PathBuf 标注：首个使用点是 .iter()（paths_equal 形参 &Path），
        // 无标注时推断会把元素类型统一成未加尺寸的 Path（编译错误）。
        let mut canonical_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
        for path in paths {
            if path.as_os_str().is_empty() {
                return Err(FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    "path is empty",
                ));
            }
            let path_str = path.to_string_lossy();
            if path_str.contains('\0') {
                return Err(FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    "path contains NUL byte",
                ));
            }
            let canonical = canonicalize_root(path).map_err(|e| {
                FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    format!("cannot resolve workspace root `{path_str}`: {}", e.message),
                )
            })?;
            if !canonical.is_dir() {
                return Err(FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    format!("not a directory: `{}`", canonical.display()),
                ));
            }
            if !canonical_paths
                .iter()
                .any(|item| paths_equal(item, &canonical))
            {
                canonical_paths.push(canonical);
            }
        }

        let primary_canonical = canonicalize_root(primary_path).map_err(|e| {
            FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                format!(
                    "cannot resolve primary workspace root `{}`: {}",
                    primary_path.display(),
                    e.message
                ),
            )
        })?;
        if !canonical_paths
            .iter()
            .any(|path| paths_equal(path, &primary_canonical))
        {
            return Err(FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                format!(
                    "primary workspace is not in the path list: `{}`",
                    primary_canonical.display()
                ),
            ));
        }

        let mut inner = self.inner.lock().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("workspace registry lock poisoned: {e}"),
            )
        })?;
        for canonical in &canonical_paths {
            let in_recent = inner.recent.iter().any(|item| paths_equal(item, canonical));
            if !in_recent && !is_default_app_root(canonical) {
                return Err(FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    format!("workspace not in recent list: `{}`", canonical.display()),
                ));
            }
        }

        let previous_active = inner
            .active
            .and_then(|index| inner.roots.get(index))
            .map(|root| root.path.clone());

        let mut next_recent = inner.recent.clone();
        for canonical in &canonical_paths {
            if !next_recent.iter().any(|item| paths_equal(item, canonical)) {
                next_recent.push(canonical.clone());
            }
        }

        // 资源协议授权失败时必须在持久化近期列表或改动内存状态前返回。
        // 注册表锁在同步期间保持，避免其他工作区命令穿插改变授权快照。
        sync_scope(&canonical_paths)?;

        // 可复授权路径仅来自已持久化的近期根或内部默认根；近期根不会新增记录，
        // 默认根是注册表初始化时已登记的根。因此落盘失败时不会新增授权根。
        if next_recent != inner.recent {
            persist_recent_list(&inner.config_dir, &next_recent)?;
        }

        for canonical in &canonical_paths {
            inner
                .roots
                .retain(|root| !paths_equal(&root.path, canonical));
            inner.roots.push(WorkspaceRoot {
                path: canonical.clone(),
                source: RegisterSource::RecentList,
            });
        }
        inner.active = if activate_primary {
            inner
                .roots
                .iter()
                .position(|root| paths_equal(&root.path, &primary_canonical))
        } else {
            previous_active.and_then(|active_path| {
                inner
                    .roots
                    .iter()
                    .position(|root| paths_equal(&root.path, &active_path))
            })
        };
        inner.recent = next_recent;
        Ok(RegisteredWorkspaceBatch {
            primary: primary_canonical,
            roots: canonical_paths,
        })
    }

    /// 在 native dialog 回调已交付路径后批量登记；此方法不接受 IPC 参数。
    ///
    /// 多选先完整验证，再一次持锁更新根、recent 与活动根，避免部分注册。选择
    /// “添加文件夹”时 `activate_first=false`，保持当前活动根；创建项目时则激活首选根。
    #[cfg(test)]
    pub(super) fn register_dialog_paths(
        &self,
        paths: &[PathBuf],
        activate_first: bool,
    ) -> Result<Vec<PathBuf>, FileCommandError> {
        self.register_dialog_paths_with(paths, activate_first, |_| Ok(()))
    }

    pub(super) fn register_dialog_paths_with<F>(
        &self,
        paths: &[PathBuf],
        activate_first: bool,
        sync_scope: F,
    ) -> Result<Vec<PathBuf>, FileCommandError>
    where
        F: FnOnce(&[PathBuf]) -> Result<(), FileCommandError>,
    {
        // 显式 PathBuf 标注：首个使用点是 .iter()（paths_equal 形参 &Path），
        // 无标注时推断会把元素类型统一成未加尺寸的 Path（编译错误）。
        let mut canonical_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
        for path in paths {
            if path.as_os_str().is_empty() {
                return Err(FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    "path is empty",
                ));
            }
            let path_str = path.to_string_lossy();
            if path_str.contains('\0') {
                return Err(FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    "path contains NUL byte",
                ));
            }
            let canonical = canonicalize_root(path).map_err(|e| {
                FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    format!("cannot resolve workspace root `{path_str}`: {}", e.message),
                )
            })?;
            if !canonical.is_dir() {
                return Err(FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    format!("not a directory: `{}`", canonical.display()),
                ));
            }
            canonical_paths.push(canonical);
        }

        if canonical_paths.is_empty() {
            return Ok(canonical_paths);
        }

        let mut inner = self.inner.lock().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("workspace registry lock poisoned: {e}"),
            )
        })?;
        let previous_active = inner
            .active
            .and_then(|index| inner.roots.get(index))
            .map(|root| root.path.clone());
        let mut next_recent = inner.recent.clone();
        for canonical in &canonical_paths {
            if !next_recent.iter().any(|item| paths_equal(item, canonical)) {
                next_recent.push(canonical.clone());
            }
        }
        // 先准备临时文件，不提前替换正式 recent；scope 同步失败时只需清理临时文件，
        // 不需要尝试回滚已经提交的近期列表。
        let recent_file_stage = if next_recent != inner.recent {
            Some(prepare_recent_list(&inner.config_dir, &next_recent)?)
        } else {
            None
        };

        if let Err(sync_error) = sync_scope(&canonical_paths) {
            if let Some(staged_path) = recent_file_stage.as_deref() {
                if let Err(cleanup_error) = remove_recent_list_stage(staged_path) {
                    return Err(FileCommandError::new(
                        ERR_INTERNAL,
                        format!(
                            "工作区资源协议授权同步失败：{}；recent 临时文件清理失败：{}",
                            sync_error.message, cleanup_error.message
                        ),
                    ));
                }
            }
            return Err(sync_error);
        }

        if let Some(staged_path) = recent_file_stage.as_deref() {
            if let Err(commit_error) = commit_recent_list(&inner.config_dir, staged_path) {
                let cleanup_detail = remove_recent_list_stage(staged_path)
                    .err()
                    .map(|error| format!("；recent 临时文件清理失败：{}", error.message))
                    .unwrap_or_default();
                return Err(FileCommandError::new(
                    ERR_INTERNAL,
                    format!(
                        "近期列表原子提交失败；本次原生选择的目录已同步进入资源访问范围，但注册表与近期列表未提交。请重试以完成授权。原因：{}{}",
                        commit_error.message, cleanup_detail
                    ),
                ));
            }
        }

        for canonical in &canonical_paths {
            inner
                .roots
                .retain(|root| !paths_equal(&root.path, canonical));
            inner.roots.push(WorkspaceRoot {
                path: canonical.clone(),
                source: RegisterSource::Dialog,
            });
        }
        inner.recent = next_recent;

        let target_active = if activate_first {
            canonical_paths.first()
        } else {
            previous_active.as_ref()
        };
        inner.active = target_active.and_then(|path| {
            inner
                .roots
                .iter()
                .position(|root| paths_equal(&root.path, path))
        });
        Ok(canonical_paths)
    }

    /// 激活已登记的默认应用工作区根，不接收 renderer 路径，也不创建新授权。
    pub(super) fn activate_default_root_with<F>(
        &self,
        sync_scope: F,
    ) -> Result<PathBuf, FileCommandError>
    where
        F: FnOnce(&[PathBuf]) -> Result<(), FileCommandError>,
    {
        let app_dir =
            crate::host_paths::app_dir().map_err(|e| FileCommandError::new(ERR_INTERNAL, e))?;
        let default_root = crate::host_paths::workspace_root(&app_dir);
        self.activate_registered_root_with(&default_root, sync_scope)
    }

    #[cfg(test)]
    pub(super) fn activate_registered_root(
        &self,
        path: &Path,
    ) -> Result<PathBuf, FileCommandError> {
        self.activate_registered_root_with(path, |_| Ok(()))
    }

    pub(super) fn activate_registered_root_with<F>(
        &self,
        path: &Path,
        sync_scope: F,
    ) -> Result<PathBuf, FileCommandError>
    where
        F: FnOnce(&[PathBuf]) -> Result<(), FileCommandError>,
    {
        let canonical = canonicalize_root(path).map_err(|e| {
            FileCommandError::new(
                ERR_WORKSPACE_NOT_GRANTED,
                format!("cannot resolve default workspace root: {}", e.message),
            )
        })?;
        let mut inner = self.inner.lock().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("workspace registry lock poisoned: {e}"),
            )
        })?;
        let index = inner
            .roots
            .iter()
            .position(|root| paths_equal(&root.path, &canonical))
            .ok_or_else(|| {
                FileCommandError::new(
                    ERR_WORKSPACE_NOT_GRANTED,
                    format!(
                        "default workspace root is not registered: `{}`",
                        canonical.display()
                    ),
                )
            })?;
        sync_scope(std::slice::from_ref(&canonical))?;
        inner.active = Some(index);
        Ok(inner.roots[index].path.clone())
    }
}
