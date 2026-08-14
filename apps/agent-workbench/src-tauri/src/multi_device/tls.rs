//! 传输安全层：自签 CA + 叶子证书生命周期 + rustls 装配 + 指纹固定。
//!
//! 对应任务包 R1-06（Z0 §9.3），安全基线 D5 §2 的 TLS 检查清单逐项落点：
//! - TLS-01 证书仅 ECDSA P-256；私钥文件 unix 下 0600 权限落盘；
//! - TLS-02 仅 TLS 1.3 / 1.2（`with_protocol_versions` 显式声明，禁 1.1/1.0/SSL）；
//! - TLS-03 仅 AEAD 套件：1.3 用 TLS_AES_256_GCM_SHA384、1.2 用 ECDHE-ECDSA-AES256-GCM（禁 CBC/RC4/3DES）；
//! - TLS-04 前向保密：密钥交换组只用 ring 默认 ECDHE 组（X25519 / P-256 / P-384），无 RSA 密钥交换；
//! - TLS-05 指纹固定：`ca_fingerprint()` 导出 SHA-256(SubjectPublicKeyInfo) 小写 hex
//!   （64 位，匹配 M6 §11.3 的 `^[A-Fa-f0-9]{64}$`），经配对信道带外传递（D3 §4.6 tlsFingerprint），
//!   服务端证书链 = 叶子 + CA（移动端据此验链到被 pin 的 CA）；
//! - TLS-06 轮换：叶子临近到期自动同 CA 重签（指纹不变，无需重新配对）；
//!   [`TlsMaterial::rotate_ca`] 一键重建 CA（指纹变更，全部设备必须重新配对）；
//! - TLS-07 会话复用：ServerConfig 每次调用新装配，票据密钥随机 → 跨重启票据天然失效；
//! - TLS-08 握手审计由 server 层承担（本模块只提供装配错误信息）；
//! - TLS-09 不做客户端证书认证：`with_no_client_auth`（客户端身份由应用层令牌承担）；
//! - TLS-10 依赖 rustls（内存安全、无 OpenSSL 历史 CVE 面），与 reqwest 0.13 的
//!   rustls-ring 同栈，不引入第二套 TLS 实现。
//!
//! 证书文件生命周期（目录 = `config_dir()/multi-device/`，目录语义对齐
//! workspace.rs 的 config_dir：`CRISH_WORKBENCH_CONFIG_DIR` → `%APPDATA%\Crish\AgentWorkbench` → temp 兜底）：
//! - `ca_cert.pem` / `ca_key.pem`：自签 CA（ECDSA P-256，10 年）；
//! - `server_cert.pem` / `server_key.pem`：服务端叶子（CN=crish-remote，D5 §2.2 有效期 1 年）；
//! - `tls.lock`：并发启动文件锁（fs2：unix flock / windows LockFileEx，进程退出自动释放）。
//!
//! 首次启动生成；叶子剩 30 天以内（或已过期）自动同 CA 重签；
//! CA 临近到期自动全量重建（指纹变更 → 全部设备重新配对）；
//! 所有落盘走同目录 tmp + rename 原子替换，私钥 0600（unix）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use fs2::FileExt;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use sha2::Digest;

/// 多端配置子目录名（挂于 config_dir() 下）。
const MULTI_DEVICE_DIR: &str = "multi-device";
/// 自签 CA 证书文件名。
const CA_CERT_FILE: &str = "ca_cert.pem";
/// 自签 CA 私钥文件名。
const CA_KEY_FILE: &str = "ca_key.pem";
/// 服务端叶子证书文件名。
const SERVER_CERT_FILE: &str = "server_cert.pem";
/// 服务端叶子私钥文件名。
const SERVER_KEY_FILE: &str = "server_key.pem";
/// 并发启动文件锁文件名。
const LOCK_FILE: &str = "tls.lock";
/// CA 主题通用名。
const CA_CN: &str = "crish-remote-ca";
/// 叶子主题通用名（D5 §2.2：CN=crish-remote）。
const SERVER_CN: &str = "crish-remote";
/// 文件锁最长等待秒数（超时视为另一个进程僵持，直接报错）。
const LOCK_WAIT_SECS: u64 = 10;
/// 证书生效时间提前量（容忍移动端时钟偏差 5 分钟）。
const CLOCK_SKEW_BUFFER: time::Duration = time::Duration::minutes(5);

/// 多端 TLS 材料（证书/私钥/指纹的内存态，装配 ServerConfig 用）。
#[derive(Debug)]
pub struct TlsMaterial {
    dir: PathBuf,
    opts: CertOptions,
    ca_cert_der: CertificateDer<'static>,
    ca_key_der: PrivatePkcs8KeyDer<'static>,
    /// 服务端证书链：叶子在前、CA 在后（TLS-05：客户端验链到被 pin 的 CA）。
    server_chain: Vec<CertificateDer<'static>>,
    server_key: PrivateKeyDer<'static>,
    /// CA 指纹：SHA-256(SubjectPublicKeyInfo) 小写 hex（64 位）。
    ca_fingerprint: String,
}

/// 证书有效期参数（测试注入短有效期以验证轮换路径）。
#[derive(Debug, Clone)]
struct CertOptions {
    /// CA 有效期（默认 10 年）。
    ca_lifetime: time::Duration,
    /// 叶子有效期（D5 §2.2 默认 1 年）。
    leaf_lifetime: time::Duration,
    /// 到期前重签阈值（剩余不足即重签，默认 30 天）。
    renew_threshold: time::Duration,
}

impl Default for CertOptions {
    fn default() -> Self {
        Self {
            ca_lifetime: time::Duration::days(3650),
            leaf_lifetime: time::Duration::days(365),
            renew_threshold: time::Duration::days(30),
        }
    }
}

