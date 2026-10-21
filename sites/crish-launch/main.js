(function () {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  if (!location.hash) window.scrollTo(0, 0);

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce) document.documentElement.classList.add("motion");

  var tour = document.querySelector("[data-pin]");
  var stage = document.querySelector("[data-stage]");
  var desk = document.querySelector("[data-desk]");
  var panes = document.querySelector("[data-panes]");
  var list = document.querySelector("[data-list]");
  var planes = Array.prototype.slice.call(document.querySelectorAll("[data-plane]"));
  var lines = tour ? Array.prototype.slice.call(tour.querySelectorAll("[data-line]")) : [];
  var menu = document.querySelector("[data-menu]");
  var captions = tour ? Array.prototype.slice.call(tour.querySelectorAll(".slides article")) : [];
  var scrub = document.querySelector("[data-scrub]");
  var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-links a"));
  var sections = navLinks
    .map(function (link) {
      return document.querySelector(link.getAttribute("href"));
    })
    .filter(Boolean);
  var copyBtn = document.querySelector("[data-copy]");
  var code = document.querySelector("[data-code]");
  var surface = document.querySelector("[data-surface]");
  var surfaceSlides = surface ? Array.prototype.slice.call(surface.querySelectorAll(".surface-slides article")) : [];
  var passStage = surface ? surface.querySelector("[data-pass-stage]") : null;
  var passRig = surface ? surface.querySelector("[data-pass-rig]") : null;
  var passPlates = passRig ? passRig.querySelectorAll(".plate") : [];
  var surfaceScrub = document.querySelector("[data-surface-scrub]");
  var reveals = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));

  /* 整扇窗口在空间里转。审批和终端两帧转得轻一些，字还能读。 */
  var keys = [
    { p: 0, rx: 8, ry: -20, x: 16, y: 6, z: -36, s: 0.9 },
    { p: 0.22, rx: 6, ry: -10, x: 36, y: 8, z: -8, s: 0.94 },
    { p: 0.46, rx: 5, ry: 14, x: -28, y: 8, z: -8, s: 0.94 },
    { p: 0.66, rx: 7, ry: 6, x: 0, y: 2, z: -14, s: 0.94 },
    { p: 0.86, rx: 5, ry: 16, x: -18, y: 4, z: -18, s: 0.92 },
    { p: 1, rx: 10, ry: -16, x: 0, y: 8, z: -56, s: 0.86 }
  ];

  function clamp(n, a, b) {
    return Math.min(b, Math.max(a, n));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smooth(t) {
    return t * t * (3 - 2 * t);
  }

  function sample(p) {
    var i = 0;
    while (i < keys.length - 2 && p > keys[i + 1].p) i += 1;
    var a = keys[i];
    var b = keys[i + 1];
    var t = smooth((p - a.p) / (b.p - a.p || 1));
    return {
      rx: lerp(a.rx, b.rx, t),
      ry: lerp(a.ry, b.ry, t),
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      s: lerp(a.s, b.s, t)
    };
  }

  function band(x, a, b, c, d) {
    var inn = clamp((x - a) / (b - a || 1), 0, 1);
    var out = 1 - clamp((x - c) / (d - c || 1), 0, 1);
    var t = Math.min(inn, out);
    return t * t * (3 - 2 * t);
  }

  function captionOpacity(k, x, n) {
    var i = Math.min(n - 1, Math.max(0, Math.floor(x)));
    if (x >= n - 1) i = n - 1;
    if (k !== i) return 0;
    if (k === n - 1) return 1;
    var seg = x - k;
    var edge = 0.16;
    if (k === 0 && seg <= 1 - edge) return 1;
    if (k > 0 && seg < edge) return seg / edge;
    if (seg > 1 - edge) return Math.max(0, (1 - seg) / edge);
    return 1;
  }

  if (reduce) {
    captions.forEach(function (article) {
      article.removeAttribute("inert");
      article.removeAttribute("aria-hidden");
    });
    surfaceSlides.forEach(function (article) {
      article.removeAttribute("inert");
      article.removeAttribute("aria-hidden");
    });
  }

  function sectionProgress(el) {
    var vh = window.innerHeight || 1;
    var rect = el.getBoundingClientRect();
    var total = el.offsetHeight - vh;
    return total <= 0 ? 0 : clamp(-rect.top / total, 0, 1);
  }

  /* 第二段是另一台运镜。差异先占满画面，搜索从它身后转到前面。两边停稳时只留一块。 */
  var passKeys = [
    { p: 0, rx: 6, ry: 8, y: 8, z: -26, s: 0.94 },
    { p: 0.18, rx: 3, ry: 4, y: 0, z: -4, s: 0.99 },
    { p: 0.42, rx: 5, ry: -7, y: 2, z: -20, s: 0.94 },
    { p: 0.68, rx: 3, ry: -4, y: 0, z: -4, s: 0.99 },
    { p: 1, rx: 6, ry: -9, y: 6, z: -22, s: 0.95 }
  ];

  function samplePass(p) {
    var i = 0;
    while (i < passKeys.length - 2 && p > passKeys[i + 1].p) i += 1;
    var a = passKeys[i];
    var b = passKeys[i + 1];
    var t = smooth((p - a.p) / (b.p - a.p || 1));
    return {
      rx: lerp(a.rx, b.rx, t),
      ry: lerp(a.ry, b.ry, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      s: lerp(a.s, b.s, t)
    };
  }

  function passHand(p) {
    if (p <= 0.2) return 0;
    if (p >= 0.66) return 1;
    return smooth((p - 0.2) / 0.46);
  }

  function passCaption(hand, index) {
    if (index === 0) {
      if (hand <= 0.22) return 1;
      if (hand >= 0.42) return 0;
      return 1 - smooth((hand - 0.22) / 0.2);
    }
    if (hand <= 0.52) return 0;
    if (hand >= 0.72) return 1;
    return smooth((hand - 0.52) / 0.2);
  }

  function driveSurface() {
    if (!surface) return;
    var p = sectionProgress(surface);
    if (passRig && passStage && passPlates.length > 1) {
      var cam = samplePass(p);
      var hand = passHand(p);
      var spread = Math.sin(hand * Math.PI);
      var open = spread < 0.18 ? 0 : smooth((spread - 0.18) / 0.82);
      var diffPlate = passPlates[0];
      var findPlate = passPlates[1];
      var width = diffPlate.offsetWidth || 1;
      var stageW = passStage.clientWidth || window.innerWidth;
      var rigS = cam.s || 1;
      var restLeft = (stageW - width) / 2;
      var visualW = width * rigS;
      var diffScreen = 40;
      var findScreen = Math.max(restLeft, stageW - 52 - visualW);
      var diffX = ((diffScreen - restLeft) / rigS) * open;
      var findX = ((findScreen - restLeft) / rigS) * open;
      var diffZ = -60 * open - 160 * hand;
      var findZ = -210 * (1 - hand);
      if (open > 0.35) findZ = Math.max(findZ, -28);
      diffPlate.style.left = "0px";
      findPlate.style.left = "0px";
      diffPlate.style.transform =
        "translate3d(" + diffX.toFixed(1) + "px,0," + diffZ.toFixed(1) + "px) " +
        "rotateY(" + (-7 * open).toFixed(2) + "deg)";
      findPlate.style.transform =
        "translate3d(" + findX.toFixed(1) + "px,0," + findZ.toFixed(1) + "px) " +
        "rotateY(" + (8 * open).toFixed(2) + "deg)";
      passRig.style.transformOrigin = "50% 50%";
      passRig.style.transform =
        "translate3d(0," + cam.y.toFixed(1) + "px," + cam.z.toFixed(1) + "px) " +
        "rotateX(" + cam.rx.toFixed(2) + "deg) rotateY(" + cam.ry.toFixed(2) + "deg) " +
        "scale(" + cam.s.toFixed(3) + ")";
      passStage.style.perspectiveOrigin =
        (50 + cam.ry * 0.35).toFixed(2) + "% " + (42 + cam.rx * 0.25).toFixed(2) + "%";
      surfaceSlides.forEach(function (article, k) {
        var o = passCaption(hand, k);
        article.style.opacity = o.toFixed(3);
        var on = o > 0.4;
        article.toggleAttribute("inert", !on);
        article.setAttribute("aria-hidden", on ? "false" : "true");
      });
    }
    if (surfaceScrub) surfaceScrub.style.transform = "scaleX(" + p.toFixed(4) + ")";
  }

  function driveSpecs() {
    var vh = window.innerHeight || 1;
    reveals.forEach(function (row) {
      var top = row.getBoundingClientRect().top;
      var t = clamp((vh * 0.92 - top) / 150, 0, 1);
      var e = smooth(t);
      row.style.opacity = e.toFixed(3);
      row.style.transform = "translateY(" + ((1 - e) * 12).toFixed(1) + "px)";
    });
  }

  function frame() {
    document.documentElement.dataset.top = window.scrollY < 8 ? "true" : "false";
    if (!reduce && tour && desk) driveTour();
    if (!reduce) {
      driveSurface();
      driveSpecs();
    }
    markNav();
  }

  function driveTour() {
    var vh = window.innerHeight || 1;
    var rect = tour.getBoundingClientRect();
    var total = tour.offsetHeight - vh;
    var p = total <= 0 ? 0 : clamp(-rect.top / total, 0, 1);
    var n = captions.length || 1;
    var x = p * (n - 1);
    var cam = sample(p);

    desk.style.transform =
      "translate3d(" + cam.x.toFixed(1) + "px," + cam.y.toFixed(1) + "px," + cam.z.toFixed(1) + "px) " +
      "rotateX(" + cam.rx.toFixed(2) + "deg) rotateY(" + cam.ry.toFixed(2) + "deg) " +
      "scale(" + cam.s.toFixed(3) + ")";

    if (stage) {
      stage.style.perspectiveOrigin =
        (50 + cam.ry * 0.35).toFixed(2) + "% " + (42 + cam.rx * 0.25).toFixed(2) + "%";
    }

    var split = band(x, 3.7, 4.15, 5.2, 5.2);
    if (x > 4.15) split = 1;
    if (panes) {
      panes.style.setProperty("--split", split.toFixed(3));
      panes.dataset.open = split > 0.55 ? "1" : "0";
    }

    if (list) {
      var listY = -smooth(clamp(p / 0.92, 0, 1)) * 18;
      list.style.transform = "translateY(" + listY.toFixed(1) + "px)";
    }

    var talk = x >= 2.9 ? 0 : x > 2.55 ? (2.9 - x) / 0.35 : 1;
    var ask = band(x, 2.9, 3.15, 3.7, 4.0);
    var doc = x < 4.0 ? 0 : Math.min(1, (x - 4.0) / 0.25);
    var map = { talk: talk, ask: ask, doc: doc };
    planes.forEach(function (plane) {
      var o = map[plane.dataset.plane] || 0;
      plane.style.opacity = o.toFixed(3);
      plane.style.transform = "translateY(" + ((1 - o) * 16).toFixed(1) + "px)";
    });

    var termT = x <= 3.85 ? 0 : clamp((x - 3.85) / 0.7, 0, 1);
    lines.forEach(function (line, i) {
      var start = i / Math.max(1, lines.length);
      var o = clamp((termT - start) / 0.16, 0, 1);
      line.style.opacity = o.toFixed(3);
    });

    if (menu) {
      var menuO = band(x, 1.9, 2.2, 2.6, 2.9);
      menu.style.opacity = menuO.toFixed(3);
      menu.style.transform = "translateY(" + ((1 - menuO) * 8).toFixed(1) + "px)";
    }

    var focus = 0;
    if (x >= 2.9) focus = 3;
    if (x >= 4.0) focus = 2;
    desk.querySelector(".app").dataset.focus = String(focus);

    captions.forEach(function (article, k) {
      var o = captionOpacity(k, x, n);
      article.style.opacity = o.toFixed(3);
      var on = o > 0.4;
      article.toggleAttribute("inert", !on);
      article.setAttribute("aria-hidden", on ? "false" : "true");
    });

    if (scrub) scrub.style.transform = "scaleX(" + p.toFixed(4) + ")";
  }

  function markNav() {
    var vh = window.innerHeight || 1;
    var mark = vh * 0.35;
    var current = null;
    sections.forEach(function (sec) {
      var rect = sec.getBoundingClientRect();
      if (rect.top <= mark && rect.bottom > mark) current = sec;
    });
    navLinks.forEach(function (link) {
      var on = current && link.getAttribute("href") === "#" + current.id;
      if (on) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  }

  var ticking = false;
  function request() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      frame();
    });
  }

  document.addEventListener("scroll", request, { passive: true });
  window.addEventListener("resize", request);
  frame();

  if (copyBtn && code) {
    copyBtn.addEventListener("click", async function () {
      var text = code.innerText.replace(/\n$/, "");
      var ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (err) {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        try {
          ok = document.execCommand("copy");
        } catch (err2) {
          ok = false;
        }
        area.remove();
      }
      copyBtn.textContent = ok ? "已复制" : "请手选复制";
      window.setTimeout(function () {
        copyBtn.textContent = "复制";
      }, 1600);
    });
  }
})();
