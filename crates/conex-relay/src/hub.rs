//! 中继房间：按 (account_id, host_device_id) 配对 host/client，双向转发 JSON 文本帧。
//!
//! 房间内最多一个 host 与一个 client；同角色新连接替换旧连接（移动端重连/
//! 桌面重启场景）。出站队列同时受「帧数」与「全局排队字节预算」双重约束：
//! 慢消费者先被背压断链，攻击者也无法用大帧把中继内存打爆。

use crate::ticket::{TicketClaims, TicketRole};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use thiserror::Error;
use tokio::sync::mpsc;

/// 单连接出站队列上限（帧数；控制帧与业务帧共用）。
pub const PEER_CHANNEL_CAPACITY: usize = 32;
/// 每帧排队开销（String 头 + 队列节点 + 序列化余量），计入全局预算。
const FRAME_OVERHEAD_BYTES: usize = 64;

/// 出站帧（携带字节数，发送完成后退还全局预算）。
#[derive(Debug)]
pub struct OutboundFrame {
    pub text: String,
    pub bytes: usize,
}

pub type PeerSender = mpsc::Sender<OutboundFrame>;

/// 全中继共享的出站排队字节预算（防止慢消费者把内存放大到 GB 级）。
#[derive(Debug)]
pub struct ByteBudget {
    limit: usize,
    used: AtomicUsize,
}

impl ByteBudget {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            used: AtomicUsize::new(0),
        }
    }

    fn try_reserve(&self, bytes: usize) -> bool {
        let mut current = self.used.load(Ordering::Acquire);
        loop {
            if current.saturating_add(bytes) > self.limit {
                return false;
            }
            // CAS 成功 = 预留完成；失败时返回值即当前实际值，直接用作下次比较，
            // 避免额外的 load 往返（weak 允许伪失败，同样走该分支）。
            match self.used.compare_exchange_weak(
                current,
                current + bytes,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }

    fn release(&self, bytes: usize) {
        self.used.fetch_sub(bytes, Ordering::AcqRel);
    }

    #[cfg(test)]
    fn used(&self) -> usize {
        self.used.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone)]
pub struct Peer {
    pub conn_id: u64,
    pub role: TicketRole,
    pub device_id: String,
    pub device_name: String,
    pub connected_at_ms: u64,
    pub tx: PeerSender,
}

/// 账号内在线设备（host 或 client；用于自动发现与桌面设备列表）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OnlineDevice {
    pub device_id: String,
    pub name: String,
    pub role: TicketRole,
    pub connected_at_ms: u64,
}

#[derive(Debug)]
pub struct Joined {
    pub conn_id: u64,
    pub room_key: String,
    /// 对端（若已在线）；server 据此通知双方 peer online。
    pub peer: Option<Peer>,
    /// 同角色被替换的旧连接；server 应发送 replaced 错误并关闭旧连接。
    pub replaced: Option<Peer>,
}

#[derive(Debug, Error)]
pub enum HubError {
    #[error("client ticket missing target")]
    MissingTarget,
    #[error("peer not connected")]
    NoPeer,
    #[error("peer channel closed")]
    Closed,
    #[error("peer is too slow")]
    Backpressure,
}

#[derive(Default)]
struct Room {
    host: Option<Peer>,
    client: Option<Peer>,
}

impl Room {
    fn is_empty(&self) -> bool {
        self.host.is_none() && self.client.is_none()
    }
}

pub struct Hub {
    rooms: Mutex<HashMap<String, Room>>,
    next_conn: AtomicU64,
    budget: ByteBudget,
}