/// 多端 TLS 错误。
#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    /// 证书目录文件锁获取失败（另一进程僵持超时）。
    #[error("证书目录文件锁获取失败（{path}）：{source}")]
    Lock {
        path: String,
        source: std::io::Error,
    },
    /// 证书文件读写失败。
    #[error("证书文件操作失败（{path}）：{source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    /// 证书材料解析失败（格式损坏或内容不匹配）。
    #[error("证书材料解析失败：{0}")]
    Parse(String),
    /// 证书生成或签发失败。
    #[error("证书生成或签发失败：{0}")]
    Generate(String),
    /// rustls 装配失败。
    #[error("rustls 装配失败：{0}")]
    Assembly(String),
}

impl From<rcgen::Error> for TlsError {
    fn from(e: rcgen::Error) -> Self {
        TlsError::Generate(e.to_string())
    }
}

impl From<rustls::Error> for TlsError {
    fn from(e: rustls::Error) -> Self {
        TlsError::Assembly(e.to_string())
    }
}

/// 多端配置目录（语义对齐 workspace.rs 的 config_dir）：
/// `CRISH_WORKBENCH_CONFIG_DIR` → `%APPDATA%\Crish\AgentWorkbench` → temp 兜底。
pub fn config_dir() -> PathBuf {
    if let Ok(path) = std::env::var("CRISH_WORKBENCH_CONFIG_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(app_data) = std::env::var("APPDATA") {
        let trimmed = app_data.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("Crish").join("AgentWorkbench");
        }
    }
    std::env::temp_dir().join("crish-agent-workbench")
}

/// 证书文件目录：`config_dir()/multi-device/`（只解析，不创建）。
pub fn cert_dir() -> PathBuf {
    config_dir().join(MULTI_DEVICE_DIR)
}

/// 指定证书目录的加载/生成（目录不存在时自动创建）。
///
/// 本函数供 server 装配注入指定目录（测试隔离真实配置目录；多实例/多证书目录场景显式指定）。
pub fn load_or_generate_in(dir: &Path) -> Result<TlsMaterial, TlsError> {
    load_or_generate_with(dir, &CertOptions::default())
}

/// 指定目录的加载（测试注入临时目录与短有效期）。
fn load_or_generate_with(dir: &Path, opts: &CertOptions) -> Result<TlsMaterial, TlsError> {
    fs::create_dir_all(dir).map_err(|e| TlsError::Io {
        path: dir.display().to_string(),
        source: e,
    })?;
    // 并发启动互斥：同一目录同时只有一进程执行生成/重签（锁随进程退出自动释放）。
    let _guard = lock_dir(dir)?;

    let ca_cert_path = dir.join(CA_CERT_FILE);
    let ca_key_path = dir.join(CA_KEY_FILE);

    // CA 缺失 → 首次生成；存在但临近/已过期 → 全量重建。
    let (ca_cert_der, ca_key_der, ca_rotated) = match load_ca_pair(&ca_cert_path, &ca_key_path)? {
        Some((cert, key)) if remaining_validity(cert.as_ref())? > opts.renew_threshold => {
            (cert, key, false)
        }
        _ => {
            let (cert, key) = generate_ca_pair(dir, opts)?;
            (cert, key, true)
        }
    };
    let ca_fingerprint = spki_sha256_hex(ca_cert_der.as_ref())?;

    // 叶子：CA 本轮变更 → 必须重签（旧叶子与新 CA 不匹配）；
    // 否则缺失/已过期/临近阈值 → 同 CA 重签（指纹不变）。
    let (server_cert_der, server_key_der) = if ca_rotated {
        sign_leaf(dir, &ca_cert_der, &ca_key_der, opts, &default_sans()?)?
    } else {
        let server_cert_path = dir.join(SERVER_CERT_FILE);
        let server_key_path = dir.join(SERVER_KEY_FILE);
        match load_leaf_pair(&server_cert_path, &server_key_path)? {
            Some((cert, key)) if remaining_validity(cert.as_ref())? > opts.renew_threshold => {
                (cert, key)
            }
            _ => sign_leaf(dir, &ca_cert_der, &ca_key_der, opts, &default_sans()?)?,
        }
    };

    let server_chain = vec![server_cert_der, ca_cert_der.clone()];
    Ok(TlsMaterial {
        dir: dir.to_path_buf(),
        opts: opts.clone(),
        ca_cert_der,
        ca_key_der,
        server_chain,
        server_key: server_key_der.into(),
        ca_fingerprint,
    })
}

impl TlsMaterial {
    /// CA 指纹（SHA-256(SubjectPublicKeyInfo) 小写 hex 64 位）。
    ///
    /// 供配对面板以文本/QR 呈现，经配对码信道带外传递给移动端作 pinning 锚
    /// （D3 §4.6 tlsFingerprint；D5 §2.2 指纹 = `sha256(SPKI)`，标准 pin 格式）。
    pub fn ca_fingerprint(&self) -> &str {
        &self.ca_fingerprint
    }

    /// CA 证书 PEM（从磁盘读取，供配对面板展示/导出与排障）。
    pub fn ca_cert_pem(&self) -> Result<String, TlsError> {
        let path = self.dir.join(CA_CERT_FILE);
        fs::read_to_string(&path).map_err(|e| TlsError::Io {
            path: path.display().to_string(),
            source: e,
        })
    }

    /// 装配 rustls ServerConfig（每次调用全新装配 → 票据密钥随机，跨重启失效，TLS-07）。
    ///
    /// rustls 0.23 的密码套件/密钥交换组由 CryptoProvider 承载（builder 链不再有
    /// with_cipher_suites），这里在 ring 默认 provider 基础上仅保留 AEAD 套件，
    /// 其余字段（kx 组/签名算法/随机源）原样继承。
    pub fn server_config(&self) -> Result<rustls::ServerConfig, TlsError> {
        let ring = rustls::crypto::ring::default_provider();
        let provider = Arc::new(rustls::crypto::CryptoProvider {
            // TLS-03：仅 AEAD 套件（1.3 的 AES-256-GCM / 1.2 的 ECDHE-ECDSA-AES256-GCM）。
            cipher_suites: vec![
                rustls::crypto::ring::cipher_suite::TLS13_AES_256_GCM_SHA384,
                rustls::crypto::ring::cipher_suite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
            ],
            // TLS-04：仅 ECDHE 组（X25519 / P-256 / P-384），无 RSA 密钥交换。
            kx_groups: ring.kx_groups.clone(),
            ..ring
        });
        let config = rustls::ServerConfig::builder_with_provider(provider)
            // TLS-02：显式声明仅 1.3 / 1.2。
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
            .map_err(TlsError::from)?
            // TLS-09：无客户端证书认证（客户端身份由应用层令牌承担）。
            .with_no_client_auth()
            .with_single_cert(self.server_chain.clone(), self.server_key.clone_key())
            .map_err(TlsError::from)?;
        // WebSocket 升级走 HTTP/1.1，ALPN 只声明 http/1.1。
        let mut config = config;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(config)
    }

