// Vanish Cam - runs in the page's MAIN world and wraps getUserMedia.
// Hotkeys:  Alt+Shift+B = capture background (3s countdown, step out of frame)
//           Alt+Shift+V = toggle vanish manually (for testing)
// Snap your fingers = toggle vanish.
(() => {
  if (window.__vanishCamInstalled) return;
  window.__vanishCamInstalled = true;

  const CFG = {
    maxWidth: 640,        // processing width (lower = faster)
    diffThreshold: 60,    // pixel difference vs background to count as "person"
    dilateRadius: 3,      // grows mask to cover edges/halo
    vanishMs: 1800,       // length of the dissolve effect
    captureDelayMs: 3000, // time to step out of frame
    captureFrames: 20,    // frames averaged for the background
    snapMinEnergy: 55,    // min high-freq energy (0-255) to count as snap
    snapRatio: 3.0,       // spike vs running average
    snapCooldownMs: 1500,
  };

  const state = { target: 0, progress: 0 }; // 0 = visible, 1 = vanished
  let currentProcessor = null;
  let lastSnap = 0;

  // ---------- tiny on-screen toast ----------
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
      toast('Pehle background capture karo: Alt+Shift+B');
      return;
    }
    state.target = state.target ? 0 : 1;
  }

  // ---------- snap detection (microphone, high-frequency spike) ----------
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

  // ---------- video processing ----------
  function dilate(src, tmp, dst, W, H, r) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let v = 0;
        const x0 = Math.max(0, x - r), x1 = Math.min(W - 1, x + r);
        for (let xx = x0; xx <= x1; xx++) if (src[row + xx]) { v = 1; break; }
        tmp[row + x] = v;
      }
    }
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        let v = 0;
        const y0 = Math.max(0, y - r), y1 = Math.min(H - 1, y + r);
        for (let yy = y0; yy <= y1; yy++) if (tmp[yy * W + x]) { v = 1; break; }
        dst[y * W + x] = v;
      }
    }
  }

  function createProcessor(videoTrack) {
    const s = videoTrack.getSettings();
    const srcW = s.width || 1280, srcH = s.height || 720;
    const scale = Math.min(1, CFG.maxWidth / srcW);
    const W = Math.round(srcW * scale), H = Math.round(srcH * scale);

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([videoTrack]);
    video.play().catch(() => {});

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // per-pixel dissolve threshold: random + left-to-right sweep
    const noise = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) noise[y * W + x] = Math.random() * 0.5 + (x / W) * 0.5;

    const raw = new Uint8Array(W * H);
    const tmp = new Uint8Array(W * H);
    const mask = new Uint8Array(W * H);

    let bg = null;           // Uint8ClampedArray RGBA
    let capture = null;      // { acc, count, startAt }
    let lastT = performance.now();

    function startCapture() {
      toast('Frame se bahar jao... 3 second');
      capture = { acc: null, count: 0, startAt: performance.now() + CFG.captureDelayMs };
    }

    function tick() {
      if (video.readyState < 2) return;
      const now = performance.now();
      const dt = now - lastT;
      lastT = now;

      ctx.drawImage(video, 0, 0, W, H);
      const frame = ctx.getImageData(0, 0, W, H);
      const d = frame.data;

      // background capture (averaged for less noise)
      if (capture && now >= capture.startAt) {
        if (!capture.acc) capture.acc = new Float32Array(W * H * 3);
        for (let i = 0, k = 0; i < W * H; i++, k += 3) {
          const j = i * 4;
          capture.acc[k] += d[j]; capture.acc[k + 1] += d[j + 1]; capture.acc[k + 2] += d[j + 2];
        }
        capture.count++;
        if (capture.count >= CFG.captureFrames) {
          bg = new Uint8ClampedArray(W * H * 4);
          for (let i = 0, k = 0; i < W * H; i++, k += 3) {
            const j = i * 4;
            bg[j] = capture.acc[k] / capture.count;
            bg[j + 1] = capture.acc[k + 1] / capture.count;
            bg[j + 2] = capture.acc[k + 2] / capture.count;
            bg[j + 3] = 255;
          }
          capture = null;
          toast('Background capture ho gaya. Ab snap karo!');
        }
      }

      // animate progress
      const dir = state.target > state.progress ? 1 : state.target < state.progress ? -1 : 0;
      state.progress = Math.min(1, Math.max(0, state.progress + dir * dt / CFG.vanishMs));

      if (bg && state.progress > 0) {
        for (let i = 0; i < W * H; i++) {
          const j = i * 4;
          const diff = Math.abs(d[j] - bg[j]) + Math.abs(d[j + 1] - bg[j + 1]) + Math.abs(d[j + 2] - bg[j + 2]);
          raw[i] = diff > CFG.diffThreshold ? 1 : 0;
        }
        dilate(raw, tmp, mask, W, H, CFG.dilateRadius);
        for (let i = 0; i < W * H; i++) {
          if (mask[i] && noise[i] < state.progress) {
            const j = i * 4;
            d[j] = bg[j]; d[j + 1] = bg[j + 1]; d[j + 2] = bg[j + 2];
          }
        }
      }
      ctx.putImageData(frame, 0, 0);
    }

    // setInterval (not rAF) so it keeps running if the tab is in background
    const timer = setInterval(tick, 1000 / 30);

    const outTrack = canvas.captureStream(30).getVideoTracks()[0];
    const origStop = outTrack.stop.bind(outTrack);
    outTrack.stop = () => {            // release the real camera when Meet stops us
      origStop();
      videoTrack.stop();
      clearInterval(timer);
      if (currentProcessor === api) currentProcessor = null;
    };

    const api = {
      track: outTrack,
      startCapture,
      hasBackground: () => !!bg,
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
        return new MediaStream([proc.track, ...audio]);
      } catch (e) {
        console.error('[VanishCam] failed, falling back to real stream', e);
        return stream;
      }
    };
  }

  // ---------- hotkeys ----------
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return;
    if (e.code === 'KeyB' && currentProcessor) currentProcessor.startCapture();
    if (e.code === 'KeyV') toggleVanish();
  });
})();