impl Hub {
    pub fn new(queued_bytes_limit: usize) -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(0),
            budget: ByteBudget::new(queued_bytes_limit),
        }
    }

    fn room_key(claims: &TicketClaims) -> Result<String, HubError> {
        let host = match claims.role {
            TicketRole::Host => claims.device_id.as_str(),
            TicketRole::Client => claims
                .target_device_id
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or(HubError::MissingTarget)?,
        };
        Ok(format!("{}:{}", claims.account_id, host))
    }

    /// 加入房间；同角色旧连接会被替换并返回给调用方关闭。
    pub fn join(&self, claims: &TicketClaims, tx: PeerSender) -> Result<Joined, HubError> {
        let room_key = Self::room_key(claims)?;
        let conn_id = self.next_conn.fetch_add(1, Ordering::Relaxed) + 1;
        let fallback_name = match claims.role {
            TicketRole::Host => "Desktop",
            TicketRole::Client => "Mobile",
        };
        let device_name = claims
            .device_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback_name)
            .to_string();
        let peer = Peer {
            conn_id,
            role: claims.role,
            device_id: claims.device_id.clone(),
            device_name,
            connected_at_ms: unix_ms(),
            tx,
        };
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        let room = rooms.entry(room_key.clone()).or_default();
        let (replaced, other) = match claims.role {
            TicketRole::Host => {
                let replaced = room.host.replace(peer);
                (replaced, room.client.clone())
            }
            TicketRole::Client => {
                let replaced = room.client.replace(peer);
                (replaced, room.host.clone())
            }
        };
        Ok(Joined {
            conn_id,
            room_key,
            peer: other,
            replaced,
        })
    }

    /// 离开房间；返回仍在线的对端（server 据此发送 peer offline）。
    pub fn leave(&self, room_key: &str, conn_id: u64) -> Option<Peer> {
        let mut rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        let room = rooms.get_mut(room_key)?;
        let mut other = None;
        if room.host.as_ref().is_some_and(|p| p.conn_id == conn_id) {
            room.host = None;
            other = room.client.clone();
        } else if room.client.as_ref().is_some_and(|p| p.conn_id == conn_id) {
            room.client = None;
            other = room.host.clone();
        }
        if room.is_empty() {
            rooms.remove(room_key);
        }
        other
    }

    /// 把消息发给房间内另一个角色。
    pub fn forward(&self, room_key: &str, conn_id: u64, message: String) -> Result<(), HubError> {
        let target = {
            let rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
            let room = rooms.get(room_key).ok_or(HubError::Closed)?;
            let is_host = room.host.as_ref().is_some_and(|p| p.conn_id == conn_id);
            let is_client = room.client.as_ref().is_some_and(|p| p.conn_id == conn_id);
            if is_host {
                room.client.clone()
            } else if is_client {
                room.host.clone()
            } else {
                return Err(HubError::Closed);
            }
        };
        let target = target.ok_or(HubError::NoPeer)?;
        self.send(&target.tx, message)
    }

    /// 向指定连接发送一帧（全局字节预算 + 有界队列双重门控）。
    pub fn send(&self, tx: &PeerSender, text: String) -> Result<(), HubError> {
        let bytes = text.len().saturating_add(FRAME_OVERHEAD_BYTES);
        if !self.budget.try_reserve(bytes) {
            return Err(HubError::Backpressure);
        }
        match tx.try_send(OutboundFrame { text, bytes }) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.budget.release(bytes);
                Err(match error {
                    mpsc::error::TrySendError::Full(_) => HubError::Backpressure,
                    mpsc::error::TrySendError::Closed(_) => HubError::Closed,
                })
            }
        }
    }

    /// 主动向指定 peer 发送控制帧（best-effort；失败说明连接已不可用）。
    pub fn send_to(&self, peer: &Peer, message: String) -> Result<(), HubError> {
        self.send(&peer.tx, message)
    }

    /// 出站帧写出后由 sink 任务归还预算。
    pub fn release(&self, bytes: usize) {
        self.budget.release(bytes);
    }

    /// 列出账号内当前在线的设备（移动端自动发现 / 桌面设备列表的数据源）。
    pub fn online_devices(&self, account_id: &str) -> Vec<OnlineDevice> {
        let prefix = format!("{account_id}:");
        let rooms = self.rooms.lock().unwrap_or_else(|e| e.into_inner());
        rooms
            .iter()
            .filter(|(key, _)| key.starts_with(&prefix))
            .flat_map(|(_, room)| [room.host.as_ref(), room.client.as_ref()])
            .flatten()
            .map(|peer| OnlineDevice {
                device_id: peer.device_id.clone(),
                name: peer.device_name.clone(),
                role: peer.role,
                connected_at_ms: peer.connected_at_ms,
            })
            .collect()
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ticket::TicketClaims;

    const TEST_BUDGET: usize = 1024 * 1024;

    fn claims(role: TicketRole) -> TicketClaims {
        match role {
            TicketRole::Host => TicketClaims::host("acc-1", "desk-1", None, 60),
            TicketRole::Client => {
                TicketClaims::client("acc-1", "mob-1", Some("Phone".to_string()), "desk-1", 60)
            }
        }
    }

    #[tokio::test]
    async fn host_and_client_pair_and_forward() {
        let hub = Hub::new(TEST_BUDGET);
        let (host_tx, mut host_rx) = mpsc::channel(8);
        let (client_tx, mut client_rx) = mpsc::channel(8);
        let host = hub.join(&claims(TicketRole::Host), host_tx).expect("host");
        assert!(host.peer.is_none());
        let client = hub
            .join(&claims(TicketRole::Client), client_tx)
            .expect("client");
        assert_eq!(client.room_key, host.room_key);
        assert_eq!(client.peer.expect("host online").device_id, "desk-1");

        hub.forward(&host.room_key, host.conn_id, "from-host".to_string())
            .expect("forward");
        assert_eq!(client_rx.recv().await.expect("frame").text, "from-host");
        hub.forward(&client.room_key, client.conn_id, "from-client".to_string())
            .expect("forward");
        assert_eq!(host_rx.recv().await.expect("frame").text, "from-client");

        let offline = hub.leave(&client.room_key, client.conn_id);
        assert_eq!(offline.expect("host remains").device_id, "desk-1");
    }

    #[tokio::test]
    async fn same_role_replaces_old_connection() {
        let hub = Hub::new(TEST_BUDGET);
        let (first_tx, _first_rx) = mpsc::channel(8);
        let (second_tx, _second_rx) = mpsc::channel(8);
        let first = hub
            .join(&claims(TicketRole::Host), first_tx)
            .expect("host1");
        let second = hub
            .join(&claims(TicketRole::Host), second_tx)
            .expect("host2");
        let replaced = second.replaced.expect("old host replaced");
        assert_eq!(replaced.conn_id, first.conn_id);
    }

    #[tokio::test]
    async fn lists_online_devices_per_account() {
        let hub = Hub::new(TEST_BUDGET);
        let (host_tx, _host_rx) = mpsc::channel(8);
        let host = hub.join(&claims(TicketRole::Host), host_tx).expect("host");
        let (client_tx, _client_rx) = mpsc::channel(8);
        let client = hub
            .join(&claims(TicketRole::Client), client_tx)
            .expect("client");
        let (other_tx, _other_rx) = mpsc::channel(8);
        let mut other = claims(TicketRole::Host);
        other.account_id = "acc-2".to_string();
        other.device_id = "desk-2".to_string();
        hub.join(&other, other_tx).expect("other host");

        let devices = hub.online_devices("acc-1");
        assert_eq!(devices.len(), 2);
        assert!(devices
            .iter()
            .any(|d| d.device_id == "desk-1" && d.role == TicketRole::Host));
        assert!(devices
            .iter()
            .any(|d| d.device_id == "mob-1" && d.role == TicketRole::Client));
        assert!(hub
            .online_devices("acc-2")
            .iter()
            .any(|d| d.device_id == "desk-2"));
        assert!(hub.online_devices("acc-3").is_empty());

        hub.leave(&client.room_key, client.conn_id);
        assert_eq!(hub.online_devices("acc-1").len(), 1);
        hub.leave(&host.room_key, host.conn_id);
        assert!(hub.online_devices("acc-1").is_empty());
    }

    #[test]
    fn client_requires_target() {
        let hub = Hub::new(TEST_BUDGET);
        let (tx, _rx) = mpsc::channel(8);
        let mut claims = claims(TicketRole::Client);
        claims.target_device_id = None;
        assert!(matches!(
            hub.join(&claims, tx),
            Err(HubError::MissingTarget)
        ));
    }

    #[tokio::test]
    async fn byte_budget_rejects_and_recovers() {
        let budget = 400;
        let hub = Hub::new(budget);
        let (tx, mut rx) = mpsc::channel(8);
        let frame = "x".repeat(100);
        hub.send(&tx, frame.clone()).expect("first");
        hub.send(&tx, frame.clone()).expect("second");
        assert!(matches!(
            hub.send(&tx, frame.clone()),
            Err(HubError::Backpressure)
        ));
        assert!(hub.budget.used() > 0);

        let queued = rx.recv().await.expect("frame");
        hub.release(queued.bytes);
        hub.send(&tx, frame).expect("after release");
    }
}
