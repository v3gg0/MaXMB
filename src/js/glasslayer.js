// Icon Style "Default" (reactive Liquid Glass): the real background seen
// through each icon, bent like through a thick drop of glass, drawn on the
// graphics card.
//
// Every frame the wave is drawn (wave.js calls window.__onWaveFrame with its
// canvas), its picture is copied into a texture here; then, for every icon on
// screen, a small tile is drawn into one shared off-screen canvas: the
// background behind the icon magnified and pulled in at the rim (each colour a
// little apart), cut to the icon's shape, with the icon's own glass image over
// it. Each icon shows its tile in a small canvas inside it, so it fades,
// dims, moves and grows with the icon like the rest of it. Icons moving while
// the wave holds still are drawn again from the last wave picture.
//
// (This replaced a backdrop-filter with an SVG filter per icon, which the
// browser worked out on the processor for every icon in every frame.)

import { loadIconImage, loadedIcon } from "./iconshade.js";

// the lens: how much bigger what's behind looks, how far it's pulled in at
// the rim (of the icon's size) and how far apart the colours go there
const MAG = 1.7, EDGE = 0.24, ABER = 0.025, GLOW = 0.7;
// Icon Style Default: how filled in the glass is (0: Icon Style Glass, clear),
// and how bright its fill is
const BODY = 0.78, BODY_K = 1.0;
const ATLAS = 1536, TILE_MAX = 192;
const VIS_OPTS = { opacityProperty: true, visibilityProperty: true };
const CHECK_VIS = typeof Element !== "undefined" && typeof Element.prototype.checkVisibility === "function";

const VS = `#version 300 es
in vec2 aPos; out vec2 vL;
void main() { vL = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
uniform sampler2D uWave, uShade, uMap;
uniform vec4 uRect;      // the icon's box on screen (0..1, top left first)
uniform vec2 uBox;       // the icon's picture inside its box (letterboxed square: scale)
uniform float uMag, uEdge, uAber, uGlow, uHasWave, uSolid, uBody, uBodyK;
in vec2 vL; out vec4 o;
void main() {
  vec2 q = (vL - 0.5) / uBox + 0.5;                     // (the square picture's own coordinates)
  if (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) { o = vec4(0.0); return; }
  vec4 m = texture(uMap, q);
  vec4 s = texture(uShade, q);                          // the glass itself (straight alpha)
  float A = m.a;
  vec2 n = m.rg * 2.0 - 1.0;                            // the surface's tilt (x right, y down)
  float rim = m.b;
  vec3 c = vec3(0.0); float wa = 0.0;
  if (uHasWave > 0.5 && A > 0.002) {
    // magnified about the middle, and pulled in along the tilt at the rim
    vec2 L = 0.5 + (vL - 0.5) / uMag - n * uEdge * (0.35 + 0.65 * rim);
    vec2 p = uRect.xy + L * uRect.zw;
    vec2 ab = n * uAber * rim * uRect.zw;
    vec4 g = texture(uWave, p);
    c = vec3(texture(uWave, p - ab).r, g.g, texture(uWave, p + ab).b);
    wa = g.a;
  }
  // the glass over the bent background, both cut to the icon's shape
  // (premultiplied); the glass also gathers the light behind it, so the bright
  // wave shows brighter through it than around it, as on the console
  // (uSolid: an Icon Set with Transparency off: nothing seen through it)
  // (uBody: Icon Style Default: the glass filled in with its own pale colour,
  // nearly solid as on the console, the background still bent through it a
  // little; 0: Icon Style Glass, the clear glass)
  float see = (1.0 - uSolid) * (1.0 - 0.75 * uBody);
  float sa = mix(s.a, A, uBody);
  vec3 body = s.rgb * mix(1.0, uBodyK, uBody * (1.0 - s.a / max(A, 0.001)));
  float under = wa * A * (1.0 - 0.7 * sa) * see;
  vec3 rgb = body * sa * (1.0 - 0.45 * wa * A * see) + c * under + c * wa * A * sa * uGlow * see;
  o = vec4(min(rgb, vec3(1.0)), min(1.0, sa + under));
}`;

