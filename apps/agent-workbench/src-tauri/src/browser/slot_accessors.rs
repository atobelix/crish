//! BrowserSlot 访问器面：会话/帧流/输入/storage/MCP attach 的命令面读入口。

use super::*;

impl BrowserSlot {
    /// 会话同步取用（try_lock：并发启动/重连窗口返回 None，不阻塞）。
    pub(super) fn session_sync(&self) -> Option<Arc<RealSession>> {
        self.session
            .try_lock()
            .ok()
            .and_then(|g| g.as_ref().cloned())
    }

    /// 帧流控制器（P1-B1 命令面访问器）。
    pub(crate) fn frames(&self) -> Arc<FrameStreamController> {
        Arc::clone(&self.frames)
    }

    /// 面板输入路由（P1-B1 命令面访问器）。
    #[cfg(test)]
    pub(crate) fn input(&self) -> Arc<PanelInputRouter> {
        Arc::clone(&self.input)
    }

    /// storage_state 命令发送面（J1b 访问器）：会话连接中 = 会话委托
    /// （Storage 域 browser 级实读/注入）；未连接/停止/恢复期 = 未连接面
    /// （命令映射 not_ready 结构化错误）。
    pub(crate) fn storage_ops(&self) -> Arc<dyn StorageStateOps> {
        Arc::clone(&self.storage_ops.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// 注入 storage 发送面（J1b 测试替身注入点；生产路径不调用——连接
    /// 生命周期自动装配/换回，见 [Self::connect] 与 [Self::drop_raw_session]）。
    #[cfg(test)]
    pub(crate) fn inject_storage_ops(&self, ops: Arc<dyn StorageStateOps>) {
        *self.storage_ops.lock().unwrap_or_else(|p| p.into_inner()) = ops;
    }

    /// localStorage 注入通道（J1b 扩展面访问器，维度 16 §5.3 注入执行）：
    /// 测试注入优先；生产按需经底层会话构造 [SessionLocalStorageChannel]
    /// （绑定活动标签会话——`Page.addScriptToEvaluateOnNewDocument` 注册
    /// origin 守卫脚本 + `DOMStorage.setDOMStorageItem` 直写）。未连接 /
    /// 无活动标签 → Err（命令映射 not_ready，storage 命令不触发惰性启动）。
    pub(crate) fn local_storage_channel(&self) -> Result<Arc<dyn LocalStorageChannel>, String> {
        if let Some(injected) = self
            .local_storage_channel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .cloned()
        {
            return Ok(injected);
        }
        let session = self
            .raw_session_sync()
            .ok_or_else(|| "浏览器未连接（请先 browser_start 后再导入登录态）".to_string())?;
        let channel = SessionLocalStorageChannel::for_active(session)
            .map_err(|e| format!("localStorage 注入通道不可用：{e}"))?;
        Ok(Arc::new(channel))
    }

    /// 注入 localStorage 通道（J1b 测试替身注入点；生产路径不调用——访问器
    /// 按需惰性构造，见 [Self::local_storage_channel]）。
    #[cfg(test)]
    pub(crate) fn inject_local_storage_channel(&self, channel: Arc<dyn LocalStorageChannel>) {
        *self
            .local_storage_channel
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(channel);
    }

    /// 底层会话同步取用（帧订阅/输入管线装配的原始句柄）。
    pub(super) fn raw_session_sync(&self) -> Option<Arc<BrowserSession>> {
        self.raw_session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 注入 attach 会话级开关（E-1 消费面：`BrowserToolsConfig.mcp_attach_allowed`
    /// 由引擎侧会话装配读取后经本方法装配，34 §5.2 E-1；已接线——engine.rs
    /// 装配 [BrowserSlot::new] 处，值源默认 false，面板开关写入面 TODO）。
    pub(crate) fn with_mcp_attach_allowed(mut self, allowed: bool) -> Self {
        self.mcp_attach_allowed = allowed;
        self
    }

    /// 端点暴露守卫（E-1 消费面，R-12）：受管实例启动后取 attach 端点注入
    /// 形态（`http://127.0.0.1:<port>`，34 §5.2 E-1），供引擎侧 MCP server
    /// 启动配置注入（`McpServerConfig.args` 的 `--browserUrl`）。
    ///
    /// 语义（详见 [mcp_attach::attach_exposure_decision]）：
    /// - 开关关闭（默认）→ `tool.browser.capability_disabled`（端点信息
    ///   零暴露，任何进程状态下都不返回）；
    /// - 开关开启但浏览器未就绪（未启动/恢复期/降级槽）→
    ///   `tool.browser.not_ready`；
    /// - 开关开启且就绪 → [McpAttachEndpoint]（browserUrl + ws 串）。
    ///
    /// 引擎侧接线（已接线 E-1，engine.rs）：`register_plugin_mcp_server`
    /// spawn 前的配置注入面为 `Engine::browser_attach_mcp_server_config`
    /// ——先经本守卫取端点，再 `mcp_attach::mcp_attach_server_config`
    /// 构建配置注入 `--browserUrl`（E-4 桥零改动；插件 mcpServers 装配
    /// 点为并行域 TODO 登记，见 engine.rs 该 seam 注释）。
    #[allow(dead_code)]
    pub(crate) fn mcp_attach_endpoint(&self) -> Result<McpAttachEndpoint, ToolError> {
        let endpoint = self.manager.as_ref().and_then(|m| m.endpoint());
        mcp_attach::attach_exposure_decision(self.mcp_attach_allowed, endpoint.as_ref())
    }

    /// 输入事件转发入口（browser_input 命令消费；no-wait 语义——仅路由/合并，
    /// 派发由 P1-A 管线后台进行，invoke 立即返回）。版本推进（R-1/U-1 注入
    /// 即时 +1）与活动钩子（交互期升帧）由管线/帧流会话内部承担。
    pub(crate) fn forward_input(&self, evt: &BrowserInputEvent) {
        self.input.route(evt);
        // 12 §2.5：交互信号 → 升 Interactive 档（无活跃帧流会话时 no-op）
        self.frames.on_user_input();
    }

    /// 启动帧流（browser_start_frames 命令消费）：
    /// 浏览器就绪 → 帧流控制器订阅（懒创建 P1-A ScreencastSession + start）。
    pub(crate) async fn start_frames(
        &self,
        channel: tauri::ipc::Channel<tauri::ipc::Response>,
    ) -> Result<FrameStreamState, String> {
        self.ensure_ready().await?;
        let Some(session) = self.raw_session_sync() else {
            return Err("浏览器会话不可用（重连中）".to_string());
        };
        let ctrl = Arc::clone(&self.frames);
        ctrl.subscribe(session, channel).await;
        Ok(ctrl.state())
    }

    /// 停止帧流（browser_stop_frames 命令消费；幂等）——停止帧泵，会话保留。
    pub(crate) async fn stop_frames(&self) -> FrameStreamState {
        self.frames.unsubscribe().await;
        self.frames.state()
    }
}
