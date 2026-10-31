// Wave Style "Original": the PS3's own wave, drawn from the console's lines.qrc, through the
// port of moyou in this folder. The
// same controls as linkev's wave (wave.js drives either): the Background Color (a colour's
// gradient in place of the month maps), Month and Time Colors (the console's month maps and its
// time-of-day presets), the Wave and Sparkles Colors, Waves / Sparkles on or off, a picture
// behind (the wave and the sparkles as light over it), Still Waves, the FPS Cap, the focus /
// game power saving and controller motion; and the Wave and Sparkles Personalization settings
// both styles have (each one scales the console's value by how far it is from its default).

import { loadFiles } from "./files.js";
import { Params } from "./params.js";
import { Wave } from "./sim.js";
import { cachedWarmRope } from "./wavecache.js";
import { ParticleSystem } from "./particles.js";
import { Renderer } from "./renderer.js";
import { REAL_WAVE_DEFAULTS, COMPLEX_EXTRA_DEFAULTS, REAL_PARTICLE_DEFAULTS, resolveBackgroundGradient, introBg, screenCovered } from "../wavegl.js";

export const ORIGINAL_SHARED = new Set([
  "spline:flowSpeed", "spline:timeStep", "spline:tension", "spline:damping", "spline:length", "spline:spacing", "spline:perturbation",
  "spline:posY", "spline:tilt", "spline:thickness", "spline:opacity", "spline:brightness", "spline:fresnelScale",
  "spline:ffdScale1X", "spline:ffdScale1Y", "spline:ffdScale1Z", "spline:ffdScale2X", "spline:ffdScale2Y", "spline:ffdScale2Z",
  "spline:ffdOffsetX", "spline:ffdOffsetY", "spline:ffdOffsetZ",
  "spline:gradientPreset", "spline:bgTopR", "spline:bgTopG", "spline:bgTopB", "spline:bgBotR", "spline:bgBotG", "spline:bgBotB",
  "spline:bgAngle", "spline:bgSpan", "spline:bgCurve", "spline:gradientTopMul", "spline:gradientBotMul",
  "particle:count", "particle:opacity", "particle:sizeBase", "particle:flowSpeed",
]);

const D = { ...REAL_WAVE_DEFAULTS, ...COMPLEX_EXTRA_DEFAULTS }, PD = REAL_PARTICLE_DEFAULTS;
const ratio = (v, d) => (d ? (Number.isFinite(+v) ? +v : d) / d : 1);

// graphics safety limits (see the constructor and _watch)
const START_LIMIT = 15000, STALL_MS = 2500, SLOW_MS = 120, WATCH_MS = 6000, MIN_FPS = 10;