export class GlassLayer {
  constructor() {
    this.ok = false; this.on = false; this.body = BODY;
    this.els = document.getElementsByClassName("lg-live");
    this.shades = new Map();   // url -> { tex, used }
    this.maps = new Map();     // map id -> tex
    this._frame = 0; this._sig = "";
    this._loop = this._loop.bind(this);
    try { this._init(); this.ok = true; } catch (e) { console.warn("glass layer unavailable:", e && e.message); this.ok = false; }
  }
  _init() {
    const c = this.canvas = document.createElement("canvas");
    // (only as big as the icons on screen need: grown and shrunk with them, see _draw;
    // every icon's tile is copied out of it every frame, so a smaller one costs less)
    c.width = 256; c.height = 256; this._shrink = 0;
    const gl = this.gl = c.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("no WebGL2");
    const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = this.prog = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.bindAttribLocation(p, 0, "aPos"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.u = {};
    for (const n of ["uWave", "uShade", "uMap", "uRect", "uBox", "uMag", "uEdge", "uAber", "uGlow", "uHasWave", "uSolid", "uBody", "uBodyK"]) this.u[n] = gl.getUniformLocation(p, n);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.waveTex = this._tex(); this.hasWave = false;
    c.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.ok = false; this.stop(); });
  }
  _tex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  // Icon Style Default (true) or Glass (false, the clear glass)
  setFilled(on) { const b = on ? (window.__lgBody ?? BODY) : 0; if (b !== this.body) { this.body = b; this._sig = ""; } }
  // on: the Default icon style is in use (the layer draws); off: everything put back
  start() {
    if (!this.ok || this.on) return;
    this.on = true;
    window.__onWaveFrame = (canvas) => this._onWave(canvas);
    requestAnimationFrame(this._loop);
  }
  stop() {
    this.on = false;
    if (window.__onWaveFrame) window.__onWaveFrame = null;
    for (const el of [...document.querySelectorAll(".lg-on, .lg-live")]) this.detach(el);
    if (this.ok) { const gl = this.gl; for (const v of this.shades.values()) gl.deleteTexture(v.tex); for (const t of this.maps.values()) gl.deleteTexture(t); }
    this.shades.clear(); this.maps.clear(); this._sig = "";
  }
  // the icons' glass shapes were made again (Delete Icon Shading / All Cache):
  // the old ones let go
  forgetMaps() {
    if (this.ok) for (const t of this.maps.values()) this.gl.deleteTexture(t);
    this.maps.clear(); this._sig = "";
  }
  // an icon to draw: key (its picture's name), map (iconshade glassMap), url (its glass image)
  attach(el, map, url) {
    if (!this.ok || !map || !url) { this.detach(el); return; }
    el.__lg = { map, url, solid: el.classList.contains("cust-solid") }; el.__lgKey = null;
    el.classList.add("lg-live");
    this._sig = "";
  }
  detach(el) {
    if (!el) return;
    el.classList.remove("lg-live", "lg-on");
    el.__lgKey = null;
    if (el.__lgc) { el.__lgc.remove(); el.__lgc = null; }
    el.__lg = null;
  }
  // (from the wave's own frame: its picture is there to copy only now)
  _onWave(canvas) {
    if (!this.on) return;
    const gl = this.gl;
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // (the same size as last time: copied into the texture it has, not a new one)
      if (this._waveW === canvas.width && this._waveH === canvas.height) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      else { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas); this._waveW = canvas.width; this._waveH = canvas.height; }
      this.hasWave = canvas.width > 1;
      this._waveRect = canvas.getBoundingClientRect();
    } catch (e) { this.hasWave = false; }
    this._draw(true); this._waveDrew = true;
  }
  _loop() {
    if (!this.on) return;
    // (a game running, or power saving with the window out of focus: nothing
    // moves, so the icons are only looked at twice a second)
    const b = document.body.classList;
    if (b.contains("in-game") || b.contains("lowpower")) { setTimeout(() => requestAnimationFrame(this._loop), 500); return; }
    // (the wave's own frame already drew the icons for this one)
    if (this._waveDrew) this._waveDrew = false; else this._draw(false);
    requestAnimationFrame(this._loop);
  }
  _shadeTex(url) {
    let v = this.shades.get(url);
    if (v) { v.used = this._frame; return v.tex; }
    const img = loadedIcon(url);
    if (!img) { loadIconImage(url).then(() => { this._sig = ""; }).catch(() => {}); return null; }
    const gl = this.gl, tex = this._tex();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.shades.set(url, { tex, used: this._frame });
    return tex;
  }
  _mapTex(map) {
    let t = this.maps.get(map.id);
    if (t) return t;
    const gl = this.gl; t = this._tex();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, map.w, map.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, map.data);
    this.maps.set(map.id, t);
    return t;
  }
  // the shared canvas's size for w x h of tiles: grown at once (in steps of
  // 128, so a growing icon doesn't make a new one every frame), shrunk when
  // far too big for a while
  _fit(w, h) {
    const c = this.canvas, cw = Math.min(ATLAS, Math.ceil(w / 128) * 128), ch = Math.min(ATLAS, Math.ceil(h / 128) * 128);
    if (cw > c.width || ch > c.height) { c.width = Math.max(c.width, cw); c.height = Math.max(c.height, ch); this._shrink = 0; }
    else if (cw * ch * 2 < c.width * c.height) { if (++this._shrink > 120) { c.width = cw; c.height = ch; this._shrink = 0; } }
    else this._shrink = 0;
  }
  // force: a new wave picture (draw even if nothing moved)
  _draw(force) {
    if (!this.ok) return;
    this._frame++;
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1, dpr = Math.min(2, window.devicePixelRatio || 1);
    const items = [];
    let sig = "";
    for (const el of this.els) {
      const lg = el.__lg; if (!lg) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) { if (el.__lgc) el.__lgc.style.display = "none"; el.__lgKey = null; continue; }
      // (fully faded out, by itself or its row / column: nothing of it shows,
      // so it isn't drawn; it is again the moment it starts showing)
      if (CHECK_VIS && !el.checkVisibility(VIS_OPTS)) { sig += "h;"; el.__lgKey = null; continue; }
      items.push([el, r, lg]);
      sig += `${r.left | 0},${r.top | 0},${r.width | 0},${r.height | 0},${lg.url.length};`;
    }
    if (!force && sig === this._sig) return;
    this._sig = sig;
    if (!items.length) return;
    const gl = this.gl;
    // (the wave fills the window; a different box, e.g. while it's scaled: measured)
    const wr = this._waveRect && this._waveRect.width > 1 ? this._waveRect : { left: 0, top: 0, width: vw, height: vh };
    // A new wave picture: every icon is drawn again. Otherwise (icons moving
    // over a wave that holds still: Still Waves, power saving) only the ones
    // that moved, grew or changed picture; the others keep the glass they
    // have, as what's behind them is the same.
    // where each icon's tile goes (and its pictures, ready on the graphics card)
    let x = 0, y = 0, row = 0, needW = 0;
    const tiles = [];
    for (const [el, r, lg] of items) {
      const tw = Math.max(2, Math.min(TILE_MAX, Math.round(r.width * dpr))), th = Math.max(2, Math.min(TILE_MAX, Math.round(r.height * dpr)));
      const key = `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)},${tw},${th},${lg.url},${lg.solid ? 1 : 0},${wr.left.toFixed(1)},${wr.top.toFixed(1)},${wr.width.toFixed(1)},${wr.height.toFixed(1)}`;
      if (!force && el.__lgKey === key) { if (el.__lgc) el.__lgc.style.display = ""; continue; }
      if (x + tw > ATLAS) { x = 0; y += row; row = 0; }
      if (y + th > ATLAS) break;            // (more icons than fit: the rest keep their plain glass)
      const st = this._shadeTex(lg.url), mt = this._mapTex(lg.map);
      if (!st || !mt) continue;
      tiles.push([el, r, lg, st, mt, x, y, tw, th, key]);
      x += tw; row = Math.max(row, th); needW = Math.max(needW, x);
    }
    if (!tiles.length) return;
    this._fit(needW, y + row);
    const c = this.canvas, CH = c.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, c.width, CH);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog); gl.bindVertexArray(this.vao);
    gl.uniform1i(this.u.uWave, 0); gl.uniform1i(this.u.uShade, 1); gl.uniform1i(this.u.uMap, 2);
    gl.uniform1f(this.u.uMag, MAG); gl.uniform1f(this.u.uEdge, EDGE); gl.uniform1f(this.u.uAber, ABER); gl.uniform1f(this.u.uGlow, GLOW);
    gl.uniform1f(this.u.uHasWave, this.hasWave ? 1 : 0);
    gl.uniform1f(this.u.uBody, this.body); gl.uniform1f(this.u.uBodyK, window.__lgBodyK ?? BODY_K);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.waveTex);
    const drawn = [];
    for (const [el, r, lg, st, mt, tx, ty, tw, th, key] of tiles) {
      gl.viewport(tx, CH - ty - th, tw, th);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, st);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, mt);
      gl.uniform4f(this.u.uRect, (r.left - wr.left) / wr.width, (r.top - wr.top) / wr.height, r.width / wr.width, r.height / wr.height);
      // (the picture is a square letterboxed into the icon's box)
      const s = Math.min(r.width, r.height);
      gl.uniform2f(this.u.uBox, s / r.width, s / r.height);
      gl.uniform1f(this.u.uSolid, lg.solid ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      drawn.push([el, tx, ty, tw, th]); el.__lgKey = key;
    }
    for (const [el, sx, sy, tw, th] of drawn) {
      let c = el.__lgc;
      if (!c || c.parentNode !== el) {
        c = el.__lgc = document.createElement("canvas");
        c.className = "lg-canvas";
        el.appendChild(c);
      }
      if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
      c.style.display = "";
      const ctx = c.__ctx || (c.__ctx = c.getContext("2d"));
      ctx.clearRect(0, 0, tw, th);
      ctx.drawImage(this.canvas, sx, sy, tw, th, 0, 0, tw, th);
      if (!el.classList.contains("lg-on")) el.classList.add("lg-on");
    }
    // pictures no longer shown for a while: let go
    if (this._frame % 600 === 0) for (const [k, v] of this.shades) if (this._frame - v.used > 600) { gl.deleteTexture(v.tex); this.shades.delete(k); }
  }
}

let _layer = null;
export function glassLayer() { return _layer || (_layer = new GlassLayer()); }
