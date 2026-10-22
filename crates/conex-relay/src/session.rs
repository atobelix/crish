//! 盲中继会话室与有界背压路由器（Session Room & Backpressure Router）
//!
//! 每个房间绑定同一对 (Host, Client)，中继对密文进行盲转发。
//! 信道深度固定为 64，当接收端网络堵塞时，触发有界背压，暂停从发送端 socket 读取。

use crate::protocol::{FrameType, RelayFrame};
use sha2::Digest;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{mpsc, RwLock};
use tracing::{debug, warn};

pub const CHANNEL_BUFFER_CAPACITY: usize = 64;
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Error, Debug)]
pub enum RelayError {
    #[error("Target peer is not connected in this session")]
    PeerNotConnected,
    #[error("Channel has closed")]
    ChannelClosed,
    #[error("Backpressure timeout: peer socket buffer is saturated")]
    BackpressureTimeout,
}

pub struct PeerHandle {
    pub device_id: String,
    pub tx: mpsc::Sender<RelayFrame>,
    pub last_active: Instant,
}

pub struct SessionRoom {
    pub room_id: String, // 格式: "acc_{account_id}_host_{host_device_id}"
    pub session_token: [u8; 16],
    pub host: Option<PeerHandle>,
    pub client: Option<PeerHandle>,
    pub created_at: Instant,
}

impl SessionRoom {
    pub fn new(room_id: String, session_token: [u8; 16]) -> Self {
        Self {
            room_id,
            session_token,
            host: None,
            client: None,
            created_at: Instant::now(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.host.is_none() && self.client.is_none()
    }
}

pub struct SessionRegistry {
    rooms: RwLock<HashMap<String, SessionRoom>>,
    total_forwarded_frames: AtomicU64,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            rooms: RwLock::new(HashMap::new()),
            total_forwarded_frames: AtomicU64::new(0),
        }
    }

    /// 注册或加入房间
    pub async fn join_room(
        &self,
        room_id: &str,
        role: &str,
        device_id: &str,
        tx: mpsc::Sender<RelayFrame>,
    ) -> (mpsc::Receiver<RelayFrame>, [u8; 16]) {
        let mut rooms = self.rooms.write().await;
        let room = rooms.entry(room_id.to_string()).or_insert_with(|| {
            let mut token = [0u8; 16];
            // 简单派生 16 字节会话 token
            let hash = sha2::Sha256::digest(room_id.as_bytes());
            token.copy_from_slice(&hash[..16]);
            SessionRoom::new(room_id.to_string(), token)
        });

        let peer_handle = PeerHandle {
            device_id: device_id.to_string(),
            tx,
            last_active: Instant::now(),
        };

        let session_token = room.session_token;

        if role == "host" {
            room.host = Some(peer_handle);
            debug!("Host joined room: {}", room_id);
            // 若 client 已在，通知 client
            if let Some(client) = &room.client {
                let notice = RelayFrame::new(FrameType::PeerJoined, session_token, Vec::new());
                if let Err(e) = client.tx.try_send(notice) {
                    warn!(
                        "向 client 推送 PeerJoined 失败（可能通道已满/已关闭）: {:?}",
                        e
                    );
                }
            }
        } else {
            room.client = Some(peer_handle);
            debug!("Client joined room: {}", room_id);
            // 若 host 已在，通知 host
            if let Some(host) = &room.host {
                let notice = RelayFrame::new(FrameType::PeerJoined, session_token, Vec::new());
                if let Err(e) = host.tx.try_send(notice) {
                    warn!(
                        "向 host 推送 PeerJoined 失败（可能通道已满/已关闭）: {:?}",
                        e
                    );
                }
            }
        }

        // 创建专属于当前连接的 receiver（通过外层传入的 channel）
        (mpsc::channel(1).1, session_token)
    }

    /// 离开房间并清理空房间
    pub async fn leave_room(&self, room_id: &str, role: &str) {
        let mut rooms = self.rooms.write().await;
        if let Some(room) = rooms.get_mut(room_id) {
            let session_token = room.session_token;
            if role == "host" {
                room.host = None;
                debug!("Host left room: {}", room_id);
                if let Some(client) = &room.client {
                    let notice = RelayFrame::new(FrameType::PeerLeft, session_token, Vec::new());
                    if let Err(e) = client.tx.try_send(notice) {
                        warn!(
                            "向 client 推送 PeerLeft 失败（可能通道已满/已关闭）: {:?}",
                            e
                        );
                    }
                }
            } else {
                room.client = None;
                debug!("Client left room: {}", room_id);
                if let Some(host) = &room.host {
                    let notice = RelayFrame::new(FrameType::PeerLeft, session_token, Vec::new());
                    if let Err(e) = host.tx.try_send(notice) {
                        warn!("向 host 推送 PeerLeft 失败（可能通道已满/已关闭）: {:?}", e);
                    }
                }
            }

            if room.is_empty() {
                rooms.remove(room_id);
                debug!("Room {} is now empty and removed", room_id);
            }
        }
    }