    /// tokio 侧 TLS 接受器（server 骨架 R1-02 挂 wss 监听用）。
    pub fn tls_acceptor(&self) -> Result<tokio_rustls::TlsAcceptor, TlsError> {
        Ok(tokio_rustls::TlsAcceptor::from(Arc::new(
            self.server_config()?,
        )))
    }

    /// 一键轮换 CA（D5 §2.2 轮换语义）：重建 CA + 叶子，指纹变更，
    /// 全部已配对设备必须重新配对（旧指纹全部失效）。
    pub fn rotate_ca(&mut self) -> Result<(), TlsError> {
        let _guard = lock_dir(&self.dir)?;
        let (ca_cert_der, ca_key_der) = generate_ca_pair(&self.dir, &self.opts)?;
        let (server_cert_der, server_key_der) = sign_leaf(
            &self.dir,
            &ca_cert_der,
            &ca_key_der,
            &self.opts,
            &default_sans()?,
        )?;
        self.ca_cert_der = ca_cert_der;
        self.ca_key_der = ca_key_der;
        self.ca_fingerprint = spki_sha256_hex(self.ca_cert_der.as_ref())?;
        self.server_chain = vec![server_cert_der, self.ca_cert_der.clone()];
        self.server_key = server_key_der.into();
        Ok(())
    }

    /// 用新的 SAN 集合重签叶子证书（同 CA，指纹不变）。
    ///
    /// 用途：配对模式下绑定对外公布的局域网 IP/主机名（D5 §2.2 主机名校验
    /// 取配对 URL 的 host，SAN 需覆盖该 host）；移动端主机名校验由 R2-03 承担。
    pub fn reissue_leaf(&mut self, sans: &[String]) -> Result<(), TlsError> {
        let _guard = lock_dir(&self.dir)?;
        let san_types = sans
            .iter()
            .map(|s| parse_san(s))
            .collect::<Result<Vec<_>, _>>()?;
        let (server_cert_der, server_key_der) = sign_leaf(
            &self.dir,
            &self.ca_cert_der,
            &self.ca_key_der,
            &self.opts,
            &san_types,
        )?;
        self.server_chain = vec![server_cert_der, self.ca_cert_der.clone()];
        self.server_key = server_key_der.into();
        Ok(())
    }
}

/// 目录级文件锁守卫（drop 即释放；进程崩溃由 OS 自动释放）。
struct LockGuard {
    /// 持有锁的句柄：仅靠 Drop 语义持锁，字段本身不读取。
    _file: fs::File,
}

/// Windows ERROR_LOCK_VIOLATION（33，winerror.h）。
///
/// fs2 0.4.3 在 windows 上把锁竞争映射为 raw Os 错误（kind=Uncategorized），
/// unix 则映射为 WouldBlock；两者都要识别为竞争才能做轮询等待。
const ERROR_LOCK_VIOLATION: i32 = 33;

/// 判断 IO 错误是否为文件锁竞争（跨平台口径）。
fn is_lock_contention(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::WouldBlock || e.raw_os_error() == Some(ERROR_LOCK_VIOLATION)
}

/// 获取证书目录独占锁：try 轮询等待，超时 [`LOCK_WAIT_SECS`] 报错。
fn lock_dir(dir: &Path) -> Result<LockGuard, TlsError> {
    let lock_path = dir.join(LOCK_FILE);
    let file = fs::OpenOptions::new()
        .create(true)
        // 锁文件内容无意义，只用于持锁；明确不截断既有内容。
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| TlsError::Io {
            path: lock_path.display().to_string(),
            source: e,
        })?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(LOCK_WAIT_SECS);
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(LockGuard { _file: file }),
            Err(e) if is_lock_contention(&e) && std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(source) => {
                return Err(TlsError::Lock {
                    path: lock_path.display().to_string(),
                    source,
                });
            }
        }
    }
}

/// 原子写文件：同目录 tmp + rename（进程中断不留下半截文件）。
fn write_atomic(path: &Path, content: &str, mode: Option<u32>) -> Result<(), TlsError> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| TlsError::Io {
        path: tmp.display().to_string(),
        source: e,
    })?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        // TLS-01：私钥 0600（unix；windows 权限由用户目录 ACL 承接）。
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode)).map_err(|e| TlsError::Io {
            path: tmp.display().to_string(),
            source: e,
        })?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    fs::rename(&tmp, path).map_err(|e| TlsError::Io {
        path: path.display().to_string(),
        source: e,
    })
}

/// 从磁盘加载 CA 证书/私钥对（任一缺失返回 None → 走首次生成）。
fn load_ca_pair(
    cert_path: &Path,
    key_path: &Path,
) -> Result<Option<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>)>, TlsError> {
    if !cert_path.exists() || !key_path.exists() {
        return Ok(None);
    }
    Ok(Some((load_cert_der(cert_path)?, load_pkcs8_der(key_path)?)))
}

/// 从磁盘加载叶子证书/私钥对。
fn load_leaf_pair(
    cert_path: &Path,
    key_path: &Path,
) -> Result<Option<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>)>, TlsError> {
    if !cert_path.exists() || !key_path.exists() {
        return Ok(None);
    }
    Ok(Some((load_cert_der(cert_path)?, load_pkcs8_der(key_path)?)))
}

