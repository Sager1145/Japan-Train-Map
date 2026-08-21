// =========================================================================
//  app-playback-video.js — 行程播放的影片輸出
//
//  Records a playback run to a video file, entirely in the browser (the
//  static GitHub Pages deploy has no backend to encode on).
//
//  The pipeline, and why each hop exists:
//
//      map canvas ──captureStream──▶ <video> ──drawImage──▶ 2D canvas
//                                                              │ + caption
//                                                              ▼
//                                             captureStream ─▶ MediaRecorder
//
//  · The map is WebGL, and its drawing buffer is cleared the moment it is
//    composited — drawImage() off it returns transparent pixels unless the
//    map was built with preserveDrawingBuffer, which costs every user a
//    per-frame copy for a feature almost nobody runs. captureStream() taps
//    the compositor instead and needs nothing.
//  · A stream cannot be drawn on, so it is played into a <video> element,
//    which CAN be drawn from. That is also where the crop and the downscale
//    happen: #map spans the whole window and the menu sits ON TOP of it, so
//    the raw canvas contains the region hidden behind the menu. The recording
//    takes the UNCOVERED rectangle — the same area the playback camera
//    centres the train in — so the exported frame is what was watched.
//  · Everything drawn into the video must therefore be ON the canvas. That is
//    why the playhead is a map layer and not a maplibregl.Marker.
//
//  Part of the app-*.js family: nothing here touches the DOM, MediaRecorder
//  or requestAnimationFrame at load time, so the Node vm replay
//  (scripts/lib/app-family-sandbox.mjs) evaluates it harmlessly.
// =========================================================================