    /// 盲转发数据帧（携带物理背压流控）
    pub async fn forward_frame(
        &self,
        room_id: &str,
        sender_role: &str,
        frame: RelayFrame,
    ) -> Result<(), RelayError> {
        let tx = {
            let rooms = self.rooms.read().await;
            let room = rooms.get(room_id).ok_or(RelayError::PeerNotConnected)?;

            let target_tx = if sender_role == "host" {
                room.client.as_ref().map(|c| c.tx.clone())
            } else {
                room.host.as_ref().map(|h| h.tx.clone())
            };

            target_tx.ok_or(RelayError::PeerNotConnected)?
        };

        // 有界背压发送：如果 channel 堆满 64 帧，超时 500ms 触发背压惩罚
        match tx.send_timeout(frame, Duration::from_millis(500)).await {
            Ok(()) => {
                self.total_forwarded_frames.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            Err(mpsc::error::SendTimeoutError::Closed(_)) => Err(RelayError::ChannelClosed),
            Err(mpsc::error::SendTimeoutError::Timeout(_)) => {
                warn!("Backpressure triggered for room {}: channel full", room_id);
                Err(RelayError::BackpressureTimeout)
            }
        }
    }

    /// 定时 GC 检查超时的僵尸会话
    pub async fn clean_stale_sessions(&self) -> usize {
        let mut rooms = self.rooms.write().await;
        let now = Instant::now();
        let mut empty_rooms = Vec::new();

        for (id, room) in rooms.iter_mut() {
            let host_stale = room
                .host
                .as_ref()
                .is_some_and(|h| now.duration_since(h.last_active) > HEARTBEAT_TIMEOUT);
            let client_stale = room
                .client
                .as_ref()
                .is_some_and(|c| now.duration_since(c.last_active) > HEARTBEAT_TIMEOUT);

            if host_stale {
                room.host = None;
            }
            if client_stale {
                room.client = None;
            }
            if room.is_empty() {
                empty_rooms.push(id.clone());
            }
        }

        let count = empty_rooms.len();
        for id in empty_rooms {
            rooms.remove(&id);
        }
        count
    }

    /// 获取统计快照
    pub async fn stats(&self) -> (usize, u64) {
        let rooms = self.rooms.read().await;
        (
            rooms.len(),
            self.total_forwarded_frames.load(Ordering::Relaxed),
        )
    }
}

impl Default for SessionRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_session_room_forwarding_and_peer_notifications() {
        let registry = SessionRegistry::new();
        let room_id = "test_acc_room_1";

        let (host_tx, mut host_rx) = mpsc::channel(64);
        let (client_tx, _client_rx) = mpsc::channel(64);

        // Host 加入房间
        let (_, host_token) = registry
            .join_room(room_id, "host", "device_pc", host_tx)
            .await;
        assert_eq!(registry.stats().await.0, 1);

        // Client 加入房间 -> Host 应该收到 PeerJoined 通知
        let (_, client_token) = registry
            .join_room(room_id, "client", "device_phone", client_tx)
            .await;
        assert_eq!(host_token, client_token);

        let notice = host_rx
            .recv()
            .await
            .expect("Host should receive PeerJoined");
        assert_eq!(notice.frame_type, FrameType::PeerJoined);

        // Client 盲转发一条加密数据帧给 Host
        let test_payload = b"test-chacha-ciphertext".to_vec();
        let frame = RelayFrame::new(FrameType::RelayData, client_token, test_payload.clone());
        registry
            .forward_frame(room_id, "client", frame)
            .await
            .expect("Forwarding must succeed");

        let received = host_rx
            .recv()
            .await
            .expect("Host should receive forwarded frame");
        assert_eq!(received.frame_type, FrameType::RelayData);
        assert_eq!(received.payload, test_payload);

        // Client 离开房间 -> Host 应该收到 PeerLeft 通知
        registry.leave_room(room_id, "client").await;
        let left_notice = host_rx.recv().await.expect("Host should receive PeerLeft");
        assert_eq!(left_notice.frame_type, FrameType::PeerLeft);

        // Host 也离开 -> 房间应该被清空
        registry.leave_room(room_id, "host").await;
        assert_eq!(registry.stats().await.0, 0);
    }
}