/// 从 PEM 文件读取首个 CERTIFICATE 块 → DER。
fn load_cert_der(path: &Path) -> Result<CertificateDer<'static>, TlsError> {
    let file = fs::File::open(path).map_err(|e| TlsError::Io {
        path: path.display().to_string(),
        source: e,
    })?;
    let mut reader = std::io::BufReader::new(file);
    match rustls_pemfile::read_one(&mut reader).map_err(|e| TlsError::Io {
        path: path.display().to_string(),
        source: e,
    })? {
        Some(rustls_pemfile::Item::X509Certificate(der)) => Ok(der),
        Some(_) => Err(TlsError::Parse(format!(
            "证书文件 {} 中首个 PEM 块不是证书",
            path.display()
        ))),
        None => Err(TlsError::Parse(format!(
            "证书文件 {} 中未找到证书块",
            path.display()
        ))),
    }
}

/// 从 PEM 文件读取私钥（PKCS#8）→ DER。
fn load_pkcs8_der(path: &Path) -> Result<PrivatePkcs8KeyDer<'static>, TlsError> {
    let file = fs::File::open(path).map_err(|e| TlsError::Io {
        path: path.display().to_string(),
        source: e,
    })?;
    let mut reader = std::io::BufReader::new(file);
    match rustls_pemfile::private_key(&mut reader).map_err(|e| TlsError::Io {
        path: path.display().to_string(),
        source: e,
    })? {
        Some(PrivateKeyDer::Pkcs8(pkcs8)) => Ok(pkcs8),
        Some(_) => Err(TlsError::Parse(format!(
            "私钥文件 {} 不是 PKCS#8 格式",
            path.display()
        ))),
        None => Err(TlsError::Parse(format!(
            "私钥文件 {} 中未找到私钥块",
            path.display()
        ))),
    }
}

/// 生成全新自签 CA 并落盘（CA + 私钥 PEM，私钥 0600）。
fn generate_ca_pair(
    dir: &Path,
    opts: &CertOptions,
) -> Result<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>), TlsError> {
    // TLS-01：ECDSA P-256（rcgen 默认签名算法）。
    let key_pair = rcgen::KeyPair::generate().map_err(TlsError::from)?;
    let mut params = rcgen::CertificateParams::default();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, CA_CN);
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::KeyCertSign,
        rcgen::KeyUsagePurpose::CrlSign,
        rcgen::KeyUsagePurpose::DigitalSignature,
    ];
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - CLOCK_SKEW_BUFFER;
    params.not_after = now + opts.ca_lifetime;
    let cert = params.self_signed(&key_pair).map_err(TlsError::from)?;
    let key_der = key_pair.serialize_der();

    write_atomic(&dir.join(CA_CERT_FILE), &cert.pem(), None)?;
    write_atomic(
        &dir.join(CA_KEY_FILE),
        &key_pair.serialize_pem(),
        Some(0o600),
    )?;
    Ok((cert.der().clone(), PrivatePkcs8KeyDer::from(key_der)))
}

/// 用磁盘上的 CA 签发叶子证书并落盘，返回内存态证书/私钥。
///
/// 说明：rcgen 的 [`rcgen::Certificate`] 无法由 DER 直接重建，这里用
/// `from_ca_cert_der` 还原 CA 参数后以同一密钥重新 `self_signed`——
/// 重建对象与磁盘 CA 同主题/同公钥/同有效期，仅序列号与签名随机化差异；
/// 只用于内存中签发，不落盘、不对客户端发送（对外链仍是磁盘 CA 原证书）。
fn sign_leaf(
    dir: &Path,
    ca_cert_der: &CertificateDer<'_>,
    ca_key_der: &PrivatePkcs8KeyDer<'_>,
    opts: &CertOptions,
    sans: &[rcgen::SanType],
) -> Result<(CertificateDer<'static>, PrivatePkcs8KeyDer<'static>), TlsError> {
    let ca_key_pair = rcgen::KeyPair::try_from(ca_key_der).map_err(TlsError::from)?;
    let ca_params =
        rcgen::CertificateParams::from_ca_cert_der(ca_cert_der).map_err(TlsError::from)?;
    let ca_cert = ca_params
        .self_signed(&ca_key_pair)
        .map_err(TlsError::from)?;

    // TLS-01：叶子同样 ECDSA P-256。
    let leaf_key = rcgen::KeyPair::generate().map_err(TlsError::from)?;
    let mut params = rcgen::CertificateParams::default();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, SERVER_CN);
    params.subject_alt_names = sans.to_vec();
    params.is_ca = rcgen::IsCa::NoCa;
    params.key_usages = vec![
        rcgen::KeyUsagePurpose::DigitalSignature,
        rcgen::KeyUsagePurpose::KeyEncipherment,
    ];
    params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - CLOCK_SKEW_BUFFER;
    params.not_after = now + opts.leaf_lifetime;
    let leaf = params
        .signed_by(&leaf_key, &ca_cert, &ca_key_pair)
        .map_err(TlsError::from)?;
    let leaf_key_der = leaf_key.serialize_der();

    write_atomic(&dir.join(SERVER_CERT_FILE), &leaf.pem(), None)?;
    write_atomic(
        &dir.join(SERVER_KEY_FILE),
        &leaf_key.serialize_pem(),
        Some(0o600),
    )?;
    Ok((leaf.der().clone(), PrivatePkcs8KeyDer::from(leaf_key_der)))
}

/// 默认 SAN：本机回环 + 叶子 CN（局域网 IP 由配对时 [`TlsMaterial::reissue_leaf`] 补充）。
fn default_sans() -> Result<Vec<rcgen::SanType>, TlsError> {
    ["crish-remote", "localhost", "127.0.0.1", "::1"]
        .iter()
        .map(|s| parse_san(s))
        .collect()
}

