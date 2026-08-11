//! 配对码生成 / TTL / 失败锁定（D3 §4.1 / ADR-06 唯一真源）
//!
//! - **格式**：CXN-XXXX-XXXX-XXXX（12 字符、60bit、去 0/O/1/I 的 base32
//!   子集——含 L；字符集常量引用 conex-types `PAIR_CODE_ALPHABET`，
//!   R0-05 对拍已锚定）；
//! - **有效期** 10 分钟（`PAIR_CODE_TTL_MS`）；**单码失败上限** 5 次
//!   （`PAIR_MAX_ATTEMPTS`），超限进入冷却窗口（`PAIR_LOCK_COOLDOWN_MS`，
//!   error.rs `pair.too_many_attempts` 注释口径）；
//! - **并发码 ≤3**（`PAIR_MAX_ACTIVE`）；**一次性**（成功后立即作废）；
//! - 桌面只存 `SHA-256(code+salt)` 不存明文——码哈希与完整配对流程
//!   （pair.hello / challenge / verify / ok 密钥交换链）归 R1-07；
//!   本包实现：数据模型 + CSPRNG 生成 + 校验判定状态机。

use conex_types::device::{PAIR_CODE_ALPHABET, PAIR_CODE_LENGTH, PairCode};
use conex_types::device::version::{
    PAIR_CODE_TTL_MS, PAIR_MAX_ACTIVE, PAIR_MAX_ATTEMPTS,
};

use crate::server::ServerError;

/// 失败锁定冷却窗口（R0-02 error.rs `pair.too_many_attempts` 注释口径：
/// 冷却 5min）
pub const PAIR_LOCK_COOLDOWN_MS: u64 = 300_000;

/// 配对状态机状态（D3 §4.2：Idle → WaitingInput → KeyVerify →
/// Establishing → Established）
// R1-02 备注：状态机全路径由单测覆盖；非测试构建消费方为 R1-07
// （配对 GUI 命令 / POST /v1/pair）——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairState {
    /// 未在配对
    Idle,
    /// 已展示配对码，等待移动端输入
    WaitingInput,
    /// 码校验通过，密钥交换中（R1-07）
    KeyVerify,
    /// 密钥交换完成，链路建立中（R1-07）
    Establishing,
    /// 已建立（R1-07）
    Established,
}

/// 配对码校验结果
// R1-02 备注：R1-07 配对流程消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// 校验通过（码一次性作废，状态机进入 KeyVerify）
    Success,
    /// 码不存在（输入与全部活跃码不符；计为最新活跃码的一次失败尝试）
    WrongCode,
    /// 码已过期（10min；需重新开启配对）
    Expired,
    /// 失败次数达上限，冷却中
    Locked,
    /// 码已被使用（一次性）
    Used,
    /// R1-10 T-05：失败达上限后配对会话已销毁（冷却结束后正确码也永久
    /// 失效——5 次爆破即销毁会话，D5 T-05「5 次失败销毁会话 + 锁定」）
    Destroyed,
    /// 状态机不在等待输入态
    NotAwaiting,
    /// 输入无法标准化（对应 `pair.invalid_code`）
    InvalidFormat,
}

/// 配对码记录（生成即入表；TTL / 失败计数 / 一次性语义）
// R1-02 备注：R1-07 配对流程消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, PartialEq)]
pub struct PairCodeRecord {
    /// 已标准化的 12 字符码
    pub code: PairCode,
    /// 生成时刻（epoch ms）
    pub created_at_ms: u64,
    /// 过期时刻（生成时刻 + TTL）
    pub expires_at_ms: u64,
    /// 失败尝试次数（单码上限 [PAIR_MAX_ATTEMPTS]）
    pub failed_attempts: u32,
    /// 冷却截止时刻（达上限后 = 当前 + [PAIR_LOCK_COOLDOWN_MS]）
    pub locked_until_ms: u64,
    /// 已使用（一次性；成功后立即作废）
    pub consumed: bool,
    /// R1-10 T-05：失败达上限后会话销毁（正确码此后永久失效；与
    /// [Self::locked_until_ms] 同时置位——冷却期内 Locked、冷却后
    /// Destroyed）
    pub destroyed: bool,
}

impl PairCodeRecord {
    /// 是否已过期
    // R1-02 备注：R1-07 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }

