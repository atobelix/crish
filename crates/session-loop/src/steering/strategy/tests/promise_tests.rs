use super::*;

#[test]
fn tool_promise_detector_safe_tail_slice_never_panics_on_chinese() {
    // 构造长度超过 300 字符的大段中文，验证无论长度如何均安全截取不 panic
    let long_chinese = "这是一段很长的中文文本用于测试字符安全切片。".repeat(30);
    assert!(long_chinese.len() > 300);
    let tail = ToolPromiseDetector::safe_tail_slice(&long_chinese, 300);
    assert!(tail.chars().count() <= 300);
    assert!(!tail.is_empty());

    let text_with_promise = format!("{long_chinese}接下来使用 shell_command 运行测试。");
    let detected = ToolPromiseDetector::detect_action_promise(&text_with_promise);
    assert_eq!(
        detected,
        Some("接下来使用 shell_command 运行测试".to_string())
    );
}

#[test]
fn tool_promise_detector_negative_phrases_filtered() {
    let neg1 = "我不会执行任何未经确认的命令，请用户明确指示。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(neg1), None);

    let neg2 = "系统禁止调用外部工具。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(neg2), None);

    let neg3 = "暂不执行该操作。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(neg3), None);

    let neg4 = "当前轮次没有调用工具。";
    assert_eq!(ToolPromiseDetector::detect_action_promise(neg4), None);

    let neg5 = "I will not run this command without permission.";
    assert_eq!(ToolPromiseDetector::detect_action_promise(neg5), None);
}

#[test]
fn tool_promise_detector_english_patterns() {
    let p1 = "I will now run the build command to test changes.";
    assert_eq!(
        ToolPromiseDetector::detect_action_promise(p1),
        Some("I will now run the build command to test changes".to_string())
    );

    let p2 = "Let me execute the test suite now.";
    assert_eq!(
        ToolPromiseDetector::detect_action_promise(p2),
        Some("Let me execute the test suite now".to_string())
    );
}
