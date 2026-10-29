//! Conex remote relay.
//!
//! - account-scoped short-lived tickets;
//! - host/client room pairing;
//! - blind JSON frame forwarding;
//! - no business storage, no message payload logging.

pub mod account;
pub mod hub;
pub mod server;
pub mod ticket;
