//! Conex 盲中继协议帧定义（E2EE 零知识中继信封）
//!
//! 报文结构：
//! [Magic: 2B (0x4358 "CX")]
//! [Version: 1B (0x01)]
//! [FrameType: 1B]
//! [SessionId: 16B]
//! [PayloadLen: 4B (大端整数)]
//! [Payload: N 字节 (密文或控制指令)]

use anyhow::{anyhow, bail, Result};
use std::convert::TryInto;

pub const MAGIC_BYTES: [u8; 2] = [0x43, 0x58]; // "CX"
pub const PROTOCOL_VERSION: u8 = 1;
pub const HEADER_LEN: usize = 2 + 1 + 1 + 16 + 4; // 24 字节

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameType {
    /// 握手或绑定 (携带公钥或身份)
    Handshake = 0x01,
    /// 端到端密文载荷盲转发
    RelayData = 0x02,
    /// 应用层心跳 PING
    Ping = 0x03,
    /// 应用层心跳 PONG
    Pong = 0x04,
    /// 对端上线通知
    PeerJoined = 0x05,
    /// 对端下线通知
    PeerLeft = 0x06,
    /// 错误通知
    Error = 0xFF,
}

impl FrameType {
    pub fn from_u8(b: u8) -> Option<Self> {
        match b {
            0x01 => Some(FrameType::Handshake),
            0x02 => Some(FrameType::RelayData),
            0x03 => Some(FrameType::Ping),
            0x04 => Some(FrameType::Pong),
            0x05 => Some(FrameType::PeerJoined),
            0x06 => Some(FrameType::PeerLeft),
            0xFF => Some(FrameType::Error),
            _ => None,
        }
    }
}

/// 中继协议帧
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayFrame {
    pub frame_type: FrameType,
    pub session_id: [u8; 16],
    pub payload: Vec<u8>,
}

impl RelayFrame {
    pub fn new(frame_type: FrameType, session_id: [u8; 16], payload: Vec<u8>) -> Self {
        Self {
            frame_type,
            session_id,
            payload,
        }
    }

    /// 编码为二进制中继封包
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(HEADER_LEN + self.payload.len());
        buf.extend_from_slice(&MAGIC_BYTES);
        buf.push(PROTOCOL_VERSION);
        buf.push(self.frame_type as u8);
        buf.extend_from_slice(&self.session_id);
        let len = self.payload.len() as u32;
        buf.extend_from_slice(&len.to_be_bytes());
        buf.extend_from_slice(&self.payload);
        buf
    }

    /// 从二进制字节数组解析中继封包
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_LEN {
            bail!("Frame too short: {} bytes < {}", bytes.len(), HEADER_LEN);
        }

        if bytes[0..2] != MAGIC_BYTES {
            bail!("Invalid magic bytes: {:?}", &bytes[0..2]);
        }

        let version = bytes[2];
        if version != PROTOCOL_VERSION {
            bail!("Unsupported protocol version: {}", version);
        }

        let frame_type_byte = bytes[3];
        let frame_type = FrameType::from_u8(frame_type_byte)
            .ok_or_else(|| anyhow!("Unknown frame type: 0x{:02x}", frame_type_byte))?;

        let session_id: [u8; 16] = bytes[4..20]
            .try_into()
            .map_err(|_| anyhow!("Failed to slice session_id"))?;

        let payload_len = u32::from_be_bytes(
            bytes[20..24]
                .try_into()
                .map_err(|_| anyhow!("Failed to slice payload_len"))?,
        ) as usize;

        if bytes.len() < HEADER_LEN + payload_len {
            bail!(
                "Payload incomplete: expected {}, got {}",
                payload_len,
                bytes.len() - HEADER_LEN
            );
        }

        let payload = bytes[HEADER_LEN..HEADER_LEN + payload_len].to_vec();

        Ok(Self {
            frame_type,
            session_id,
            payload,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        let session_id = [7u8; 16];
        let payload = b"encrypted-secret-payload-test".to_vec();
        let frame = RelayFrame::new(FrameType::RelayData, session_id, payload.clone());

        let encoded = frame.encode();
        assert_eq!(encoded.len(), HEADER_LEN + payload.len());

        let decoded = RelayFrame::decode(&encoded).expect("Decode should succeed");
        assert_eq!(decoded.frame_type, FrameType::RelayData);
        assert_eq!(decoded.session_id, session_id);
        assert_eq!(decoded.payload, payload);
    }
}