    /// 是否处于冷却锁定
    // R1-02 备注：R1-07 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_locked(&self, now_ms: u64) -> bool {
        self.locked_until_ms > now_ms
    }

    /// 剩余尝试次数
    // R1-02 备注：R1-07 UI 展示消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn remaining_attempts(&self) -> u32 {
        PAIR_MAX_ATTEMPTS.saturating_sub(self.failed_attempts)
    }
}

/// 记录一次失败尝试；达上限进入冷却窗口
/// R1-10 T-05：达上限同时销毁配对会话（destroyed）——冷却只是第一道闸，
/// 冷却结束后该码也永久失效（D5 T-05「5 次失败销毁会话 + 锁定」）
fn record_failure(record: &mut PairCodeRecord, now_ms: u64) {
    record.failed_attempts = record.failed_attempts.saturating_add(1);
    if record.failed_attempts >= PAIR_MAX_ATTEMPTS {
        record.locked_until_ms = now_ms + PAIR_LOCK_COOLDOWN_MS;
        record.destroyed = true;
    }
}

/// 配对状态机（R1-02：数据模型 + 生成 + 校验判定；密钥交换链 R1-07）
// R1-02 备注：完整配对流程 R1-07 消费——dead_code 静音（测试构建
// 保持全路径检查）
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug)]
pub struct PairStateMachine {
    state: PairState,
    codes: Vec<PairCodeRecord>,
}

impl Default for PairStateMachine {
    fn default() -> Self {
        Self {
            state: PairState::Idle,
            codes: Vec::new(),
        }
    }
}

impl PairStateMachine {
    /// 新建状态机（Idle）
    // R1-02 备注：R1-07 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前状态
    // R1-02 备注：R1-07 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn state(&self) -> PairState {
        self.state
    }

    /// 活跃配对码记录（生成后未过期未使用）
    // R1-02 备注：R1-07 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn codes(&self) -> &[PairCodeRecord] {
        &self.codes
    }

    /// 开始配对：清理过期码 → 生成新码入表（并发活跃码 ≤3，超限返回
    /// 错误）→ 进入 WaitingInput 并返回 CXN 码（供 UI 展示 / 二维码）
    // R1-02 备注：R1-07 配对模式消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn start(&mut self, now_ms: u64) -> Result<PairCode, ServerError> {
        self.codes
            .retain(|record| !record.is_expired(now_ms) && !record.consumed && !record.destroyed);
        if self.codes.len() >= PAIR_MAX_ACTIVE as usize {
            return Err(ServerError::internal(
                "并发配对码已达上限（≤3），请先关闭当前配对",
            ));
        }
        let code = generate_pair_code()?;
        self.codes.push(PairCodeRecord {
            code: code.clone(),
            created_at_ms: now_ms,
            expires_at_ms: now_ms + PAIR_CODE_TTL_MS,
            failed_attempts: 0,
            locked_until_ms: 0,
            consumed: false,
            destroyed: false,
        });
        self.state = PairState::WaitingInput;
        Ok(code)
    }

    /// 校验配对码（D3 §4.1 语义：输入容错标准化 → 匹配 → 一次性 / 状态 /
    /// TTL / 锁定 → 通过则码作废并进入 KeyVerify）
    // R1-02 备注：R1-07 配对流程消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn verify(&mut self, input: &str, now_ms: u64) -> VerifyOutcome {
        let code = match PairCode::normalize(input) {
            Ok(code) => code,
            Err(_) => return VerifyOutcome::InvalidFormat,
        };
        let Some(record) = self.codes.iter_mut().find(|record| record.code == code) else {
            // 无匹配码：不在等待输入态 → NotAwaiting；否则记为「主待验码」
            // （最新一个未消耗未过期未销毁）的一次失败尝试（单码失败计数语义）
            if self.state != PairState::WaitingInput {
                return VerifyOutcome::NotAwaiting;
            }
            if let Some(primary) = self
                .codes
                .iter_mut()
                .rev()
                .find(|r| !r.consumed && !r.destroyed && !r.is_expired(now_ms))
            {
                record_failure(primary, now_ms);
            }
            return VerifyOutcome::WrongCode;
        };
        if record.consumed {
            return VerifyOutcome::Used;
        }
        if self.state != PairState::WaitingInput {
            return VerifyOutcome::NotAwaiting;
        }
        if record.is_expired(now_ms) {
            return VerifyOutcome::Expired;
        }
        if record.is_locked(now_ms) {
            return VerifyOutcome::Locked;
        }
        // R1-10 T-05：冷却结束后销毁态仍拒绝（会话已销毁，正确码永久失效）
        if record.destroyed {
            return VerifyOutcome::Destroyed;
        }
        record.consumed = true;
        // 一次性作废；进入密钥交换阶段（完整配对链 R1-07）
        self.state = PairState::KeyVerify;
        VerifyOutcome::Success
    }

    /// 关闭配对（清空码表回 Idle；关闭配对时的令牌撤销在 auth.rs）
    // R1-02 备注：R1-07 关闭配对消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn cancel(&mut self) {
        self.codes.clear();
        self.state = PairState::Idle;
    }

    /// 最新活跃码（未消耗未过期未销毁；无 → None）。R1-07 配对协调器消费。
    pub fn active_code(&self, now_ms: u64) -> Option<PairCode> {
        self.codes
            .iter()
            .rev()
            .find(|record| !record.consumed && !record.destroyed && !record.is_expired(now_ms))
            .map(|record| record.code.clone())
    }

    /// 最新活跃码剩余有效毫秒（无活跃码 → None）。R1-07 状态面消费。
    pub fn active_code_remaining_ms(&self, now_ms: u64) -> Option<u64> {
        self.codes
            .iter()
            .rev()
            .find(|record| !record.consumed && !record.destroyed && !record.is_expired(now_ms))
            .map(|record| record.expires_at_ms.saturating_sub(now_ms))
    }

    /// 最新活跃码的失败尝试次数（无活跃码 → 0）。R1-07 状态面消费。
    /// R1-10 T-05：销毁的会话不计入活跃（销毁后 → 0，状态面提示重新配对）。
    pub fn failed_attempts(&self) -> u32 {
        self.codes
            .iter()
            .rev()
            .find(|record| !record.consumed && !record.destroyed)
            .map(|record| record.failed_attempts)
            .unwrap_or(0)
    }
}

