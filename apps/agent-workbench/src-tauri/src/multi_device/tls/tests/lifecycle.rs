//! TLS 测试 · 证书生命周期（生成 / 重载 / 重签 / 轮换 / 并发锁）。

use super::super::*;
use super::support::*;

use std::fs;

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
        .truncate(true)
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
    assert!(spki_raw(leaf_der.as_ref()).starts_with(P256_SPKI_PREFIX));
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
