use conex_types::tool::ProviderDiagnosticPhase;
use tokio::sync::mpsc;

use super::{collect, data_of, ChannelReader};
use crate::sse::frame::{SseFrameError, SseParser};
use crate::sse::reader::{
    read_sse, AbortFlag, SseReadError, StreamDiagnosticContext, StreamReadOptions,
};

#[tokio::test]
async fn reads_frames_across_chunks_with_utf8_split() {
    // "data: {\"msg\":\"中\"}\n\n" 拆成 4 块（含 中 的三字节跨块）
    let input = vec![
        b"data: {\"msg\":\"".to_vec(),
        vec![0xE4, 0xB8],
        vec![0xAD],
        b"\"}\n\n".to_vec(),
    ];
    let output = collect(input).await;
    assert_eq!(output.frames.len(), 1);
    assert_eq!(data_of(&output.frames, 0), "{\"msg\":\"中\"}");
    assert_eq!(output.chunks, 4);
    assert!(output.bytes > 0);
}

#[tokio::test]
async fn emits_first_byte_and_stream_end_diagnostics() {
    let (tx, rx) = mpsc::unbounded_channel();
    tx.send(b"data: {\"a\":1}\n\n".to_vec()).unwrap();
    drop(tx);
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions {
        diagnostics: Some(StreamDiagnosticContext {
            provider_id: Some("test-provider".into()),
            url: Some("http://example.test/stream".into()),
            attempt: Some(1),
            max_attempts: Some(3),
            ..StreamDiagnosticContext::default()
        }),
        ..StreamReadOptions::default()
    };
    let output = read_sse(&mut reader, &mut parser, &options, &mut abort)
        .await
        .unwrap();

    assert_eq!(output.diagnostics.len(), 2);
    assert_eq!(
        output.diagnostics[0].phase,
        ProviderDiagnosticPhase::SseFirstByte
    );
    assert_eq!(
        output.diagnostics[0].provider_id.as_deref(),
        Some("test-provider")
    );
    assert_eq!(
        output.diagnostics[0].url.as_deref(),
        Some("http://example.test/stream")
    );
    assert_eq!(output.diagnostics[0].attempt, Some(1));
    assert_eq!(output.diagnostics[0].max_attempts, Some(3));
    assert_eq!(output.diagnostics[0].chunks, Some(1));
    assert!(output.diagnostics[0].elapsed_ms.is_some());
    assert_eq!(
        output.diagnostics[1].phase,
        ProviderDiagnosticPhase::StreamEnd
    );
}

#[tokio::test]
async fn no_diagnostics_when_disabled() {
    let output = collect(vec![b"data: {\"a\":1}\n\n".to_vec()]).await;
    assert!(output.diagnostics.is_empty());
}

#[tokio::test]
async fn done_sentinel_terminates_and_drops_rest() {
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tx.send(b"data: {\"a\":1}\n\ndata: [DONE]\n\ndata: {\"b\":2}\n\n".to_vec())
        .unwrap();
    drop(tx);
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    let options = StreamReadOptions {
        diagnostics: Some(StreamDiagnosticContext::default()),
        ..StreamReadOptions::default()
    };
    let output = read_sse(&mut reader, &mut parser, &options, &mut abort)
        .await
        .unwrap();
    assert_eq!(
        output.frames.len(),
        1,
        "[DONE] 哨兵帧不产出，其后的帧被丢弃"
    );
    assert_eq!(data_of(&output.frames, 0), "{\"a\":1}");
    assert!(parser.is_done());
    assert_eq!(
        output.diagnostics.len(),
        2,
        "[DONE] 路径同样产出 stream-end 诊断"
    );
}

#[tokio::test]
async fn trailing_frame_without_separator_parsed_at_eof() {
    let output = collect(vec![b"data: {\"a\":1}".to_vec()]).await;
    assert_eq!(output.frames.len(), 1);
    assert_eq!(data_of(&output.frames, 0), "{\"a\":1}");
}

#[tokio::test]
async fn malformed_json_frame_raises_frame_error() {
    let (tx, rx) = mpsc::unbounded_channel::<Vec<u8>>();
    tx.send(b"data: {bad\n\n".to_vec()).unwrap();
    drop(tx);
    let mut reader = ChannelReader { rx };
    let mut parser = SseParser::new();
    let (_flag, mut abort) = AbortFlag::new();
    let error = read_sse(
        &mut reader,
        &mut parser,
        &StreamReadOptions::default(),
        &mut abort,
    )
    .await
    .unwrap_err();
    assert!(matches!(
        error,
        SseReadError::Frame(SseFrameError::MalformedSseFrame { .. })
    ));
}

#[tokio::test]
async fn keepalive_stream_does_not_break() {
    let output = collect(vec![b": ping\n\ndata: {\"a\":1}\n\n: pong\n\n".to_vec()]).await;
    assert_eq!(output.frames.len(), 1, "keep-alive 注释不炸流");
    assert_eq!(data_of(&output.frames, 0), "{\"a\":1}");
}