/// CSPRNG 生成 12 字符配对码（字符集 = conex-types 常量；
/// 256 % 32 == 0，索引映射无模偏差）
// R1-02 备注：R1-07 配对模式消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub fn generate_pair_code() -> Result<PairCode, ServerError> {
    let alphabet = PAIR_CODE_ALPHABET.as_bytes();
    let mut bytes = [0u8; PAIR_CODE_LENGTH];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| ServerError::io(format!("OS CSPRNG 读取失败：{e}")))?;
    let mut raw = String::with_capacity(PAIR_CODE_LENGTH);
    for byte in bytes {
        raw.push(alphabet[(byte as usize) % alphabet.len()] as char);
    }
    PairCode::normalize(&raw)
        .map_err(|e| ServerError::internal(format!("配对码生成自检失败：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::device::pair::PAIR_CODE_SEPARATOR;
    use conex_types::device::{PAIR_CODE_PREFIX, PairCodeError};

    /// 生成一个可用测试码（任意固定 12 字符合法码）
    fn sample_code() -> PairCode {
        PairCode::normalize("7K4PQ2MB9XRT").expect("样例码必须合法")
    }

    #[test]
    fn alphabet_includes_l_and_excludes_confusables() {
        // R0-05 对拍裁决：配对码字符集含 L；排除 0/O/1/I
        assert!(PAIR_CODE_ALPHABET.contains('L'));
        for ch in ['0', 'O', '1', 'I'] {
            assert!(!PAIR_CODE_ALPHABET.contains(ch), "混淆字符 {ch} 不得入集");
        }
    }

    #[test]
    fn generated_code_is_12_chars_from_alphabet_and_displayable() {
        for _ in 0..20 {
            let code = generate_pair_code().expect("生成必须成功");
            let raw = code.as_str();
            assert_eq!(raw.len(), PAIR_CODE_LENGTH);
            assert!(
                raw.chars().all(|c| PAIR_CODE_ALPHABET.contains(c)),
                "生成字符必须全在字符集内：{raw}"
            );
            // 人读回显形态 CXN-XXXX-XXXX-XXXX（前缀含首个分隔符，总长 =
            // 前缀 4 + 码 12 + 分隔符 2）
            let display = code.display();
            assert_eq!(display.len(), PAIR_CODE_PREFIX.len() + PAIR_CODE_LENGTH + 2);
            assert!(display.starts_with(PAIR_CODE_PREFIX));
            assert_eq!(display.matches(PAIR_CODE_SEPARATOR).count(), 3);
            // 回显再标准化可还原
            assert_eq!(PairCode::normalize(&display).unwrap(), code);
        }
    }

    #[test]
    fn start_enters_waiting_with_10min_ttl() {
        let mut machine = PairStateMachine::new();
        assert_eq!(machine.state(), PairState::Idle);
        let code = machine.start(1_000).expect("首码生成必须成功");
        assert_eq!(machine.state(), PairState::WaitingInput);
        let record = &machine.codes()[0];
        assert_eq!(record.code, code);
        assert_eq!(record.created_at_ms, 1_000);
        assert_eq!(record.expires_at_ms, 1_000 + PAIR_CODE_TTL_MS);
        assert!(!record.is_expired(1_000 + PAIR_CODE_TTL_MS - 1));
        assert!(record.is_expired(1_000 + PAIR_CODE_TTL_MS));
    }

    #[test]
    fn concurrent_active_codes_capped_at_three() {
        let mut machine = PairStateMachine::new();
        machine.start(1_000).unwrap();
        machine.start(2_000).unwrap();
        machine.start(3_000).unwrap();
        // 第 4 个活跃码被拒绝
        assert!(machine.start(4_000).is_err(), "并发活跃码不得超过 3");
        // 过期码清理后可再开
        machine.cancel();
        assert!(machine.start(10_000).is_ok());
    }

    #[test]
    fn verify_success_consumes_code_and_moves_to_key_verify() {
        // 容错输入（小写 / 分隔符 / 前缀）全部可验：每种形态各自开一台
        // 状态机，用其自身生成的码按该形态变换后校验
        let variants: [fn(&PairCode) -> String; 4] = [
            |code| code.display(),
            |code| code.as_str().to_string(),
            |code| code.as_str().to_lowercase(),
            |code| format!("{}{}", PAIR_CODE_PREFIX, code.as_str()),
        ];
        for variant in variants {
            let mut fresh = PairStateMachine::new();
            let code = fresh.start(1_000).unwrap();
            let input = variant(&code);
            assert_eq!(fresh.verify(&input, 2_000), VerifyOutcome::Success);
            assert_eq!(fresh.state(), PairState::KeyVerify);
            // 一次性：二次校验 → Used
            assert_eq!(fresh.verify(&input, 3_000), VerifyOutcome::Used);
        }
    }

    #[test]
    fn verify_wrong_code_counts_attempts_and_locks() {
        let mut machine = PairStateMachine::new();
        let code = machine.start(1_000).unwrap();
        // 前 4 次错误 → WrongCode（未锁定）
        for i in 1..=4 {
            assert_eq!(
                machine.verify("AAAAAAAAAAAA", 1_000 + i),
                VerifyOutcome::WrongCode
            );
            let record = machine.codes().iter().find(|r| r.code == code).unwrap();
            assert_eq!(record.failed_attempts as u64, i);
            assert!(!record.is_locked(1_000 + i), "第 {i} 次失败不应锁定");
        }
        // 第 5 次错误 → 进入冷却
        assert_eq!(machine.verify("AAAAAAAAAAAA", 1_005), VerifyOutcome::WrongCode);
        let record = machine.codes().iter().find(|r| r.code == code).unwrap();
        assert_eq!(record.failed_attempts, PAIR_MAX_ATTEMPTS);
        assert!(record.is_locked(1_005));
        // 冷却期内正确码也拒绝
        assert_eq!(
            machine.verify(code.as_str(), 1_006),
            VerifyOutcome::Locked,
            "锁定期间正确码也应被拒"
        );
    }

    #[test]
    fn verify_expired_code_returns_expired() {
        let mut machine = PairStateMachine::new();
        let code = machine.start(1_000).unwrap();
        assert_eq!(
            machine.verify(code.as_str(), 1_000 + PAIR_CODE_TTL_MS),
            VerifyOutcome::Expired
        );
    }

    // ── R1-10 T-05：配对码爆破 → 5 次失败销毁会话 + 锁定 ──

    /// T-05 爆破防线全链：5 次失败 → 冷却期内正确码被拒（Locked）；
    /// 冷却结束后正确码永久失效（Destroyed，会话销毁）→ 只能重新开启
    /// 配对（新码）；销毁后状态面不再暴露失效码（active/failed 均归零）
    #[test]
    fn t05_bruteforce_five_failures_destroy_session_and_lock() {
        let mut machine = PairStateMachine::new();
        let code = machine.start(1_000).unwrap();
        // 4 次错误：仅计数，不销毁
        for i in 1..=4 {
            assert_eq!(machine.verify("AAAAAAAAAAAA", 1_000 + i), VerifyOutcome::WrongCode);
            assert_eq!(machine.failed_attempts(), i as u32, "第 {i} 次失败后计数应为 {i}");
        }
        // 第 5 次错误：锁定 + 销毁（冷却 5 分钟）
        assert_eq!(machine.verify("AAAAAAAAAAAA", 1_005), VerifyOutcome::WrongCode);
        {
            let record = machine.codes().iter().find(|r| r.code == code).unwrap();
            assert!(record.destroyed, "第 5 次失败必须销毁配对会话");
            assert!(record.is_locked(1_005));
            assert_eq!(record.failed_attempts, PAIR_MAX_ATTEMPTS);
        }

        // 冷却期内：正确码 → Locked（第一道闸）
        assert_eq!(
            machine.verify(code.as_str(), 1_006),
            VerifyOutcome::Locked,
            "冷却期内正确码必须被拒"
        );
        // 冷却结束后：正确码 → Destroyed（会话已销毁，永久失效）
        // 第 5 次失败发生在 1_005 → 冷却截止 = 1_005 + PAIR_LOCK_COOLDOWN_MS
        let after_cooldown = 1_005 + PAIR_LOCK_COOLDOWN_MS + 1;
        {
            let record = machine.codes().iter().find(|r| r.code == code).unwrap();
            assert!(!record.is_locked(after_cooldown), "冷却应已结束");
        }
        assert_eq!(
            machine.verify(code.as_str(), after_cooldown),
            VerifyOutcome::Destroyed,
            "冷却结束后销毁的会话仍必须拒绝正确码"
        );
        // 销毁后状态面：无活跃码（code_remaining_ms None / failed_attempts 0）
        assert_eq!(machine.active_code(after_cooldown), None, "销毁后无活跃码");
        assert_eq!(machine.active_code_remaining_ms(after_cooldown), None);
        assert_eq!(machine.failed_attempts(), 0, "销毁后失败计数归零（重新配对语义）");

        // 重新开启配对：新码可签发；销毁的旧记录被 purge 出表（永不复活）
        let new_code = machine.start(after_cooldown + 1).expect("新配对码必须可签发");
        assert_ne!(new_code, code, "重新配对必须换新码");
        assert!(
            !machine.codes().iter().any(|r| r.code == code),
            "销毁的旧码必须被 purge（不再存在于码表）"
        );
        assert_eq!(
            machine.verify(new_code.as_str(), after_cooldown + 2),
            VerifyOutcome::Success,
            "新码可正常完成配对"
        );
    }

    #[test]
    fn verify_invalid_format_and_not_awaiting() {
        // 格式非法（含 O 混淆字符）
        let mut machine = PairStateMachine::new();
        machine.start(1_000).unwrap();
        assert_eq!(
            machine.verify("CXN-7K4P-Q2MB-9XRO", 2_000),
            VerifyOutcome::InvalidFormat
        );
        assert_eq!(
            PairCode::normalize("CXN-7K4P-Q2MB-9XRO"),
            Err(PairCodeError::InvalidChar('O'))
        );
        // 未开启配对 → NotAwaiting
        let mut idle = PairStateMachine::new();
        assert_eq!(idle.verify("7K4PQ2MB9XRT", 1_000), VerifyOutcome::NotAwaiting);
        // KeyVerify 阶段（校验通过后）不再接受输入
        let mut after = PairStateMachine::new();
        let code = after.start(1_000).unwrap();
        after.verify(code.as_str(), 2_000);
        assert_eq!(after.verify(code.as_str(), 3_000), VerifyOutcome::Used);
    }

    #[test]
    fn cancel_clears_codes_and_returns_idle() {
        let mut machine = PairStateMachine::new();
        machine.start(1_000).unwrap();
        machine.cancel();
        assert_eq!(machine.state(), PairState::Idle);
        assert!(machine.codes().is_empty());
        assert_eq!(machine.verify("7K4PQ2MB9XRT", 2_000), VerifyOutcome::NotAwaiting);
    }

    #[test]
    fn sample_code_normalization_stays_consistent() {
        // 与 conex-types 既有用例交叉锚定（含 L 的码合法）
        assert!(PairCode::is_valid("CXN-7K4P-Q2MB-9XRT"));
        assert_eq!(sample_code().as_str(), "7K4PQ2MB9XRT");
    }
}