const PlaybackVideo = (function () {
  "use strict";

  // Output presets. `aspect` is the SHAPE of the exported frame; the recorder
  // takes the largest rectangle of that shape centred on the uncovered map,
  // which loses nothing that matters because the playback camera keeps the
  // train in that exact centre. `aspect: 0` means "whatever shape the
  // uncovered map happens to be" — honest, but on a desktop with the menu
  // open that is close to square, which is a strange thing to hand someone.
  // `cap` bounds the height so a retina canvas cannot produce a needlessly
  // enormous file; the real size is never upscaled past the source.
  //
  // Every preset is 60 fps: the camera pans continuously for the whole run,
  // and a continuous pan is the one thing 30 fps cannot carry — it judders in
  // a way that a cut-heavy video never would.
  const FPS = 60;
  const SHAPES = [
    { key: "square", aspect: 1 },
    { key: "wide", aspect: 16 / 9 },
    { key: "tall", aspect: 9 / 16 },
    { key: "native", aspect: 0 },
  ];
  // Quality is a HEIGHT CEILING, never a target: the source is the map canvas
  // at its own device pixels, and upscaling a map — thin strokes and small
  // type — buys a bigger file and a softer picture, nothing else. "max" is
  // therefore "as tall as the source allows", bounded only so a retina canvas
  // cannot ask for a 4K encode nobody wanted.
  const QUALITIES = [
    { key: "q1080", cap: 1080 },
    { key: "q720", cap: 720 },
    { key: "q540", cap: 540 },
    { key: "qmax", cap: 2160 },
  ];
  // Bits per pixel per second. Flat colour and hard edges need far less than
  // live footage: 0.11 is already clean on this map, so "high" is headroom
  // for re-encoding downstream and "small" is for sending over a messenger.
  const BITRATES = [
    { key: "high", bpp: 0.2 },
    { key: "standard", bpp: 0.11 },
    { key: "small", bpp: 0.055 },
  ];
  const SETTINGS_KEY = "n02-playback-video-v1";

  // Preference order. MP4/H.264 plays everywhere a phone or a chat app will
  // open it; WebM is the fallback for browsers that will not encode H.264.
  const CODECS = [
    { mime: "video/mp4;codecs=avc1.4d002a", ext: "mp4" },
    { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
    { mime: "video/mp4", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
  ];

  const MAX_BITRATE = 60_000_000;
  const MIN_BITRATE = 2_000_000;
  // How long the pipeline waits for the map stream to deliver its first
  // frame. A backgrounded tab never plays a <video>, and without this the
  // export sits forever with a session that cannot even be cancelled.
  const FIRST_FRAME_TIMEOUT_MS = 8000;

  let session = null;
  // Remembered between exports: choosing a shape and a bitrate once should be
  // enough. Nothing here is part of the train store, so it lives in
  // localStorage like every other presentation preference.
  let settings = { shape: "square", quality: "q1080", bitrate: "standard" };
  let pendingPlan = null;
  let pendingCodec = null;

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (saved && typeof saved === "object") Object.assign(settings, saved);
    } catch {
      // A corrupt preference is not worth failing an export over.
    }
    if (!SHAPES.some((x) => x.key === settings.shape)) settings.shape = "square";
    if (!QUALITIES.some((x) => x.key === settings.quality))
      settings.quality = "q1080";
    if (!BITRATES.some((x) => x.key === settings.bitrate))
      settings.bitrate = "standard";
    return settings;
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private mode / quota — the export still runs with what is in memory.
    }
  }

  // The three chosen rows, resolved into the numbers the pipeline needs.
  function resolveSettings() {
    const shape = SHAPES.find((x) => x.key === settings.shape) || SHAPES[0];
    const quality =
      QUALITIES.find((x) => x.key === settings.quality) || QUALITIES[0];
    const bitrate =
      BITRATES.find((x) => x.key === settings.bitrate) || BITRATES[1];
    return { aspect: shape.aspect, cap: quality.cap, bpp: bitrate.bpp, fps: FPS };
  }

  function bitrateFor(size, preset) {
    return Math.round(
      Math.min(
        MAX_BITRATE,
        Math.max(MIN_BITRATE, size.w * size.h * preset.fps * preset.bpp),
      ),
    );
  }

  function supported() {
    return (
      typeof MediaRecorder === "function" &&
      typeof HTMLCanvasElement !== "undefined" &&
      typeof HTMLCanvasElement.prototype.captureStream === "function"
    );
  }

  function pickCodec() {
    for (const codec of CODECS) {
      if (MediaRecorder.isTypeSupported(codec.mime)) return codec;
    }
    return null;
  }

  function isRecording() {
    return Boolean(session);
  }

  // ── the uncovered map rectangle, in CANVAS pixels ──────────────────────
  // The camera padding is the menu footprint in CSS pixels; the canvas is
  // that times the device pixel ratio the map was built with. Deriving the
  // ratio from the canvas rather than from window.devicePixelRatio matters:
  // the map deliberately caps its own ratio (2 on desktop, 1.5 on phones).
  function uncoveredRect() {
    const canvas = map.getCanvas();
    const container = map.getContainer();
    const cssW = container.clientWidth || 1;
    const cssH = container.clientHeight || 1;
    const ratio = (canvas.width || cssW) / cssW;
    const pad =
      typeof map.getPadding === "function"
        ? map.getPadding()
        : { top: 0, right: 0, bottom: 0, left: 0 };
    const left = Math.max(0, pad.left || 0);
    const top = Math.max(0, pad.top || 0);
    const width = Math.max(64, cssW - left - (pad.right || 0));
    const height = Math.max(64, cssH - top - (pad.bottom || 0));
    return {
      x: Math.round(left * ratio),
      y: Math.round(top * ratio),
      w: Math.round(width * ratio),
      h: Math.round(height * ratio),
    };
  }

  // H.264 requires even dimensions, and an odd one is silently rounded by
  // some encoders and rejected by others.
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);

  // The largest rectangle of the requested shape that still fits INSIDE the
  // uncovered map — going outside it would pull in the pixels hidden behind
  // the menu, which is precisely what nobody wants in the file.
  function cropFor(rect, preset) {
    if (!preset.aspect) return rect;
    const want = preset.aspect;
    const have = rect.w / rect.h;
    let w = rect.w;
    let h = rect.h;
    if (want > have) h = rect.w / want;
    else w = rect.h * want;
    return {
      x: Math.round(rect.x + (rect.w - w) / 2),
      y: Math.round(rect.y + (rect.h - h) / 2),
      w: Math.round(w),
      h: Math.round(h),
    };
  }

  // Never upscale: a map is thin strokes and small type, and stretching a
  // 700 px crop up to "1080p" only makes a bigger, softer file.
  function outputSize(crop, preset) {
    const h = Math.min(preset.cap, crop.h);
    return { w: even((crop.w * h) / crop.h), h: even(h) };
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function timestampName(ext) {
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return (
      `journey-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
      `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`
    );
  }

  // ── caption ────────────────────────────────────────────────────────────
  // Burnt into the frame because the player bar is DOM and never reaches the
  // canvas. Kept to one line plus a progress rule: the map IS the content,
  // and a video of a map should not be mostly chrome.
  function drawCaption(ctx, size, state) {
    const scale = size.h / 1080;
    const pad = Math.round(34 * scale);
    const barH = Math.round(4 * scale);
    const fontSize = Math.round(30 * scale);
    const boxH = Math.round(fontSize * 2.6);
    const y = size.h - pad - boxH;

    ctx.save();
    ctx.fillStyle = "rgba(12,12,12,0.72)";
    const radius = Math.round(16 * scale);
    const x = pad;
    const w = size.w - pad * 2;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, boxH, radius);
    else ctx.rect(x, y, w, boxH);
    ctx.fill();

    ctx.fillStyle = "#f5eee9";
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans CJK JP", sans-serif`;
    ctx.textBaseline = "middle";
    const textY = y + boxH / 2 - barH;
    const inset = Math.round(24 * scale);
    const title = state.title || "";
    const station = state.station || "";
    let titleWidth = w - inset * 2;
    if (station) {
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans CJK JP", sans-serif`;
      const stationWidth = ctx.measureText(station).width + inset;
      titleWidth -= stationWidth;
      ctx.fillStyle = state.color || "#e8830c";
      ctx.textAlign = "right";
      ctx.fillText(station, x + w - inset, textY);
    }
    ctx.fillStyle = "#f5eee9";
    ctx.textAlign = "left";
    ctx.fillText(fitText(ctx, title, Math.max(40, titleWidth)), x + inset, textY);

    // Progress rule along the bottom edge of the caption box.
    const railY = y + boxH - barH * 2;
    ctx.fillStyle = "rgba(245,238,233,0.22)";
    ctx.fillRect(x + inset, railY, w - inset * 2, barH);
    ctx.fillStyle = state.color || "#e8830c";
    ctx.fillRect(
      x + inset,
      railY,
      (w - inset * 2) * Math.max(0, Math.min(1, state.progress || 0)),
      barH,
    );
    ctx.restore();
  }

  // Trim with an ellipsis rather than letting a long train name run under the
  // station chip.
  function fitText(ctx, text, maxWidth) {
    if (!text) return "";
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return text.slice(0, lo) + "…";
  }

  // ── recording ──────────────────────────────────────────────────────────

  async function start() {
    if (session) return;
    if (!map || typeof RailMap === "undefined") return;
    if (!supported()) {
      setStatus(els.fieldStatus, I18N.t("video.unsupported"), "err");
      return;
    }
    const codec = pickCodec();
    if (!codec) {
      setStatus(els.fieldStatus, I18N.t("video.unsupported"), "err");
      return;
    }
    if (Playback.isActive()) Playback.stop();

    // Compile the whole queue before recording: the caller needs a real
    // duration to decide on, and a compile mid-run would be a hitch baked
    // into the file.
    setStatus(els.fieldStatus, I18N.t("video.preparing"), "");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const plan = Playback.prepare();
    if (!plan.trains) {
      setStatus(els.fieldStatus, I18N.t("play.empty"), "warn");
      return;
    }

    // Shape, quality and bitrate are shown together with the size and the
    // file estimate they produce, and every change re-reads that line — the
    // point of the panel is that the consequence of a choice is visible
    // before it is committed to a run that takes minutes.
    pendingPlan = plan;
    pendingCodec = codec;
    openOptions();
  }

  // ── export options panel ───────────────────────────────────────────────

  function fillSelect(select, items, current, labelKey) {
    if (!select) return;
    select.innerHTML = "";
    items.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.key;
      option.textContent = I18N.t(labelKey + item.key);
      select.appendChild(option);
    });
    select.value = current;
  }

  function openOptions() {
    loadSettings();
    fillSelect(els.playbackShape, SHAPES, settings.shape, "video.shape.");
    fillSelect(els.playbackQuality, QUALITIES, settings.quality, "video.quality.");
    fillSelect(els.playbackBitrate, BITRATES, settings.bitrate, "video.bitrate.");
    if (els.playbackBar) els.playbackBar.hidden = false;
    if (els.playbackExportOptions) els.playbackExportOptions.hidden = false;
    updateOptionsSummary();
    setStatus(els.fieldStatus, "", "");
  }

  function closeOptions() {
    if (els.playbackExportOptions) els.playbackExportOptions.hidden = true;
    pendingPlan = null;
    pendingCodec = null;
  }

  function readOptions() {
    if (els.playbackShape) settings.shape = els.playbackShape.value;
    if (els.playbackQuality) settings.quality = els.playbackQuality.value;
    if (els.playbackBitrate) settings.bitrate = els.playbackBitrate.value;
    saveSettings();
  }

  function plannedOutput() {
    const preset = resolveSettings();
    const size = outputSize(cropFor(uncoveredRect(), preset), preset);
    return { preset, size, bitrate: bitrateFor(size, preset) };
  }

  function updateOptionsSummary() {
    const el = els.playbackExportSummary;
    if (!el) return;
    const { size, bitrate } = plannedOutput();
    const seconds = pendingPlan ? pendingPlan.seconds : 0;
    el.textContent = I18N.t("video.summary", {
      size: `${size.w}×${size.h}`,
      fps: FPS,
      mbps: (bitrate / 1_000_000).toFixed(1),
      length: formatDuration(seconds),
      bytes: formatBytes((bitrate / 8) * seconds),
      ext: (pendingCodec ? pendingCodec.ext : "mp4").toUpperCase(),
    });
  }

  async function beginFromOptions() {
    if (!pendingCodec) return;
    readOptions();
    const codec = pendingCodec;
    const { preset, size } = plannedOutput();
    closeOptions();
    try {
      await run(codec, preset, size);
    } catch (err) {
      console.error("[video]", err);
      teardown();
      // teardown deliberately leaves the row up — it is where a finished file
      // is offered — so a FAILED export has to take it down itself, or the
      // bar keeps showing "waiting for the map" long after it gave up.
      dismissBanner();
      setStatus(
        els.fieldStatus,
        I18N.t("video.failed", { msg: err.message || String(err) }),
        "err",
      );
    }
  }

  function run(codec, preset, size) {
    const canvas = map.getCanvas();
    const source = canvas.captureStream(preset.fps);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = source;

    const composite = document.createElement("canvas");
    composite.width = size.w;
    composite.height = size.h;
    const ctx = composite.getContext("2d", { alpha: false });
    const outStream = composite.captureStream(preset.fps);
    const bitrate = bitrateFor(size, preset);
    const recorder = new MediaRecorder(outStream, {
      mimeType: codec.mime,
      videoBitsPerSecond: bitrate,
    });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };

    session = {
      codec,
      preset,
      size,
      video,
      composite,
      ctx,
      recorder,
      chunks,
      source,
      outStream,
      rafId: null,
      // Stamped at creation and re-stamped when the recorder actually opens.
      // The row goes up before the first frame arrives, and a zero here made
      // it count from page load instead of from the recording.
      startedAt: performance.now(),
      bannerAt: 0,
      frames: 0,
      // Re-read every frame: the menu can be dragged, collapsed or the
      // window resized mid-recording, and the camera padding follows it — so
      // the recorded rectangle has to follow it too. The OUTPUT size is
      // fixed at start (a stream cannot change dimensions mid-recording),
      // so a resize rescales rather than reshapes.
      crop: () => cropFor(uncoveredRect(), preset),
      offFinish: null,
      done: null,
    };

    // Open the row NOW, before waiting for anything. Between choosing a
    // quality and the map's first frame arriving there is a live session with
    // no bar — and therefore no ✕ and no 結束錄影 — so a stream that never
    // delivers left the user watching an unabortable nothing for the whole
    // first-frame timeout.
    showBanner();

    return new Promise((resolve, reject) => {
      session.done = { resolve, reject };
      recorder.onerror = (event) =>
        reject(event.error || new Error("MediaRecorder failed"));
      recorder.onstop = () => finalize();

      firstFrame(video)
        .then(() => {
          // One frame in hand before the recorder opens, so the file never
          // starts on a blank composite.
          drawFrame();
          recorder.start(1000);
          session.startedAt = performance.now();
          session.bannerAt = 0;
          session.offFinish = Playback.onFinish(({ aborted }) => {
            session.aborted = aborted;
            stopRecorder();
          });
          // autoBegin: the run frames the whole scope first — which is the
          // opening shot of the file — and starts once that move lands.
          Playback.start({ autoBegin: true });
          loop();
        })
        .catch(reject);
    });
  }

  // Resolves once the <video> is actually carrying the map stream. play()
  // resolving is not enough on its own: a stream that has not produced a
  // frame yet leaves videoWidth at 0, and compositing from it would encode
  // a blank square.
  function firstFrame(video) {
    const ready = (async () => {
      await video.play();
      if (video.videoWidth) return;
      await new Promise((resolve) => {
        const done = () => {
          video.removeEventListener("loadeddata", done);
          video.removeEventListener("resize", done);
          resolve();
        };
        video.addEventListener("loadeddata", done);
        video.addEventListener("resize", done);
      });
    })();
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(I18N.t("video.noFrames"))),
        FIRST_FRAME_TIMEOUT_MS,
      ),
    );
    return Promise.race([ready, timeout]);
  }

  function drawFrame() {
    if (!session) return;
    const { ctx, size, video } = session;
    if (!video.videoWidth) return;
    const crop = session.crop();
    // The <video> carries the canvas at its own pixel size; the crop was
    // computed in those same canvas pixels, so it transfers directly.
    const sx = Math.min(crop.x, Math.max(0, video.videoWidth - 2));
    const sy = Math.min(crop.y, Math.max(0, video.videoHeight - 2));
    const sw = Math.max(2, Math.min(crop.w, video.videoWidth - sx));
    const sh = Math.max(2, Math.min(crop.h, video.videoHeight - sy));
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, size.w, size.h);
    drawCaption(ctx, size, captionState());
    session.frames += 1;
  }

  function captionState() {
    const state = Playback.captionState ? Playback.captionState() : null;
    return state || { title: "", station: "", progress: 0, color: "#e8830c" };
  }

  function loop() {
    if (!session) return;
    session.rafId = requestAnimationFrame(() => {
      if (!session) return;
      drawFrame();
      syncRecorderToPlayback();
      // The clock in the row ticks in whole seconds; rewriting it sixty times
      // a second would be sixty layout invalidations for the same string.
      const now = performance.now();
      if (now - session.bannerAt > 250) {
        session.bannerAt = now;
        updateBanner();
      }
      loop();
    });
  }

  // A paused run must pause the FILE too, or the video gets a frozen stretch
  // exactly as long as the interruption. MediaRecorder.pause keeps the
  // timeline contiguous across the gap.
  function syncRecorderToPlayback() {
    if (!session) return;
    const { recorder } = session;
    const paused = Playback.phase() === "paused";
    if (paused && recorder.state === "recording") recorder.pause();
    else if (!paused && recorder.state === "paused") recorder.resume();
  }

  function stopRecorder() {
    if (!session) return;
    const { recorder } = session;
    if (recorder.state !== "inactive") recorder.stop();
  }

  function finalize() {
    if (!session) return;
    const { chunks, codec, aborted, done } = session;
    const frames = session.frames;
    teardown();
    if (!chunks.length) {
      setStatus(els.fieldStatus, I18N.t("video.empty"), "warn");
      if (done) done.resolve(null);
      return;
    }
    const blob = new Blob(chunks, { type: codec.mime });
    const name = timestampName(codec.ext);
    offerDownload(name, blob, aborted);
    console.info(`[video] ${name}: ${frames} composited frames`);
    if (done) done.resolve(blob);
  }

  // A recording ends minutes after the click that started it, so the save is
  // NOT inside a user gesture — and browsers block a programmatic download
  // that far from one (observed here: the first export of a session saved,
  // the second was silently dropped). So the anchor is left on screen with
  // the file already attached to it, and the automatic save is only an
  // attempt. The object URL therefore outlives this function and is released
  // when the next recording starts or the row is dismissed.
  let pendingUrl = null;
  function offerDownload(name, blob, aborted) {
    releasePending();
    pendingUrl = URL.createObjectURL(blob);
    const link = els.playbackDownload;
    if (link) {
      link.href = pendingUrl;
      link.download = name;
      link.textContent = I18N.t("video.save", { size: formatBytes(blob.size) });
      link.hidden = false;
      link.click(); // may be blocked; the visible link is the guarantee
    } else {
      downloadBlob(name, blob);
    }
    // Stopping the run closes the player bar, and the bar is what the save
    // row lives inside — so a cancelled export finished with the file made,
    // the offer rendered, and both of them behind a hidden parent. The offer
    // outlives the run that produced it, so it reopens the bar it needs.
    if (els.playbackBar) els.playbackBar.hidden = false;
    const banner = els.playbackRecording;
    if (banner) {
      banner.hidden = false;
      banner.classList.add("is-ready");
    }
    if (els.playbackRecordingStop) els.playbackRecordingStop.hidden = true;
    if (els.playbackRecordingText)
      els.playbackRecordingText.textContent = I18N.t(
        aborted ? "video.readyPartial" : "video.ready",
        { name },
      );
    setStatus(
      els.fieldStatus,
      I18N.t(aborted ? "video.savedPartial" : "video.saved", {
        name,
        size: formatBytes(blob.size),
      }),
      "ok",
    );
  }

  function releasePending() {
    if (!pendingUrl) return;
    URL.revokeObjectURL(pendingUrl);
    pendingUrl = null;
  }

  // Put the row back into its recording shape and drop the previous file.
  function resetBanner() {
    releasePending();
    if (els.playbackPreview) {
      els.playbackPreview.hidden = true;
      els.playbackPreview.innerHTML = "";
    }
    const banner = els.playbackRecording;
    if (banner) banner.classList.remove("is-ready");
    if (els.playbackDownload) {
      els.playbackDownload.hidden = true;
      els.playbackDownload.removeAttribute("href");
    }
    if (els.playbackRecordingStop) els.playbackRecordingStop.hidden = false;
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function teardown() {
    if (!session) return;
    const s = session;
    session = null;
    if (s.rafId != null) cancelAnimationFrame(s.rafId);
    if (s.offFinish) s.offFinish();
    if (s.video) {
      s.video.pause();
      s.video.srcObject = null;
    }
    [s.source, s.outStream].forEach((stream) => {
      if (!stream) return;
      stream.getTracks().forEach((track) => track.stop());
    });
    // The row is NOT hidden here: finalize turns it into the "file ready"
    // offer, which has to outlive the session that produced it.
  }

  // Cancel from the UI: stop the run, which announces an abort, which stops
  // the recorder — the partial file is still written rather than thrown away.
  function cancel() {
    if (!session) return;
    session.aborted = true;
    // A recorder that never started has no "stop" to fire, so nothing would
    // ever call finalize and the session would stay wedged — which is
    // exactly the state a cancel is meant to get out of.
    if (session.recorder.state === "inactive") {
      const done = session.done;
      teardown();
      dismissBanner();
      setStatus(els.fieldStatus, "", "");
      if (done) done.resolve(null);
      return;
    }
    if (Playback.isActive()) Playback.stop();
    else stopRecorder();
  }

  // ── recording banner ───────────────────────────────────────────────────

  function showBanner() {
    const el = els.playbackRecording;
    if (!el) return;
    // The row lives inside the player bar, and at this point the run has not
    // opened it yet.
    if (els.playbackBar) els.playbackBar.hidden = false;
    // resetBanner FIRST — it clears the previous run's preview and file — and
    // only then attach this run's canvas, or the reset takes it straight back
    // out again.
    resetBanner();
    // The composite canvas IS the preview: the row shows literally the frame
    // being encoded, crop, caption and all, so there is no second rendering
    // path that could disagree with the file.
    if (els.playbackPreview && session) {
      session.composite.className = "playback-preview-canvas";
      els.playbackPreview.appendChild(session.composite);
      els.playbackPreview.hidden = false;
    }
    el.hidden = false;
    updateBanner();
  }

  function updateBanner() {
    const el = els.playbackRecordingText;
    if (!el || !session) return;
    const size = `${session.size.w}×${session.size.h}`;
    // Before the map has handed over its first frame there is nothing being
    // recorded yet, and a running clock would be claiming otherwise.
    if (session.recorder.state === "inactive") {
      el.textContent = I18N.t("video.waiting", { size });
      return;
    }
    el.textContent = I18N.t("video.recording", {
      time: formatDuration((performance.now() - session.startedAt) / 1000),
      size,
    });
  }

  function dismissBanner() {
    resetBanner();
    const el = els.playbackRecording;
    if (el) el.hidden = true;
    // The bar was only reopened to carry the offer; with the offer gone and
    // nothing playing, it has no reason to stay.
    if (els.playbackBar && !Playback.isActive() && Playback.phase() !== "ended")
      els.playbackBar.hidden = true;
  }

  // Closing the panel without recording is a plain cancel: no session was
  // ever created, so there is nothing to tear down but the bar itself.
  function cancelOptions() {
    closeOptions();
    if (!session && !Playback.isActive() && els.playbackBar)
      els.playbackBar.hidden = true;
  }

  function bindUi() {
    // Hiding the tab pauses playback (app-playback.js), but the recorder
    // cannot learn that through the rAF loop — rAF is exactly what a hidden
    // tab stops running. Without this the file collects a frozen stretch as
    // long as the user was away.
    document.addEventListener("visibilitychange", () => {
      if (!session) return;
      if (document.hidden) {
        if (session.recorder.state === "recording") session.recorder.pause();
      } else {
        syncRecorderToPlayback();
      }
    });
    if (els.playbackExport)
      els.playbackExport.addEventListener("click", () => {
        if (isRecording()) cancel();
        else if (els.playbackExportOptions && !els.playbackExportOptions.hidden)
          cancelOptions();
        else start();
      });
    [els.playbackShape, els.playbackQuality, els.playbackBitrate].forEach(
      (select) => {
        if (!select) return;
        select.addEventListener("change", () => {
          readOptions();
          updateOptionsSummary();
        });
      },
    );
    if (els.playbackExportStart)
      els.playbackExportStart.addEventListener("click", beginFromOptions);
    if (els.playbackExportCancel)
      els.playbackExportCancel.addEventListener("click", cancelOptions);
    if (els.playbackRecordingStop)
      els.playbackRecordingStop.addEventListener("click", () => cancel());
    if (els.playbackDownload)
      els.playbackDownload.addEventListener("click", (event) => {
        // Clicking the link IS the save, so the row has done its job — but
        // ONLY for a real click. offerDownload's own link.click() attempt
        // dispatches an UNTRUSTED one, and treating that as "the user has
        // the file" tore the row down — and revoked the object URL with it —
        // in exactly the case the row exists for: the attempt being blocked.
        if (!event.isTrusted) return;
        setTimeout(dismissBanner, 400);
      });
  }

  return {
    start,
    cancel,
    cancelOptions,
    isRecording,
    supported,
    bindUi,
    dismissBanner,
  };
})();
