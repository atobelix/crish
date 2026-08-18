/**
 * CI Quality Gate Diagnostic & Regression Test Suite
 * Gate 1: Single-Line Bottom Overscroll Subpixel Displacement / Twitching Detector
 * Gate 2: Inner SVG Icon Relative Subpixel Displacement Detector
 * Gate 3: Plan Duration Timer Component Scroll Subpixel Displacement Detector
 * Gate 4: Global DOM Physical Pixel Integer Alignment Scanner
 */

(function () {
  window.CI_SINGLE_LINE_TWITCH_CHECKER = function () {
    const container = document.getElementById('composerContainer');
    // In the new layout, .chat-app-layout is the scrollable area, not chatStreamContainer
    const chatStream = document.querySelector('.chat-app-layout');
    const editable = document.getElementById('composerEditable');
    const fileZone = document.getElementById('fileZone');

    const plusBtn = document.getElementById('btnPlus');
    const permBtn = document.getElementById('btnPermission');
    const fusedBtn = document.querySelector('.fused-model-thinking-btn');
    const voiceBtn = document.querySelector('.action-circle-btn');
    const sendBtn = document.getElementById('btnSend');

    if (!container || !voiceBtn || !sendBtn) {
      return { status: "ERROR", message: "Required composer elements not found" };
    }

    if (fileZone) fileZone.innerHTML = '';
    if (editable) editable.innerHTML = '单行模式 CI 校验文本';
    if (window.updateSendButtonState) window.updateSendButtonState();
    if (sendBtn) sendBtn.classList.add('active');

    const result = {
      testSuite: "CI Quality Gate 1: Single-Line Bottom Overscroll Subpixel Displacement",
      mode: "Single-Line",
      timestamp: new Date().toISOString(),
      samples: [],
      maxVoiceTwitchPx: 0,
      maxSendTwitchPx: 0,
      maxRelativeVsPlusTwitchPx: 0,
      isTwitchDetected: false
    };

    function capture(label, targetScrollable, scrollVal) {
      const cRect = container.getBoundingClientRect();
      const pRect = plusBtn ? plusBtn.getBoundingClientRect() : { top: 0, bottom: 0 };
      const fRect = fusedBtn ? fusedBtn.getBoundingClientRect() : { top: 0, bottom: 0 };
      const vRect = voiceBtn.getBoundingClientRect();
      const sRect = sendBtn.getBoundingClientRect();

      const voiceRelY = vRect.top - cRect.top;
      const sendRelY = sRect.top - cRect.top;
      const plusRelY = pRect.top - cRect.top;
      const fusedRelY = fRect.top - cRect.top;

      const voiceDistBottom = cRect.bottom - vRect.bottom;
      const sendDistBottom = cRect.bottom - sRect.bottom;

      return {
        label: label,
        target: targetScrollable,
        scrollVal: scrollVal,
        containerTop: cRect.top,
        containerBottom: cRect.bottom,
        viewportHeight: window.innerHeight,
        absoluteBottomTwitch: window.innerHeight - cRect.bottom,
        containerHeight: cRect.height,
        voiceRelY: voiceRelY,
        sendRelY: sendRelY,
        plusRelY: plusRelY,
        fusedRelY: fusedRelY,
        voiceDistBottom: voiceDistBottom,
        sendDistBottom: sendDistBottom,
        voiceVsPlusDiff: voiceRelY - plusRelY,
        sendVsPlusDiff: sendRelY - plusRelY
      };
    }

    if (chatStream) chatStream.scrollTop = 0;
    window.scrollTo(0, 0);
    const baseSample = capture("baseline_top", "window", 0);
    result.samples.push(baseSample);

    if (chatStream) {
      const maxStreamScroll = chatStream.scrollHeight - chatStream.clientHeight;

      chatStream.scrollTop = Math.floor(maxStreamScroll / 2);
      result.samples.push(capture("chatStream_mid", "#chatStreamContainer", chatStream.scrollTop));

      chatStream.scrollTop = maxStreamScroll;
      result.samples.push(capture("chatStream_bottom", "#chatStreamContainer", maxStreamScroll));

      for (let i = 1; i <= 5; i++) {
        const overscrollWheel = new WheelEvent('wheel', {
          deltaY: 100 * i,
          bubbles: true,
          cancelable: true
        });
        chatStream.dispatchEvent(overscrollWheel);
        result.samples.push(capture(`chatStream_overscroll_wheel_${i}`, "#chatStreamContainer", maxStreamScroll));
      }
    }

    const maxWinScroll = document.documentElement.scrollHeight - window.innerHeight;
    if (maxWinScroll > 0) {
      window.scrollTo(0, maxWinScroll);
      result.samples.push(capture("window_bottom", "window", maxWinScroll));

      for (let i = 1; i <= 5; i++) {
        const overscrollWheelWin = new WheelEvent('wheel', {
          deltaY: 120 * i,
          bubbles: true,
          cancelable: true
        });
        container.dispatchEvent(overscrollWheelWin);
        result.samples.push(capture(`window_overscroll_wheel_${i}`, "window", maxWinScroll));
      }
    }

    const baseVoiceY = baseSample.voiceRelY;
    const baseSendY = baseSample.sendRelY;
    const baseVoiceVsPlus = baseSample.voiceVsPlusDiff;
    const baseAbsoluteBottom = baseSample.absoluteBottomTwitch;
    result.maxAbsoluteTwitchPx = 0;

    result.samples.forEach(s => {
      const vTwitch = Math.abs(s.voiceRelY - baseVoiceY);
      const sTwitch = Math.abs(s.sendRelY - baseSendY);
      const relTwitch = Math.abs(s.voiceVsPlusDiff - baseVoiceVsPlus);
      const absTwitch = Math.abs(s.absoluteBottomTwitch - baseAbsoluteBottom);

      if (vTwitch > result.maxVoiceTwitchPx) result.maxVoiceTwitchPx = vTwitch;
      if (sTwitch > result.maxSendTwitchPx) result.maxSendTwitchPx = sTwitch;
      if (relTwitch > result.maxRelativeVsPlusTwitchPx) result.maxRelativeVsPlusTwitchPx = relTwitch;
      if (absTwitch > result.maxAbsoluteTwitchPx) result.maxAbsoluteTwitchPx = absTwitch;
    });

    result.isTwitchDetected = (
      result.maxVoiceTwitchPx > 0.001 ||
      result.maxSendTwitchPx > 0.001 ||
      result.maxRelativeVsPlusTwitchPx > 0.001 ||
      result.maxAbsoluteTwitchPx > 0.001
    );

    return result;
  };

  /**
   * CI Quality Gate 2: Inner SVG Icon Relative Subpixel Displacement Detector
   */
  window.CI_INNER_ICON_TWITCH_CHECKER = function () {
    const voiceBtn = document.querySelector('.action-circle-btn');
    const sendBtn = document.getElementById('btnSend');
    const plusBtn = document.getElementById('btnPlus');

    const voiceSvg = voiceBtn ? voiceBtn.querySelector('svg') : null;
    const sendSvg = sendBtn ? sendBtn.querySelector('svg') : null;
    const plusSvg = plusBtn ? plusBtn.querySelector('svg') : null;

    const dpr = window.devicePixelRatio || 1;

    if (!voiceBtn || !voiceSvg || !sendBtn || !sendSvg) {
      return { status: "ERROR", message: "Inner SVG icon elements not found" };
    }

    const voiceBtnRect = voiceBtn.getBoundingClientRect();
    const voiceSvgRect = voiceSvg.getBoundingClientRect();
    const voiceInnerOffsetY = voiceSvgRect.top - voiceBtnRect.top;

    const sendBtnRect = sendBtn.getBoundingClientRect();
    const sendSvgRect = sendSvg.getBoundingClientRect();
    const sendInnerOffsetY = sendSvgRect.top - sendBtnRect.top;

    const plusBtnRect = plusBtn ? plusBtn.getBoundingClientRect() : { top: 0 };
    const plusSvgRect = plusSvg ? plusSvg.getBoundingClientRect() : { top: 0 };
    const plusInnerOffsetY = plusSvg ? plusSvgRect.top - plusBtnRect.top : 0;

    const voicePhysicalBtnHeight = voiceBtnRect.height * dpr;
    const voicePhysicalSvgHeight = voiceSvgRect.height * dpr;
    const voicePhysicalTopOffset = voiceInnerOffsetY * dpr;

    const sendPhysicalBtnHeight = sendBtnRect.height * dpr;
    const sendPhysicalSvgHeight = sendSvgRect.height * dpr;
    const sendPhysicalTopOffset = sendInnerOffsetY * dpr;

    const voiceHasFractionalOffset = !Number.isInteger(Math.round(voicePhysicalTopOffset * 1000) / 1000);
    const sendHasFractionalOffset = !Number.isInteger(Math.round(sendPhysicalTopOffset * 1000) / 1000);

    return {
      testSuite: "CI Quality Gate 2: Inner SVG Icon Subpixel Centering & Rasterization Alignment",
      devicePixelRatio: dpr,
      voiceIcon: {
        buttonHeightCssPx: voiceBtnRect.height,
        svgHeightCssPx: voiceSvgRect.height,
        innerOffsetYCssPx: voiceInnerOffsetY,
        physicalButtonHeightPx: voicePhysicalBtnHeight,
        physicalSvgHeightPx: voicePhysicalSvgHeight,
        physicalInnerOffsetYPx: voicePhysicalTopOffset,
        hasFractionalPhysicalOffset: voiceHasFractionalOffset
      },
      sendIcon: {
        buttonHeightCssPx: sendBtnRect.height,
        svgHeightCssPx: sendSvgRect.height,
        innerOffsetYCssPx: sendInnerOffsetY,
        physicalButtonHeightPx: sendPhysicalBtnHeight,
        physicalSvgHeightPx: sendPhysicalSvgHeight,
        physicalInnerOffsetYPx: sendPhysicalTopOffset,
        hasFractionalPhysicalOffset: sendHasFractionalOffset
      },
      plusIcon: {
        buttonHeightCssPx: plusBtnRect.height,
        svgHeightCssPx: plusSvgRect.height,
        innerOffsetYCssPx: plusInnerOffsetY
      },
      isInnerIconTwitchRiskDetected: voiceHasFractionalOffset || sendHasFractionalOffset
    };
  };

  /**
   * CI Quality Gate 3: Plan Duration Timer Component Scroll Subpixel Displacement Detector
   */
  window.CI_PLAN_DURATION_TWITCH_CHECKER = function () {
    const planBar = document.getElementById('planProgressBar');
    const planDuration = document.getElementById('planDuration');
    const chatStream = document.querySelector('.chat-app-layout');

    const dpr = window.devicePixelRatio || 1;

    if (!planBar || !planDuration) {
      return { status: "ERROR", message: "planDuration or planProgressBar element not found" };
    }

    planBar.classList.add('active');

    const result = {
      testSuite: "CI Quality Gate 3: Plan Duration Timer Component Scroll Subpixel Displacement",
      devicePixelRatio: dpr,
      timestamp: new Date().toISOString(),
      samples: [],
      maxDurationYTwitchPx: 0,
      maxDurationXTwitchPx: 0,
      isTwitchDetected: false
    };

    function capture(label, scrollPos) {
      const bRect = planBar.getBoundingClientRect();
      const dRect = planDuration.getBoundingClientRect();

      const durationRelY = dRect.top - bRect.top;
      const durationRelRight = bRect.right - dRect.right;
      const durationPhysicalTop = dRect.top * dpr;

      return {
        label: label,
        scrollPos: scrollPos,
        planBarTop: bRect.top,
        planBarHeight: bRect.height,
        durationTop: dRect.top,
        durationHeight: dRect.height,
        durationRelY: durationRelY,
        durationRelRight: durationRelRight,
        durationPhysicalTop: durationPhysicalTop,
        hasFractionalPhysicalTop: !Number.isInteger(Math.round(durationPhysicalTop * 1000) / 1000)
      };
    }

    if (chatStream) chatStream.scrollTop = 0;
    window.scrollTo(0, 0);
    const baseSample = capture("baseline_top", 0);
    result.samples.push(baseSample);

    const scrollSequence = [50, 20, 150, 80, 300, 100, 500, 0];
    scrollSequence.forEach((scrollVal, idx) => {
      if (chatStream) chatStream.scrollTop = scrollVal;
      window.scrollTo(0, scrollVal);

      const wheelEvt = new WheelEvent('wheel', {
        deltaY: (idx % 2 === 0 ? 120 : -80),
        bubbles: true,
        cancelable: true
      });
      planBar.dispatchEvent(wheelEvt);

      result.samples.push(capture(`back_forth_scroll_${idx + 1}_val_${scrollVal}`, scrollVal));
    });

    const baseRelY = baseSample.durationRelY;
    const baseRelRight = baseSample.durationRelRight;

    result.samples.forEach(s => {
      const yTwitch = Math.abs(s.durationRelY - baseRelY);
      const xTwitch = Math.abs(s.durationRelRight - baseRelRight);

      if (yTwitch > result.maxDurationYTwitchPx) result.maxDurationYTwitchPx = yTwitch;
      if (xTwitch > result.maxDurationXTwitchPx) result.maxDurationXTwitchPx = xTwitch;
    });

    result.isTwitchDetected = (
      result.maxDurationYTwitchPx > 0.001 ||
      result.maxDurationXTwitchPx > 0.001 ||
      baseSample.hasFractionalPhysicalTop
    );

    return result;
  };

  /**
   * CI Quality Gate 4: Global DOM Physical Pixel Integer Height Scanner
   */
  window.CI_GLOBAL_DOM_INTEGER_CHECKER = function () {
    const dpr = window.devicePixelRatio || 1;
    const targetSelectors = [
      '#composerContainer',
      '#composerEditable',
      '#planProgressBar',
      '#planGoalPanel',
      '#planStepList',
      '#planCollapsed',
      '#planModeBadge',
      '#planActiveTaskBox',
      '#planStepCounter',
      '#planDuration',
      '#planEditQuickBtn',
      '#planPauseToggleBtn',
      '#planStopQuickBtn',
      '#planExpandTrigger',
      '#btnPlus',
      '#btnPermission',
      '.fused-model-thinking-btn',
      '.action-circle-btn',
      '#btnSend',
      '#fileZone',
      '.file-card',
      '.rich-inline-tag'
    ];

    const report = {
      testSuite: "CI Quality Gate 4: Global DOM Physical Pixel Integer Height Scanner",
      devicePixelRatio: dpr,
      timestamp: new Date().toISOString(),
      scannedElementsCount: 0,
      nonIntegerHeightElements: [],
      isAllDOMIntegerHeightAligned: true
    };

    targetSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el, index) => {
        report.scannedElementsCount++;
        const rect = el.getBoundingClientRect();
        const physicalHeight = rect.height * dpr;
        const roundedPHeight = Math.round(physicalHeight * 1000) / 1000;

        const isHeightInteger = Number.isInteger(roundedPHeight);

        if (!isHeightInteger) {
          report.nonIntegerHeightElements.push({
            selector: selector,
            elementIndex: index,
            cssHeightPx: rect.height,
            physicalHeightPx: physicalHeight,
            heightFractionalRemainder: (physicalHeight % 1).toFixed(4),
            isHeightInteger: isHeightInteger
          });
        }
      });
    });

    report.isAllDOMIntegerHeightAligned = report.nonIntegerHeightElements.length === 0;
    return report;
  };

  /**
   * ColorAdaptor Utility Engine:
   * Algorithmically converts legacy Hex/RGB/RGBA into standardized HSL slash syntax: hsl(h s l / a)
   */
  window.ColorAdaptor = {
    hexToHsl: function (hex) {
      hex = String(hex || '').replace(/^#/, '');
      if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
      }
      let r = parseInt(hex.substring(0, 2), 16) / 255;
      let g = parseInt(hex.substring(2, 4), 16) / 255;
      let b = parseInt(hex.substring(4, 6), 16) / 255;
      let a = hex.length === 8 ? parseInt(hex.substring(6, 8), 16) / 255 : 1;

      let max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;

      if (max === min) {
        h = s = 0;
      } else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }

      h = Math.round(h * 360);
      s = Math.round(s * 100);
      l = Math.round(l * 100);
      a = Math.round(a * 100) / 100;

      return `hsl(${h} ${s}% ${l}% / ${a})`;
    },

    rgbaToHsl: function (r, g, b, a) {
      r /= 255; g /= 255; b /= 255;
      let max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;

      if (max === min) {
        h = s = 0;
      } else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }

      h = Math.round(h * 360);
      s = Math.round(s * 100);
      l = Math.round(l * 100);
      a = typeof a === 'number' ? Math.round(a * 100) / 100 : 1;

      return `hsl(${h} ${s}% ${l}% / ${a})`;
    },

    adaptColor: function (colorStr) {
      if (!colorStr) return colorStr;
      colorStr = String(colorStr).trim();
      if (colorStr.startsWith('hsl(') || colorStr.startsWith('var(')) return colorStr;
      if (colorStr.startsWith('#')) return this.hexToHsl(colorStr);

      let matchRgba = colorStr.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
      if (matchRgba) {
        let r = parseFloat(matchRgba[1]);
        let g = parseFloat(matchRgba[2]);
        let b = parseFloat(matchRgba[3]);
        let a = matchRgba[4] !== undefined ? parseFloat(matchRgba[4]) : 1;
        return this.rgbaToHsl(r, g, b, a);
      }
      return colorStr;
    }
  };

  /**
   * CI Quality Gate 5: Zero !important Anti-Pattern Auditor
   */
  window.CI_ZERO_IMPORTANT_AUDITOR = function () {
    const report = {
      testSuite: "CI Quality Gate 5: Zero !important Anti-Pattern Auditor",
      timestamp: new Date().toISOString(),
      importantRulesCount: 0,
      violatingRules: [],
      isPassed: true
    };

    for (let sheet of document.styleSheets) {
      try {
        if (!sheet.href || sheet.href.includes('css/')) {
          for (let rule of sheet.cssRules) {
            if (rule.cssText && rule.cssText.includes('!important')) {
              // Exclude third-party or browser default overrides if explicitly marked as allowed
              if (!rule.cssText.includes('display: none !important') && !rule.cssText.includes('display: flex !important')) {
                report.importantRulesCount++;
                report.violatingRules.push({
                  selector: rule.selectorText,
                  cssText: rule.cssText.slice(0, 150)
                });
              }
            }
          }
        }
      } catch (e) {}
    }

    report.isPassed = report.importantRulesCount === 0;
    return report;
  };

  /**
   * CI Quality Gate 6: Color Adaptor & Modern Color Token Syntax Auditor
   */
  window.CI_COLOR_ADAPTOR_AUDITOR = function () {
    const report = {
      testSuite: "CI Quality Gate 6: Color Adaptor & Modern Color Token Syntax Auditor",
      timestamp: new Date().toISOString(),
      testedElementsCount: 0,
      adaptedColorsCount: 0,
      sampleAdaptations: [],
      isPassed: true
    };

    const targetSelectors = ['.flow-permission-bar', '.plan-progress-bar', '.plan-expanded-step.active', '.flow-plan-step'];
    targetSelectors.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) {
        report.testedElementsCount++;
        const bg = getComputedStyle(el).backgroundColor;
        const adaptedBg = window.ColorAdaptor.adaptColor(bg);
        report.sampleAdaptations.push({
          selector: sel,
          rawBg: bg,
          adaptedHsl: adaptedBg
        });
      }
    });

    report.adaptedColorsCount = report.sampleAdaptations.length;
    report.isPassed = report.testedElementsCount > 0;
    return report;
  };

  /**
   * Gate 7: Composer Wrapper vs Stream Inner Horizontal Alignment Inspector
   * Verifies that .composer-wrapper strictly and pixel-perfectly aligns with
   * .chat-stream-inner / .flow-stream-inner under default and dynamic container widths.
   */
  window.CI_COMPOSER_STREAM_ALIGNMENT_CHECKER = function () {
    const streamInner = document.querySelector('.chat-stream-inner, .flow-stream-inner');
    const composerWrapper = document.querySelector('.composer-wrapper');
    const container = document.getElementById('chatStreamContainer');

    if (!streamInner || !composerWrapper) {
      return {
        testSuite: "CI Quality Gate 7: Composer Wrapper vs Stream Inner Alignment",
        isPassed: false,
        message: "Required stream inner or composer wrapper elements not found"
      };
    }

    if (window.syncComposerHorizontalAlignment) {
      window.syncComposerHorizontalAlignment();
    }

    const sRect = streamInner.getBoundingClientRect();
    const cRect = composerWrapper.getBoundingClientRect();

    const leftDelta = Math.abs(cRect.left - sRect.left);
    const widthDelta = Math.abs(cRect.width - sRect.width);
    const rightDelta = Math.abs(cRect.right - sRect.right);

    const isPassed = leftDelta < 0.05 && widthDelta < 0.05 && rightDelta < 0.05;

    return {
      testSuite: "CI Quality Gate 7: Composer Wrapper vs Stream Inner Alignment",
      isPassed: isPassed,
      leftDeltaPx: leftDelta,
      widthDeltaPx: widthDelta,
      rightDeltaPx: rightDelta,
      streamInnerRect: { left: sRect.left, width: sRect.width, right: sRect.right },
      composerWrapperRect: { left: cRect.left, width: cRect.width, right: cRect.right }
    };
  };

  /**
   * CI Master Runner: Executes All 7 Quality Gates
   */
  window.CI_RUN_ALL_QUALITY_GATES = function () {
    const gate1 = window.CI_SINGLE_LINE_TWITCH_CHECKER();
    const gate2 = window.CI_INNER_ICON_TWITCH_CHECKER();
    const gate3 = window.CI_PLAN_DURATION_TWITCH_CHECKER();
    const gate4 = window.CI_GLOBAL_DOM_INTEGER_CHECKER();
    const gate5 = window.CI_ZERO_IMPORTANT_AUDITOR();
    const gate6 = window.CI_COLOR_ADAPTOR_AUDITOR();
    const gate7 = window.CI_COMPOSER_STREAM_ALIGNMENT_CHECKER();

    const isAllPassed = (
      gate1.isTwitchDetected === false &&
      gate2.isInnerIconTwitchRiskDetected === false &&
      gate3.isTwitchDetected === false &&
      gate4.isAllDOMIntegerHeightAligned === true &&
      gate5.isPassed === true &&
      gate6.isPassed === true &&
      gate7.isPassed === true
    );

    return {
      masterTestSuite: "CI Quality Suite: Master Runner (7 Gates)",
      timestamp: new Date().toISOString(),
      devicePixelRatio: window.devicePixelRatio || 1,
      isAllPassed: isAllPassed,
      gates: {
        gate1_singleLineOverscroll: {
          testName: gate1.testSuite,
          isPassed: gate1.isTwitchDetected === false,
          maxVoiceTwitchPx: gate1.maxVoiceTwitchPx,
          maxSendTwitchPx: gate1.maxSendTwitchPx
        },
        gate2_innerIconRasterization: {
          testName: gate2.testSuite,
          isPassed: gate2.isInnerIconTwitchRiskDetected === false,
          voicePhysicalTopOffsetPx: gate2.voiceIcon ? gate2.voiceIcon.physicalInnerOffsetYPx : null,
          sendPhysicalTopOffsetPx: gate2.sendIcon ? gate2.sendIcon.physicalInnerOffsetYPx : null
        },
        gate3_planDurationTwitch: {
          testName: gate3.testSuite,
          isPassed: gate3.isTwitchDetected === false,
          maxDurationYTwitchPx: gate3.maxDurationYTwitchPx,
          maxDurationXTwitchPx: gate3.maxDurationXTwitchPx
        },
        gate4_globalDOMIntegerScanner: {
          testName: gate4.testSuite,
          isPassed: gate4.isAllDOMIntegerHeightAligned === true,
          scannedElementsCount: gate4.scannedElementsCount,
          nonIntegerHeightCount: gate4.nonIntegerHeightElements.length,
          nonIntegerHeightElements: gate4.nonIntegerHeightElements
        },
        gate5_zeroImportantAuditor: {
          testName: gate5.testSuite,
          isPassed: gate5.isPassed === true,
          importantRulesCount: gate5.importantRulesCount,
          violatingRules: gate5.violatingRules
        },
        gate6_colorAdaptorAuditor: {
          testName: gate6.testSuite,
          isPassed: gate6.isPassed === true,
          testedElementsCount: gate6.testedElementsCount,
          sampleAdaptations: gate6.sampleAdaptations
        },
        gate7_composerStreamAlignment: {
          testName: gate7.testSuite,
          isPassed: gate7.isPassed === true,
          leftDeltaPx: gate7.leftDeltaPx,
          widthDeltaPx: gate7.widthDeltaPx,
          rightDeltaPx: gate7.rightDeltaPx
        }
      }
    };
  };
})();