/// 解析 SAN 条目：可解析为 IP → IpAddress，否则按 DNS 域名校验。
fn parse_san(value: &str) -> Result<rcgen::SanType, TlsError> {
    if let Ok(ip) = value.parse::<std::net::IpAddr>() {
        return Ok(rcgen::SanType::IpAddress(ip));
    }
    let name = rcgen::Ia5String::try_from(value.to_string())
        .map_err(|e| TlsError::Parse(format!("非法 SAN 域名 {value}：{e}")))?;
    Ok(rcgen::SanType::DnsName(name))
}

/// 解析证书 DER（x509-parser 0.16 的错误是 nom 包装类型，统一映射为 [`TlsError::Parse`]）。
fn parse_cert_der<'a>(
    cert_der: &'a [u8],
) -> Result<x509_parser::certificate::X509Certificate<'a>, TlsError> {
    x509_parser::parse_x509_certificate(cert_der)
        .map(|(_, cert)| cert)
        .map_err(|e| TlsError::Parse(e.to_string()))
}

/// 证书剩余有效期（不足视为 0，即已过期）。
fn remaining_validity(cert_der: &[u8]) -> Result<time::Duration, TlsError> {
    let cert = parse_cert_der(cert_der)?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let remaining = cert.validity().not_after.timestamp() - now;
    Ok(time::Duration::seconds(remaining.max(0)))
}

/// CA 指纹：SHA-256(SubjectPublicKeyInfo) 小写 hex（D5 §2.2 标准 pin 格式）。
fn spki_sha256_hex(cert_der: &[u8]) -> Result<String, TlsError> {
    let cert = parse_cert_der(cert_der)?;
    let spki = cert.tbs_certificate.subject_pki.raw;
    Ok(hex_lower(&sha2::Sha256::digest(spki)))
}

