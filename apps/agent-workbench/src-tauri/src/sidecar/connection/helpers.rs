use std::sync::Mutex;

use super::disconnect::disconnect_sidecar_generation;
use super::super::types::*;

pub(crate) fn current_sidecar_sender() -> Option<SidecarSender> {
    let connection = sidecar_connection().get().and_then(|conn| {
        conn.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .map(|sidecar| (sidecar.generation, sidecar.writer.clone()))
        })
    });
    match connection {
        Some((generation, writer)) if !writer.is_closed() => {
            Some(SidecarSender { generation, writer })
        }
        Some((generation, _)) => {
            disconnect_sidecar_generation(
                generation,
                "Daemon WebSocket sender was already closed",
                false,
            );
            None
        }
        None => None,
    }
}

pub(crate) fn sidecar_connection_usable(connection: &SidecarConnection) -> bool {
    !connection.writer.is_closed()
}

pub(crate) fn cached_sidecar_sender_or_disconnect(
    stale_message: &str,
) -> Result<Option<SidecarSender>, String> {
    let stale_generation = {
        let conn = sidecar_connection().get_or_init(|| Mutex::new(None));
        let guard = conn.lock().map_err(|e| format!("{e}"))?;
        if let Some(ref sidecar) = *guard {
            if sidecar_connection_usable(sidecar) {
                return Ok(Some(SidecarSender {
                    generation: sidecar.generation,
                    writer: sidecar.writer.clone(),
                }));
            }
            Some(sidecar.generation)
        } else {
            None
        }
    };

    if let Some(generation) = stale_generation {
        disconnect_sidecar_generation(generation, stale_message, false);
    }

    Ok(None)
}
