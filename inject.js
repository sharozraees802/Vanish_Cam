// Vanish Cam v2 - runs in the page's MAIN world and wraps getUserMedia.
//
// Hotkeys (Windows/Linux):  Alt + Shift + B  = capture background (3s countdown)
//                           Alt + Shift + V  = toggle vanish
// Hotkeys (Mac):            Option(⌥) + Shift + B = capture background
//                           Option(⌥) + Shift + V = toggle vanish
// Or just snap your fingers = toggle vanish.
(() => {
  if (window.__vanishCamInstalled) return;
  window.__vanishCamInstalled = true;

  const IS_MAC = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? 'Option(⌥)+Shift' : 'Alt+Shift';

  const CFG = {
    outMaxWidth: 1280,     // OUTPUT resolution (full quality, no blur)
    analysisWidth: 320,    // mask is computed at this width (fast)
    diffThreshold: 60,     // pixel difference vs background to count as "person"
    erodeRadius: 1,        // removes speckle noise from the mask
    dilateRadius: 3,       // grows mask to cover edges (in analysis pixels)
    vanishMs: 1800,        // length of the dissolve effect
    captureDelayMs: 3000,  // time to step out of frame
    captureFrames: 20,     // frames averaged for the background
    fps: 30,
    snapMinEnergy: 55,
    snapRatio: 3.0,
    snapCooldownMs: 1500,
  };

  const state = { target: 0, progress: 0 }; // 0 = visible, 1 = vanished
  let currentProcessor = null;
  let lastSnap = 0;

  // ---------- toast ----------
  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      Object.assign(toastEl.style, {
        position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,.8)', color: '#fff', padding: '8px 14px',
        borderRadius: '8px', font: '14px sans-serif', zIndex: 2147483647,
        pointerEvents: 'none', transition: 'opacity .3s',
      });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.opacity = '0'), 2500);
  }

  function toggleVanish() {
    if (!currentProcessor || !currentProcessor.hasBackground()) {
      toast(`Pehle background capture karo: ${MOD}+B`);
      return;
    }
    state.target = state.target ? 0 : 1;
  }

  // ---------- snap detection ----------
  function startSnapDetector(stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    if (ctx.state === 'suspended') {
      document.addEventListener('click', () => ctx.resume(), { once: true });
    }
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0;
    src.connect(an);

    const bins = new Uint8Array(an.frequencyBinCount);
    const hzPerBin = ctx.sampleRate / an.fftSize;
    const lo = Math.floor(2000 / hzPerBin);
    const hi = Math.floor(8000 / hzPerBin);
    let avg = 10;

    setInterval(() => {
      an.getByteFrequencyData(bins);
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += bins[i];
      const energy = sum / (hi - lo);
      const now = performance.now();
      if (energy > CFG.snapMinEnergy && energy > avg * CFG.snapRatio &&
          now - lastSnap > CFG.snapCooldownMs) {
        lastSnap = now;
        toggleVanish();
      }
      avg = avg * 0.95 + energy * 0.05;
    }, 20);
  }

  // ---------- morphology (separable box, binary) ----------
  // mode 1 = dilate, mode 0 = erode
  function morph(src, tmp, dst, W, H, r, dilateMode) {
    const hit = dilateMode ? 1 : 0;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let v = dilateMode ? 0 : 1;
        const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
        for (let xx = x0; xx <= x1; xx++) {
          if (src[row + xx] === hit) { v = hit; break; }
        }
        tmp[row + x] = v;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let v = dilateMode ? 0 : 1;
        const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
        for (let yy = y0; yy <= y1; yy++) {
          if (tmp[yy * W + x] === hit) { v = hit; break; }
        }
        dst[y * W + x] = v;
      }
    }
  }

  function makeCanvas(w, h, opts) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d', opts)];
  }

  // ---------- video processing ----------
  function createProcessor(videoTrack) {
    const s = videoTrack.getSettings();
    const srcW = s.width || 1280, srcH = s.height || 720;
    const sc = Math.min(1, CFG.outMaxWidth / srcW);
    const W = Math.round(srcW * sc), H = Math.round(srcH * sc);
    const aw = CFG.analysisWidth, ah = Math.round((aw * H) / W);

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    video.play().catch(() => {});

    // full-res output + full-res background (so no blur)
    const [outCv, out] = makeCanvas(W, H);
    const [bgCv, bgCtx] = makeCanvas(W, H);
    const [layerCv, layer] = makeCanvas(W, H);
    // low-res analysis
    const [, small] = makeCanvas(aw, ah, { willReadFrequently: true });
    const [bgSmallCv, bgSmallCtx] = makeCanvas(aw, ah, { willReadFrequently: true });
    const [maskCv, maskCtx] = makeCanvas(aw, ah);
    const maskImg = maskCtx.createImageData(aw, ah);

    const N = aw * ah;
    const raw = new Uint8Array(N), tmp = new Uint8Array(N);
    const eroded = new Uint8Array(N), mask = new Uint8Array(N);

    // dissolve threshold: random + left-to-right sweep
    const noise = new Float32Array(N);
    for (let y = 0; y < ah; y++)
      for (let x = 0; x < aw; x++) noise[y * aw + x] = Math.random() * 0.5 + (x / aw) * 0.5;

    let bgSmall = null;      // low-res background pixels (for diffing)
    let capture = null;      // { count, startAt }
    let lastT = performance.now();

    function startCapture() {
      toast('Frame se bahar jao... 3 second');
      capture = { count: 0, startAt: performance.now() + CFG.captureDelayMs };
    }

    function tick() {
      if (video.readyState < 2) return;
      const now = performance.now();
      const dt = now - lastT;
      lastT = now;

      // 1) always draw the live frame at full resolution
      out.globalCompositeOperation = 'source-over';
      out.drawImage(video, 0, 0, W, H);

      // 2) background capture: running average done on GPU, full-res
      if (capture && now >= capture.startAt) {
        bgCtx.globalAlpha = 1 / (capture.count + 1);
        bgCtx.drawImage(video, 0, 0, W, H);
        bgCtx.globalAlpha = 1;
        capture.count++;
        if (capture.count >= CFG.captureFrames) {
          bgSmallCtx.drawImage(bgCv, 0, 0, aw, ah);
          bgSmall = bgSmallCtx.getImageData(0, 0, aw, ah).data;
          capture = null;
          toast(`Background capture ho gaya. Ab snap karo ya ${MOD}+V dabao!`);
        }
      }

      // 3) progress animation
      const dir = state.target > state.progress ? 1 : state.target < state.progress ? -1 : 0;
      state.progress = Math.min(1, Math.max(0, state.progress + (dir * dt) / CFG.vanishMs));

      // 4) build mask at low-res, composite at full-res
      if (bgSmall && state.progress > 0) {
        small.drawImage(video, 0, 0, aw, ah);
        const d = small.getImageData(0, 0, aw, ah).data;

        // pass 1: estimate global brightness shift (auto-exposure) from "background-like" pixels
        let offSum = 0, offCnt = 0;
        for (let i = 0; i < N; i++) {
          const j = i * 4;
          const dl = (d[j] + d[j + 1] + d[j + 2]) - (bgSmall[j] + bgSmall[j + 1] + bgSmall[j + 2]);
          if (Math.abs(dl) < CFG.diffThreshold) { offSum += dl; offCnt++; }
        }
        const off = offCnt ? offSum / offCnt / 3 : 0;

        // pass 2: threshold with compensation
        for (let i = 0; i < N; i++) {
          const j = i * 4;
          const diff =
            Math.abs(d[j] - bgSmall[j] - off) +
            Math.abs(d[j + 1] - bgSmall[j + 1] - off) +
            Math.abs(d[j + 2] - bgSmall[j + 2] - off);
          raw[i] = diff > CFG.diffThreshold ? 1 : 0;
        }
        morph(raw, tmp, eroded, aw, ah, CFG.erodeRadius, false);   // kill speckles
        morph(eroded, tmp, mask, aw, ah, CFG.dilateRadius, true);  // cover edges

        const a = maskImg.data;
        for (let i = 0; i < N; i++) {
          a[i * 4 + 3] = mask[i] && noise[i] < state.progress ? 255 : 0;
        }
        maskCtx.putImageData(maskImg, 0, 0);

        // cut the full-res background with the (smoothly upscaled) mask
        layer.globalCompositeOperation = 'copy';
        layer.drawImage(bgCv, 0, 0, W, H);
        layer.globalCompositeOperation = 'destination-in';
        layer.imageSmoothingEnabled = true;
        layer.imageSmoothingQuality = 'high';
        layer.drawImage(maskCv, 0, 0, W, H);
        layer.globalCompositeOperation = 'source-over';

        out.drawImage(layerCv, 0, 0, W, H);
      }
    }

    // setInterval (not rAF) so it keeps running if the tab is in background
    const timer = setInterval(tick, 1000 / CFG.fps);

    const outTrack = outCv.captureStream(CFG.fps).getVideoTracks()[0];
    const origStop = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {
      origStop();
      videoTrack.stop();
      clearInterval(timer);
      if (currentProcessor === api) currentProcessor = null;
    };

    const api = {
      track: outTrack,
      startCapture,
      hasBackground: () => !!bgSmall,
    };
    return api;
  }

  // ---------- hook getUserMedia ----------
  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      const stream = await orig(constraints);
      try {
        const audio = stream.getAudioTracks();
        if (audio.length) startSnapDetector(stream);
        const vt = stream.getVideoTracks()[0];
        if (!vt) return stream;
        const proc = createProcessor(vt);
        currentProcessor = proc;
        setTimeout(() => toast(`Vanish Cam ready: ${MOD}+B = background, ${MOD}+V = vanish`), 500);
        return new MediaStream([proc.track, ...audio]);
      } catch (e) {
        console.error('[VanishCam] failed, falling back to real stream', e);
        return stream;
      }
    };
  }

  // ---------- hotkeys (e.code => works on Mac Option key too) ----------
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return; // altKey = Option on Mac
    if (e.code === 'KeyB' && currentProcessor) {
      e.preventDefault();
      currentProcessor.startCapture();
    } else if (e.code === 'KeyV') {
      e.preventDefault();
      toggleVanish();
    }
  }, true);
})();