/// 小写 hex 编码。
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 测试专用参数：叶子 1 天、阈值 2 天 → 每次加载都触发重签路径。
    fn opts_leaf_short() -> CertOptions {
        CertOptions {
            ca_lifetime: time::Duration::days(3650),
            leaf_lifetime: time::Duration::days(1),
            renew_threshold: time::Duration::days(2),
        }
    }

    fn not_after_unix(cert_der: &[u8]) -> i64 {
        let (_, cert) = x509_parser::parse_x509_certificate(cert_der).expect("解析证书");
        cert.validity().not_after.timestamp()
    }

    fn spki_algorithm_oid(cert_der: &[u8]) -> String {
        let (_, cert) = x509_parser::parse_x509_certificate(cert_der).expect("解析证书");
        cert.tbs_certificate
            .subject_pki
            .algorithm
            .algorithm
            .to_id_string()
    }

    fn spki_raw(cert_der: &[u8]) -> Vec<u8> {
        let (_, cert) = x509_parser::parse_x509_certificate(cert_der).expect("解析证书");
        cert.tbs_certificate.subject_pki.raw.to_vec()
    }

    /// 默认客户端配置：信任锚 = 指定 CA（None = 空根库，模拟无系统信任）。
    fn default_client_config(trust_ca: Option<&CertificateDer<'static>>) -> rustls::ClientConfig {
        let mut roots = rustls::RootCertStore::empty();
        if let Some(ca) = trust_ca {
            roots.add(ca.clone()).expect("CA 入根库");
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("默认版本受 rustls 支持")
            .with_root_certificates(roots)
            .with_no_client_auth()
    }

    /// 完整 TLS 握手 + 双向字节交换；返回是否成功（服务端/客户端任一端失败即 false）。
    async fn try_handshake(
        material: &TlsMaterial,
        trust_ca: Option<&CertificateDer<'static>>,
    ) -> bool {
        try_handshake_with(material, default_client_config(trust_ca)).await
    }

    /// 指定客户端配置的握手往返（套件/版本/证书验证器注入用）。
    async fn try_handshake_with(
        material: &TlsMaterial,
        client_config: rustls::ClientConfig,
    ) -> bool {
        let acceptor = material.tls_acceptor().expect("装配 acceptor");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定测试端口");
        let addr = listener.local_addr().expect("读取监听地址");

        let server = async {
            let (stream, _) = listener.accept().await?;
            let mut tls = acceptor.accept(stream).await?;
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            tls.write_all(b"hello").await?;
            tls.flush().await?;
            let mut buf = [0u8; 4];
            tls.read_exact(&mut buf).await?;
            Ok::<(), std::io::Error>(())
        };
        let client = async {
            let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config));
            let stream = tokio::net::TcpStream::connect(addr).await?;
            let server_name =
                rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
            let mut tls = connector.connect(server_name, stream).await?;
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = [0u8; 5];
            tls.read_exact(&mut buf).await?;
            tls.write_all(b"pong").await?;
            tls.flush().await?;
            Ok::<(), std::io::Error>(())
        };
        match tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (r1, r2) = tokio::join!(server, client);
            r1.is_ok() && r2.is_ok()
        })
        .await
        {
            Ok(ok) => ok,
            Err(_) => false,
        }
    }

    #[test]
    fn first_generation_creates_files_and_assembles() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        // 四证书件 + 锁文件齐备。
        for f in [
            CA_CERT_FILE,
            CA_KEY_FILE,
            SERVER_CERT_FILE,
            SERVER_KEY_FILE,
            LOCK_FILE,
        ] {
            assert!(dir.path().join(f).exists(), "{f} 应已生成");
        }
        // 指纹：64 位小写 hex（M6 §11.3 的 ^[A-Fa-f0-9]{64}$）。
        assert_eq!(material.ca_fingerprint().len(), 64);
        assert!(material
            .ca_fingerprint()
            .chars()
            .all(|c| c.is_ascii_hexdigit()));
        // 指纹 = 从磁盘 CA 证书解析的 sha256(SPKI)，两路一致。
        let ca_file_der = load_cert_der(&dir.path().join(CA_CERT_FILE)).expect("读回 CA 证书");
        assert_eq!(
            material.ca_fingerprint(),
            spki_sha256_hex(ca_file_der.as_ref()).expect("计算指纹")
        );
        // 叶子主题 CN=crish-remote（D5 §2.2）。
        let leaf_der = load_cert_der(&dir.path().join(SERVER_CERT_FILE)).expect("读回叶子证书");
        let (_, leaf_x509) =
            x509_parser::parse_x509_certificate(leaf_der.as_ref()).expect("解析叶子");
        assert_eq!(
            leaf_x509
                .subject()
                .iter_common_name()
                .next()
                .expect("应有 CN")
                .as_str()
                .expect("CN 应为字符串"),
            SERVER_CN
        );
        // 证书链 = 叶子 + CA（TLS-05：客户端验链到被 pin 的 CA）。
        assert_eq!(material.server_chain.len(), 2);
        assert_eq!(material.server_chain[0], leaf_der);
        assert_eq!(material.server_chain[1], ca_file_der);
        // ServerConfig 装配成功，ALPN 为 http/1.1。
        let config = material.server_config().expect("装配 ServerConfig");
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
    }

    #[test]
    fn reload_keeps_fingerprint_and_files_stable() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let m1 = load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次加载");
        let ca_file_before = fs::read(dir.path().join(CA_CERT_FILE)).expect("读取 CA 文件");
        let server_file_before = fs::read(dir.path().join(SERVER_CERT_FILE)).expect("读取叶子文件");

        let m2 = load_or_generate_with(dir.path(), &CertOptions::default()).expect("二次加载");
        // 同一证书 → 指纹稳定（测试验收项：同一证书两次指纹一致）。
        assert_eq!(m1.ca_fingerprint(), m2.ca_fingerprint());
        assert_eq!(m1.server_chain[1], m2.server_chain[1]);
        // 未到阈值 → 文件不被重写。
        assert_eq!(
            ca_file_before,
            fs::read(dir.path().join(CA_CERT_FILE)).expect("重读 CA")
        );
        assert_eq!(
            server_file_before,
            fs::read(dir.path().join(SERVER_CERT_FILE)).expect("重读叶子")
        );
    }

    #[test]
    fn near_expiry_leaf_is_renewed_keeping_fingerprint() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let opts = opts_leaf_short();
        let m1 = load_or_generate_with(dir.path(), &opts).expect("首次加载");
        let fp_before = m1.ca_fingerprint().to_string();
        let leaf1 = load_cert_der(&dir.path().join(SERVER_CERT_FILE)).expect("读取叶子 DER");
        let ca_before = fs::read(dir.path().join(CA_CERT_FILE)).expect("读取 CA");

        // 叶子剩余（≈1 天）≤ 阈值（2 天）→ 同 CA 重签。
        let m2 = load_or_generate_with(dir.path(), &opts).expect("二次加载");
        let leaf2 = load_cert_der(&dir.path().join(SERVER_CERT_FILE)).expect("重读叶子 DER");
        assert_ne!(leaf1.as_ref(), leaf2.as_ref(), "叶子应被重签");
        // 重签后有效期不得缩短（x509-parser 的 timestamp 秒级截断，同一秒内可能相等，
        // 故用 >=；过期场景下重签必然恢复完整窗口）。
        assert!(
            not_after_unix(leaf2.as_ref()) >= not_after_unix(leaf1.as_ref()),
            "重签后叶子有效期不得缩短"
        );
        // 指纹不变（同 CA 重签不破坏移动端 pinning），CA 文件不变。
        assert_eq!(fp_before, m2.ca_fingerprint());
        assert_eq!(
            ca_before,
            fs::read(dir.path().join(CA_CERT_FILE)).expect("重读 CA")
        );
    }

    #[test]
    fn ca_rotation_changes_fingerprint_and_invalidates_old() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let mut material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次加载");
        let old_fp = material.ca_fingerprint().to_string();
        let old_ca = load_cert_der(&dir.path().join(CA_CERT_FILE)).expect("读回旧 CA");

        material.rotate_ca().expect("一键轮换");
        assert_ne!(
            old_fp,
            material.ca_fingerprint(),
            "轮换后指纹必须变更（D5 §2.2）"
        );
        // 轮换后旧 CA 指纹失效：以旧 CA 为信任锚的客户端握手失败，新 CA 成功。
        let future = try_handshake(&material, Some(&old_ca));
        let accepted_by_old = tokio::runtime::Runtime::new()
            .expect("创建运行时")
            .block_on(future);
        assert!(!accepted_by_old, "旧指纹连接必须被拒绝");
    }

    #[tokio::test]
    async fn handshake_succeeds_with_pinned_ca() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let ca = load_cert_der(&dir.path().join(CA_CERT_FILE)).expect("读回 CA 证书");
        // 移动端语义：信任锚 = 配对期拿到的 CA 证书 → 握手 + 双向字节交换成功。
        assert!(try_handshake(&material, Some(&ca)).await);
    }

    #[tokio::test]
    async fn handshake_rejects_untrusted_client() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        // 空信任锚（系统 CA 不参与，D5 §2.2 pinning 模型）→ 握手失败。
        assert!(!try_handshake(&material, None).await);
    }

    #[test]
    fn concurrent_load_waits_for_lock() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        // 主线程先占用目录锁，模拟并发启动中的另一进程。
        let lock_path = dir.path().join(LOCK_FILE);
        let lock_file = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("打开锁文件");
        lock_file.lock_exclusive().expect("主线程占用锁");

        let (tx, rx) = std::sync::mpsc::channel();
        let dir2 = dir.path().to_path_buf();
        let handle = std::thread::spawn(move || {
            let m =
                load_or_generate_with(&dir2, &CertOptions::default()).expect("等待锁后加载成功");
            let _ = tx.send(m.ca_fingerprint().to_string());
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(rx.try_recv().is_err(), "锁未释放时子线程不应完成加载");
        lock_file.unlock().expect("释放锁");
        let fp = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("子线程应等到锁后完成");
        assert_eq!(fp.len(), 64);
        handle.join().expect("子线程正常结束");
    }

    #[test]
    fn leaf_key_is_ecdsa_p256() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let leaf_der = load_cert_der(&dir.path().join(SERVER_CERT_FILE)).expect("读回叶子");
        // TLS-01：算法 = id-ecPublicKey（1.2.840.10045.2.1），曲线 = secp256r1（1.2.840.10045.3.1.7）。
        assert_eq!(spki_algorithm_oid(leaf_der.as_ref()), "1.2.840.10045.2.1");
        // P-256 SPKI 固定 DER 前缀（RFC 5480：算法 OID + 曲线 OID + 未压缩点标记）。
        const P256_SPKI_PREFIX: &[u8] = &[
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06,
            0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
        ];
        assert!(spki_raw(leaf_der.as_ref()).starts_with(&P256_SPKI_PREFIX[..]));
    }

    #[test]
    fn reissue_leaf_replaces_sans() {
        let dir = tempfile::tempdir().expect("创建临时目录");
        let mut material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let fp_before = material.ca_fingerprint().to_string();

        // 配对模式：把局域网 IP 与主机名补进叶子 SAN。
        material
            .reissue_leaf(&["192.168.1.50".to_string(), "hub.local".to_string()])
            .expect("重签叶子");
        assert_eq!(
            fp_before,
            material.ca_fingerprint(),
            "重签叶子不改变 CA 指纹"
        );

        let leaf_der = load_cert_der(&dir.path().join(SERVER_CERT_FILE)).expect("读回叶子");
        let (_, leaf_x509) =
            x509_parser::parse_x509_certificate(leaf_der.as_ref()).expect("解析叶子");
        let san_names = leaf_x509
            .extensions()
            .iter()
            .find_map(|ext| match ext.parsed_extension() {
                x509_parser::extensions::ParsedExtension::SubjectAlternativeName(names) => {
                    Some(names)
                }
                _ => None,
            })
            .expect("叶子应含 SAN 扩展");
        assert!(
            san_names.general_names.iter().any(
                |n| matches!(n, x509_parser::extensions::GeneralName::IPAddress(octets)
                    if octets == &[192, 168, 1, 50])
            ),
            "SAN 应含 192.168.1.50"
        );
        assert!(
            san_names.general_names.iter().any(|n| {
                matches!(n, x509_parser::extensions::GeneralName::DNSName(name)
                    if *name == "hub.local")
            }),
            "SAN 应含 hub.local"
        );
    }

    #[test]
    fn fingerprint_matches_sha256_of_key_spki() {
        // 与 key pair 导出的 SPKI 交叉验证（同一公钥的两种编码路径必须一致）。
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let ca_key_der = load_pkcs8_der(&dir.path().join(CA_KEY_FILE)).expect("读回 CA 私钥");
        let ca_key = rcgen::KeyPair::try_from(&ca_key_der).expect("还原 KeyPair");
        let digest = sha2::Sha256::digest(ca_key.public_key_der());
        assert_eq!(material.ca_fingerprint(), hex_lower(&digest));
    }

    // ── R1-10 安全测试面：TLS-01~10 清单自动化（D5 §2.5 清单 / §9.4 用例 / §9.1 T-03）────

    use rustls::client::danger::ServerCertVerifier;

    /// 移动端对偶验证器（D5 §2.2 pinning 模型 / TLS-05）：客户端只信任
    /// SHA-256(SubjectPublicKeyInfo) 与配对期拿到的指纹一致的证书链
    /// （T-03 自动化的「注入错误指纹」载体，对应移动端对偶实现）。
    #[derive(Debug)]
    struct FingerprintVerifier {
        /// 期望 CA 指纹（64 位小写 hex）。
        pinned: String,
        /// ring 的签名算法支持面（委托真实签名校验）。
        supported: rustls::crypto::WebPkiSupportedAlgorithms,
    }

    impl FingerprintVerifier {
        fn new(pinned: String) -> Self {
            Self {
                pinned,
                supported: rustls::crypto::ring::default_provider()
                    .signature_verification_algorithms,
            }
        }
    }

    impl rustls::client::danger::ServerCertVerifier for FingerprintVerifier {
        fn verify_server_cert(
            &self,
            end_entity: &rustls::pki_types::CertificateDer<'_>,
            intermediates: &[rustls::pki_types::CertificateDer<'_>],
            server_name: &rustls::pki_types::ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            // 主机名校验（TLS-05 移动端职责）：SNI 必须与固定域名一致。
            let expected =
                rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
            if server_name != &expected {
                return Err(rustls::Error::General(format!(
                    "主机名未在固定清单：{server_name:?}"
                )));
            }
            // 指纹 pin：链上任一证书（叶子或中间 CA）SPKI 指纹命中即放行；
            // 服务端证书链 = 叶子 + CA（TLS-05 注释），pin 锚定 CA。
            let pinned = self.pinned.as_str();
            let matched = std::iter::once(end_entity)
                .chain(intermediates.iter())
                .any(|cert| spki_sha256_hex(cert.as_ref()).ok().as_deref() == Some(pinned));
            if matched {
                Ok(rustls::client::danger::ServerCertVerified::assertion())
            } else {
                Err(rustls::Error::General(format!(
                    "CA 指纹不匹配（pin={pinned}），拒绝握手（T-03）"
                )))
            }
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(message, cert, dss, &self.supported)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(message, cert, dss, &self.supported)
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.supported.supported_schemes()
        }
    }

    /// 指纹 pin 客户端（注入 pin 值；错误 pin → 握手拒绝）。
    fn client_config_with_pin(pin: String) -> rustls::ClientConfig {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("默认版本受 rustls 支持")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(FingerprintVerifier::new(pin)))
            .with_no_client_auth()
    }

    /// 受限套件客户端：指定套件 + 版本（信任锚 = CA 证书；None = 空根库）。
    fn client_config_restricted(
        suites: &[rustls::SupportedCipherSuite],
        versions: &[&'static rustls::SupportedProtocolVersion],
        trust_ca: Option<&CertificateDer<'static>>,
    ) -> rustls::ClientConfig {
        let ring = rustls::crypto::ring::default_provider();
        let provider = Arc::new(rustls::crypto::CryptoProvider {
            cipher_suites: suites.to_vec(),
            kx_groups: ring.kx_groups.clone(),
            ..ring
        });
        let mut roots = rustls::RootCertStore::empty();
        if let Some(ca) = trust_ca {
            roots.add(ca.clone()).expect("CA 入根库");
        }
        rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(versions)
            .expect("版本组合受 rustls 支持")
            .with_root_certificates(roots)
            .with_no_client_auth()
    }

    #[test]
    fn fingerprint_verifier_rejects_wrong_pin_unit() {
        // D5 §9.4 tls_wrong_fingerprint_rejected 的验证器单元面（不依赖网络）。
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let name = rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
        let now = rustls::pki_types::UnixTime::now();
        // 正确指纹 → 放行。
        let ok_verifier = FingerprintVerifier::new(material.ca_fingerprint().to_string());
        assert!(
            ok_verifier
                .verify_server_cert(
                    &material.server_chain[0],
                    &[material.server_chain[1].clone()],
                    &name,
                    &[],
                    now,
                )
                .is_ok(),
            "正确指纹必须放行"
        );
        // 错误指纹（全零 64 hex，模拟攻击者伪造 CA 的 SPKI）→ 拒绝。
        let bad_verifier = FingerprintVerifier::new("0".repeat(64));
        assert!(
            bad_verifier
                .verify_server_cert(
                    &material.server_chain[0],
                    &[material.server_chain[1].clone()],
                    &name,
                    &[],
                    now,
                )
                .is_err(),
            "错误指纹必须拒绝（T-03）"
        );
        // 主机名不匹配 → 拒绝（TLS-05 主机名校验由移动端承担）。
        let other_name =
            rustls::pki_types::ServerName::try_from("evil.example.com").expect("域名合法");
        assert!(
            ok_verifier
                .verify_server_cert(
                    &material.server_chain[0],
                    &[material.server_chain[1].clone()],
                    &other_name,
                    &[],
                    now,
                )
                .is_err(),
            "主机名不匹配必须拒绝"
        );
    }

    #[tokio::test]
    async fn tls_wrong_fingerprint_rejected_handshake() {
        // T-03 自动化（D5 §9.1）：注入错误指纹 → 握手失败，无降级路径；
        // 控制组：正确指纹 → 握手成功。
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let wrong = client_config_with_pin("0".repeat(64));
        assert!(
            !try_handshake_with(&material, wrong).await,
            "错误指纹必须握手失败（T-03）"
        );
        let right = client_config_with_pin(material.ca_fingerprint().to_string());
        assert!(
            try_handshake_with(&material, right).await,
            "正确指纹必须握手成功"
        );
    }

    #[tokio::test]
    async fn tls_weak_cipher_absent_exact_aead_allowlist() {
        // D5 §9.4 tls_weak_cipher_absent（TLS-03）：服务端只接受
        // TLS_AES_256_GCM_SHA384（1.3）/ ECDHE-ECDSA-AES256-GCM（1.2），
        // 白名单外的套件一律握手失败（含其余 AEAD 套件，如 AES-128-GCM）。
        use rustls::crypto::ring::cipher_suite::{
            TLS13_AES_128_GCM_SHA256, TLS13_AES_256_GCM_SHA384,
            TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
        };
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let ca = load_cert_der(&dir.path().join(CA_CERT_FILE)).expect("读回 CA 证书");
        // 1.3：白名单外（AES-128-GCM）→ 拒绝。
        let client = client_config_restricted(
            &[TLS13_AES_128_GCM_SHA256],
            &[&rustls::version::TLS13],
            Some(&ca),
        );
        assert!(
            !try_handshake_with(&material, client).await,
            "白名单外 1.3 套件必须拒绝"
        );
        // 1.3：白名单内（AES-256-GCM）→ 放行（控制组）。
        let client = client_config_restricted(
            &[TLS13_AES_256_GCM_SHA384],
            &[&rustls::version::TLS13],
            Some(&ca),
        );
        assert!(
            try_handshake_with(&material, client).await,
            "白名单 1.3 套件必须放行"
        );
        // 1.2：白名单外（ECDHE-ECDSA-AES128-GCM）→ 拒绝。
        let client = client_config_restricted(
            &[TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256],
            &[&rustls::version::TLS12],
            Some(&ca),
        );
        assert!(
            !try_handshake_with(&material, client).await,
            "白名单外 1.2 套件必须拒绝"
        );
        // 1.2：白名单内（ECDHE-ECDSA-AES256-GCM）→ 放行（控制组；同时证明
        // 服务端接受 1.2——TLS-02 的行为面）。
        let client = client_config_restricted(
            &[TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384],
            &[&rustls::version::TLS12],
            Some(&ca),
        );
        assert!(
            try_handshake_with(&material, client).await,
            "白名单 1.2 套件必须放行"
        );
    }

    #[test]
    fn session_resumption_tickets_disabled() {
        // TLS-07：默认装配不签发会话票据（rustls 默认 NeverProducesTickets），
        // 跨重启/跨装配不存在可复用的票据——比「重启清空票据密钥」更强。
        let dir = tempfile::tempdir().expect("创建临时目录");
        let material =
            load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        let config = material.server_config().expect("装配 ServerConfig");
        assert!(!config.ticketer.enabled(), "会话复用票据必须禁用（TLS-07）");
    }

    #[cfg(unix)]
    #[test]
    fn private_key_files_are_0600_on_unix() {
        // TLS-01：私钥 0600 落盘（unix；windows 由用户目录 ACL 承接，见 write_atomic）。
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("创建临时目录");
        load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
        for f in [CA_KEY_FILE, SERVER_KEY_FILE] {
            let meta = fs::metadata(dir.path().join(f)).expect("读取私钥文件元数据");
            assert_eq!(
                meta.permissions().mode() & 0o777,
                0o600,
                "{f} 权限必须 0600（TLS-01）"
            );
        }
    }
}