export class OriginalWave {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = { ...D };
    this.particleSettings = { ...PD };
    this.wavesEnabled = true; this.dotsEnabled = true; this.wallpaper = false; this.hidden = false;
    this.tint = [1, 1, 1]; this.waveAuto = true; this.dotRgb = [1, 1, 1]; this.autoColor = true; this.monthMode = true;
    this.running = false; this.ok = false; this.failed = false;
    this._loop = this._loop.bind(this);
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: "high-performance" });
    if (!gl) { this.failed = true; this.ready = Promise.reject(new Error("no WebGL2")); this.ready.catch(() => {}); return; }
    this.gl = gl;
    // Graphics safety (some drivers can't run this wave, or only very slowly):
    // the shaders are prepared in the background, and the wave gives up (and
    // linkev's is used instead) when the graphics context is lost, when it
    // isn't ready after START_LIMIT, or when its first frames stall (see _watch)
    this._lost = (e) => { e.preventDefault(); if (!this._destroyed) this._giveUp(new Error("the graphics context was lost")); };
    canvas.addEventListener("webglcontextlost", this._lost);
    const deadline = performance.now() + START_LIMIT;
    this._startT = setTimeout(() => { if (!this.ok && !this.failed) this._giveUp(new Error("the wave took too long to start")); }, START_LIMIT + 500);
    // (a missing or broken lines.qrc is marked .files: not the graphics card's fault)
    this.ready = loadFiles().catch((e) => { const x = e instanceof Error ? e : new Error(String(e)); x.files = true; throw x; }).then(async ({ archive, assets }) => {
      this.p = new Params(); this.p.load(archive);
      this.p.S.monthOverride = this.themeMonth ?? null;
      this.p.mod = new Map();
      if (this._overlay) this.p.setOverlay(this._overlay.name, this._overlay.files, 0);
      this.wave = new Wave();
      // (the rope's start, worked out away from the window while the graphics card gets ready)
      this._applyMods();
      const warm = cachedWarmRope(1, this.wave.prm(this.p));   // (the Wave Cache)
      this.r = new Renderer(gl); this.r.init(assets);
      if (assets.particles) {
        const tx = assets.particles.texture;
        this.ps = new ParticleSystem({ textureRGBA: tx.pixels, textureW: tx.width, textureH: tx.height, surfaceSampler: (i, j) => this.wave.surfaceWorld(i, j) });
        this.ps.initGL(gl, (vs, fs, l) => this.r.link(vs, fs, l), assets.particles);
      }
      await this.r.compiled(deadline);
      if (this.failed || this._destroyed) throw new Error("the wave was stopped while starting");
      this._applyMods();
      this.wave.loadState(1, this.p, await warm);
      if (this.failed || this._destroyed) throw new Error("the wave was stopped while starting");
      // (as the console's VSH does at boot: a clock tick right away, the presets fade in)
      this.p.forceTick();
      this.ok = true;
      clearTimeout(this._startT);
      // (running for a while without trouble, whatever the mode: fine on this computer)
      this._healthyT = setTimeout(() => { if (this.ok && !this.failed && !this._destroyed && (this._drawnOnce || this.hidden || !this.running)) this.onHealthy && this.onHealthy(); }, WATCH_MS + 1500);
      this._watchFrom = 0; this._slow = 0;
      this._resize();
      this._onResize = () => this._resize();
      window.addEventListener("resize", this._onResize);
      if (this.running) { this._prev = performance.now(); requestAnimationFrame(this._loop); }
    }).catch((e) => { clearTimeout(this._startT); this.failed = true; this.ok = false; console.error("Original wave unavailable:", e && e.message); throw e; });
  }
  _resize() {
    const rs = window.__xmbRenderScale || 0;
    const dpr = rs ? (window.devicePixelRatio || 1) * rs : Math.min(window.devicePixelRatio || 1, 2);
    // (never more lines than the display buffer's, at most the console's 1080:
    // the picture is stretched to the window either way, so a bigger canvas
    // (a high-DPI screen, a 4K resolution) only cost drawing and copying time)
    const w0 = window.innerWidth * dpr, h0 = window.innerHeight * dpr, k = Math.min(1, 1080 / Math.max(1, h0));
    const w = Math.max(1, Math.floor(w0 * k)), h = Math.max(1, Math.floor(h0 * k));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this._lpDirty = true; }
    this._applySize();
  }
  // The display buffer: the console's 1080 lines, or the system's own
  // resolution when it's lower (Display Settings > Resolution, never under
  // 540), always 16:9 like the console's picture
  _applySize() {
    if (!this.r || !this.r.ready) return;
    const base = Math.min(1080, Math.max(540, this.canvas.height || 1080));
    const h = Math.round(base / 2) * 2, w = Math.round(h * 16 / 9 / 2) * 2;
    try { this.r.setSize(w, h); } catch (e) { this._giveUp(e); }
  }
  // ---- theme controls (the same as linkev's RealWave)
  setBaseColor(rgb, isAuto) { this.autoColor = isAuto !== false; if (rgb) { this.settings.colorR = rgb.r; this.settings.colorG = rgb.g; this.settings.colorB = rgb.b; } }
  setWaveColor(rgb) { this.waveAuto = !rgb; this.tint = rgb ? [rgb.r / 255, rgb.g / 255, rgb.b / 255] : [1, 1, 1]; }
  setDotColor(rgb) { this.dotRgb = rgb ? [rgb.r / 255, rgb.g / 255, rgb.b / 255] : [1, 1, 1]; }
  // a screen's own preset from lines.qrc over the time of day (wave.js setOverlay)
  setOverlay(name, files = null, instant = false) {
    this._overlay = name ? { name, files } : null;
    if (this.p) { this.p.setOverlay(name, files, instant ? 0 : 1); this._lpDirty = true; }
  }
  setWavesEnabled(on) { this.wavesEnabled = on !== false; this._kick(); }
  setDotsEnabled(on) { this.dotsEnabled = on !== false; this._kick(); }
  setMonthMode(on) { this.monthMode = !!on; }
  // a PS3 theme's colour: that month's background (0-11), or null for today's
  setThemeMonth(m) { this.themeMonth = m == null ? null : m; if (this.p) this.p.S.monthOverride = this.themeMonth; }
  setWallpaper(on) { this.wallpaper = !!on; this._kick(); }
  setBgOff(on) { this.bgOff = !!on; }
  setHidden(h) { const was = this.hidden; this.hidden = !!h; if (was && !this.hidden) this._kick(); }
  // (shown again: drawn on the next frame, not after the idle wait)
  _kick() { if (this._sleepT && this.running && this.ok) { clearTimeout(this._sleepT); this._sleepT = 0; requestAnimationFrame(this._loop); } }
  setLowPower(level) { this.lowPower = level | 0; }
  setStill(on) { on = !!on; if (on === !!this.still) return; this.still = on; this._sig = null; }
  // Controller motion: the sparkles lean the way the controller moves (and settle back)
  setMotion(x, y) { this._motionT = [x || 0, y || 0]; if (!x && !y) this._motionV = 0; }
  addMotionImpulse(dv) { this._motionV = (this._motionV || 0) + dv; }
  _motionShift(dt) {
    const t = this._motionT || [0, 0], c = this._motionC || (this._motionC = [0, 0]);
    let v = this._motionV || 0;
    c[0] += v * dt; v *= Math.exp(-dt / 1.4); this._motionV = Math.abs(v) < 1e-4 ? 0 : v;
    c[0] *= Math.exp(-dt / 2.5);                       // (no wrap-around in 3D: the push eases back)
    c[1] += (t[1] - c[1]) * 0.12;
    return c;
  }
  _groupTarget(group) { return group === "particle" ? this.particleSettings : group === "spline" ? this.settings : null; }
  setParam(group, key, val) { const t = this._groupTarget(group); if (t && key in t) { t[key] = val; this._applyMods(); } }
  getParam(group, key) { const t = this._groupTarget(group); return t ? t[key] : undefined; }
  applyParams(map) { if (!map) return; for (const k in map) { const [g, key] = k.split(":"); const t = this._groupTarget(g); if (t && key in t) t[key] = map[k]; } this._applyMods(); }
  resetParams() {
    const { colorR, colorG, colorB } = this.settings;
    Object.assign(this.settings, D, { colorR, colorG, colorB });
    Object.assign(this.particleSettings, PD);
    this._applyMods();
  }
  // the shared Personalization settings as scales / shifts of the console's values
  _applyMods() {
    if (!this.p) return;
    const s = this.settings, q = this.particleSettings, m = this.p.mod;
    m.clear();
    const mulK = (key, r) => { if (Math.abs(r - 1) > 1e-9) m.set(key, [r, 0]); };
    const addK = (key, a) => { if (Math.abs(a) > 1e-9) m.set(key, [1, a]); };
    mulK("LINE1.TENSION", ratio(s.tension, D.tension));
    mulK("LINE1.DAMPING", ratio(s.damping, D.damping));
    mulK("LINE1.LENGTH", ratio(s.length, D.length));
    mulK("LINE1.SPACING", ratio(s.spacing, D.spacing));
    mulK("LINE1.PERTURBATION", ratio(s.perturbation, D.perturbation));
    mulK("LINE1.TIMESTEP", ratio(s.timeStep, D.timeStep));
    mulK("LINE1.BRIGHTNESS", ratio(s.opacity, D.opacity) * ratio(s.brightness, D.brightness));
    mulK("LINE1.FRESNEL", ratio(s.fresnelScale, D.fresnelScale));
    for (const a of ["X", "Y", "Z"]) {
      mulK("LINE1.FFD SCALE1 " + a, ratio(s["ffdScale1" + a], D["ffdScale1" + a]));
      mulK("LINE1.FFD SCALE2 " + a, ratio(s["ffdScale2" + a], D["ffdScale2" + a]));
      addK("LINE1.FFD OFFSET " + a, (+s["ffdOffset" + a] || 0) - D["ffdOffset" + a]);
    }
    const n = ratio(q.count, PD.count);
    mulK("PARTICLES.emit per frame", n);
    mulK("PARTICLES.global alpha", ratio(q.opacity, PD.opacity));
    const sz = ratio(q.sizeBase, PD.sizeBase);
    for (const k of ["size middle", "size near", "size far"]) mulK("PARTICLES." + k, sz);
    // (on screen, as linkev's: height, tilt and thickness of the whole wave)
    this.shape = { posY: (+s.posY || 0) - D.posY, tilt: (+s.tilt || 0) - D.tilt, thick: ratio(s.thickness, D.thickness) };
    this.waveSpeed = ratio(s.flowSpeed, D.flowSpeed);
    this.dotSpeed = ratio(q.flowSpeed, PD.flowSpeed);
    this.dotsOff = !(q.count > 0);
  }
  // what the background is: the month's own (Month and Time Colors), or a colour's gradient
  _look() {
    const month = this.monthMode && this.autoColor;
    const see = this.wallpaper || this.bgOff;
    return {
      gradient: month ? null : resolveBackgroundGradient(this.settings, this.autoColor, 1, false),
      bgLevel: see ? 0 : introBg(),
      flatBg: !month,
      transparent: see,
      waveRgb: (this.complexAuto ?? this.waveAuto) ? null : this.tint,
      dotRgb: this.dotRgb,
      waves: this.wavesEnabled,
      particles: this.dotsEnabled && !this.dotsOff,
    };
  }
  // the screen's height / tilt / thickness on the control points (clip space)
  _shapeCtrl() {
    const sh = this.shape;
    if (!sh || (!sh.posY && !sh.tilt && Math.abs(sh.thick - 1) < 1e-9)) return;
    const c = this.wave.ctrl;
    let mean = 0, n = 0;
    for (let i = 0; i < c.length; i += 4) if (c[i + 3] > 1e-6) { mean += c[i + 1] / c[i + 3]; n++; }
    mean = n ? mean / n : 0;
    for (let i = 0; i < c.length; i += 4) {
      const w = c[i + 3]; if (!(w > 1e-6)) continue;
      const x = c[i] / w, y = c[i + 1] / w;
      c[i + 1] = (mean + (y - mean) * sh.thick + sh.posY + x * sh.tilt) * w;
    }
  }
  // ---- the background on its own, read back now and then (the icons' and menus' colours)
  _bgPixels() {
    if (!this.ok) return null;
    if (this.p) this.p.advanceOverlay();
    const o = this.p && this.p.S.overlay;
    // (a screen's preset (the Music Player's Visualizer Wave) fading in or out
    // is part of the look: its colours aren't kept once it's gone)
    const ov = o ? [o.name, o.to, Math.round((o.k || 0) * 4)] : null;
    const now = performance.now(), key = JSON.stringify([this._look().gradient, this.monthMode, this.autoColor, ov, Math.floor(Date.now() / 30000)]);
    // (an update in the background already asked for: taken when it's ready)
    if (this._bgPend) {
      let px = null; try { px = this.r.backgroundPixelsTake(); } catch (e) { this._bgPend = null; }
      if (px && this._bgPend) { if (this._bgPend.key === key) { this._bgPx = px; this._bgKey = key; this._bgAt = now; } this._bgPend = null; }
    }
    if (this._bgPx && this._bgKey === key && now - this._bgAt < 5000) return this._bgPx;
    // Only the time of day moved on (same look, the half-minute changed, or
    // simply older than 5 s): the last colours are kept for now and the new
    // ones fetched without making the window wait on the graphics card. A
    // different look (a colour chosen) is read right away, as before.
    const sameLook = this._bgPx && this._bgKey && this._bgKey.slice(0, this._bgKey.lastIndexOf(",")) === key.slice(0, key.lastIndexOf(","));
    if (sameLook) {
      if (!this._bgPend) { try { if (this.r.backgroundPixelsStart(this.p, { ...this._look(), bgLevel: 1 })) this._bgPend = { key }; } catch (e) {} }
      if (this._bgPend) return this._bgPx;
    }
    try { this._bgPx = this.r.backgroundPixels(this.p, { ...this._look(), bgLevel: 1 }); } catch (e) { return this._bgPx || null; }
    this._bgKey = key; this._bgAt = now;
    return this._bgPx;
  }
  _bgEnds() {
    const px = this._bgPixels(); if (!px) return null;
    const row = (y) => { const c = [0, 0, 0]; for (let x = 0; x < 64; x++) for (let k = 0; k < 3; k++) c[k] += px[(y * 64 + x) * 4 + k] / 255 / 64; return c; };
    return [row(1), row(34)];
  }
  backgroundColor() {
    const e = this._bgEnds(); if (!e) return [0.3, 0.3, 0.3];
    const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    const [hi, lo] = lum(e[0]) >= lum(e[1]) ? e : [e[1], e[0]];
    return hi.map((v, i) => v * 0.7 + lo[i] * 0.3);
  }
  backgroundBright() {
    const e = this._bgEnds(); if (!e) return [0.5, 0.5, 0.5];
    const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
    return lum(e[0]) >= lum(e[1]) ? e[0] : e[1];
  }
  backgroundImage() {
    const px = this._bgPixels(); if (!px) return null;
    const c = document.createElement("canvas"); c.width = 64; c.height = 36;
    const ctx = c.getContext("2d"), img = ctx.createImageData(64, 36);
    img.data.set(px); for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    return c.toDataURL("image/png");
  }
  // ---- the loop (the same rules as linkev's: power saving, Still Waves, FPS Cap)
  start() {
    if (this.running) return;
    this.running = true;
    this.canvas.classList.add("show");
    this._resize();
    this._prev = performance.now();
    if (this.ok) requestAnimationFrame(this._loop);
  }
  stop() { this.running = false; this.canvas.classList.remove("show"); }
  // (after it was running: linkev's takes over through onFail)
  _giveUp(e) {
    if (this.failed && this._gaveUp) return;
    this._gaveUp = true; this.failed = true; this.ok = false;
    console.error("Original wave unavailable:", e && e.message);
    this.failReason = e && e.message;
    this.onFail && this.onFail(e);
  }
  // The first seconds of drawing, timed: a frame that holds up the window for
  // more than STALL_MS, or most frames coming further apart than SLOW_MS (the
  // graphics card can't keep up), and the wave gives up. Only while the window
  // is in use (not hidden, no power saving, no Still Waves).
  _watch(ms, gap, now) {
    if (this._watched) return;
    // (not drawing for real: the timing starts over when it is again)
    if (this.lowPower || this.still || this.hidden || document.hidden) { this._watchFrom = 0; return; }
    if (ms > STALL_MS) { this._giveUp(new Error(`a frame held up the window for ${Math.round(ms)} ms`)); return; }
    if (!this._watchFrom) { this._watchFrom = now; this._frames = 0; this._slow = 0; this._gapFrom = now; return; }
    this._frames++;
    if (gap > SLOW_MS) this._slow++;
    if (now - this._watchFrom > WATCH_MS) {
      const fps = this._frames / ((now - this._gapFrom) / 1000);
      // (under 10 frames a second: the computer can't run it)
      const slow = this._frames >= 4 && fps < MIN_FPS && !window.__xmbSkipFpsCheck;   // (the check off: automated tests on a software renderer)
      // (slow twice in a row: not just a busy moment, like the system starting up)
      if (slow && !this._strike) { this._strike = true; this._watchFrom = 0; return; }
      this._watched = true;
      if (slow) this._giveUp(new Error(`too slow on this graphics card (${fps.toFixed(1)} frames a second)`));
    }
  }
  destroy() {
    this._destroyed = true;
    clearTimeout(this._startT); clearTimeout(this._healthyT);
    if (this.canvas && this._lost) this.canvas.removeEventListener("webglcontextlost", this._lost);
    this.stop();
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    try { this.gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch (e) {}
  }
  _stillSig() {
    // (a preset fading in or out: drawn on every step of it)
    if (this.p) this.p.advance(0);
    const ov = this.p && this.p.S.overlay;
    return JSON.stringify([ov ? ov.name + Math.round(ov.k * 60) : "",this.settings, this.particleSettings, this.tint, this.dotRgb, this.waveAuto, this.autoColor, this.wavesEnabled,
      this.dotsEnabled, this.wallpaper, this.bgOff, this.hidden, this.monthMode, this.canvas.width, this.canvas.height, introBg(),
      Math.floor(Date.now() / 60000)]);
  }
  // nothing of it to see: hidden behind an item's own background, or over a
  // picture / PS3 theme background with the waves and the sparkles both off
  _idle() { return this.hidden || ((this.wallpaper || this.bgOff) && !this.wavesEnabled && !(this.dotsEnabled && !this.dotsOff)); }
  _loop(now) {
    if (!this.running || !this.ok) return;
    const lp = this.lowPower || 0, cov = screenCovered(), idle = this._idle();
    // (held still, or with nothing to show: drawn again only when something about it changes)
    if (lp || this.still || cov || idle) {
      this._prev = now;
      let draw = this._lpDirty;
      if ((this.still || idle) && !lp) { const sig = this._stillSig(); if (sig !== this._sig) { this._sig = sig; draw = true; } }
      if (draw && !cov) { this._lpDirty = false; this._frame(this._drawnOnce ? 0 : 1 / 60, true); }
      this._sleepT = setTimeout(() => { this._sleepT = 0; requestAnimationFrame(this._loop); }, lp >= 2 ? 1000 : 250);
      return;
    }
    this._sig = null;
    const cap = window.__xmbFpsCap || 0;
    if (cap) {
      if (this._due && now < this._due - 1) { requestAnimationFrame(this._loop); return; }
      const step = 1000 / cap;
      this._due = this._due && now - this._due < step ? this._due + step : now + step;
    } else this._due = 0;
    const gap = now - this._prev;
    const dt = Math.min(0.25, Math.max(0, gap / 1000));
    this._prev = now;
    const t0 = performance.now();
    this._frame(dt, false);
    // (the time this frame held up the window, and the time since the last one)
    this._watch(performance.now() - t0, gap, now);
    if (!this.ok) return;
    requestAnimationFrame(this._loop);
  }
  _frame(dt, still) {
    const gl = this.gl;
    if (this.hidden) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); if (window.__onWaveFrame) window.__onWaveFrame(this.canvas); return; }
    try {
      const p = this.p, look = this._look();
      // the clock: the console's month and time of day (by the local clock)
      p.advance(dt);
      // (the waves off: their rope isn't moved on, nothing of it is drawn)
      if (still) { this.wave.buildCtrl(p); }
      else if (this.wavesEnabled) this.wave.simulate(dt, p, this.waveSpeed ?? 1, false);
      if (still || this.wavesEnabled) this._shapeCtrl();   // (made again from the rope each time: never twice over the same)
      // the sparkles' camera, nudged by controller motion
      const sh = this._motionShift(dt), cam = this.r.pcam;
      const mv = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, sh[0] * 1.5, sh[1] * 1.5, -2, 1];
      const pc = { ...cam, modelview: Float32Array.from(mv), mvp: Float32Array.from(mulCM(PROJ, mv)) };
      this.r.bgInstant = !!still;
      this.r.render(still ? 0 : dt * (this.dotSpeed ?? 1), p, this.wave, this.ps, look, pc);
      this.r.present(this.canvas.width, this.canvas.height, look.transparent);
      this._drawnOnce = true;
      // (the background's colours fetched in the background: in use once they're ready)
      if (this._bgPend) { const had = this._bgAt; this._bgPixels(); if (this._bgAt !== had && window.__menuTint) window.__menuTint(); }
      // (the reactive glass icons bend this frame: glasslayer.js)
      if (window.__onWaveFrame) window.__onWaveFrame(this.canvas);
    } catch (e) {
      console.error("Original wave frame failed:", e && e.message);
      this.ok = false; this.failed = true;
      this.onFail && this.onFail(e);
    }
  }
}

// column-major 4x4 multiply (perspective(53, 16:9) * mv) for the sparkles' camera
const PROJ = (() => {
  const f = 1 / Math.tan(53 * Math.PI / 360), fa = 1000, n = 0.1, aspect = 16 / 9;
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0];
})();
function mulCM(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
