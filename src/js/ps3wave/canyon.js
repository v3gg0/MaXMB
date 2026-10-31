// The PS3 Music Player's Canyon visualizer (qgl_canyon_app, firmware 4.93), remade on WebGL2
// from the console's own canyon.qrc (its settings, presets, normal map and RSX programs,
// translated by rsx.js). The music's spectrum (spectrum.js) becomes a 128-value
// cross-section every frame; as the terrain moves forward each unit becomes a new line of a
// 128 x 128 ring of quads, drawn with canyon.vpo / canyon.fpo; then the depth of field
// (canyon_blur_ammount, 5 x canyon_layer_blur_blur, a 4-slice blur pyramid) and the
// feedback (canyon_layer_blur.fpo over the previous frame). The presets change like the
// console's (custom_render_plugin): a random group and preset, morphed in; on a new song
// the terrain starts again and the new preset comes in over 2 s.

import { Archive, parseMnu, decodeDds } from "./formats.js";
import { parseProgram, transpile } from "./rsx.js";
import { fetchPs3File } from "./files.js";

const FILES = ["CANYON_LINE", "CANYON_TERRAIN", "CANYON_BLUR", "CANYON_CAMERA", "CANYON_COLOUR", "CANYON_FOG"];
const W = 128, ROWS = 128, VF = 12;            // columns, rows, floats per vertex (pos, nrm, crd)
const STEP = 1 / 60;                           // the console's frame
const f32 = Math.fround;
const rnd = () => Math.random() * 2 - 1;       // (qgl_base's random: -1..1)

// custom_render_plugin's table (0x9c780): groups of { name, blend s, hold s }
const seq = (p, n, b, h, odd = {}) => Array.from({ length: n }, (_, i) => {
  const name = p + String(i + 1).padStart(2, "0");
  return { name, blend: odd[name]?.[0] ?? b, hold: odd[name]?.[1] ?? h };
});
const GROUPS = [
  seq("Bir_A", 4, 18, 20), seq("Bir_B", 4, 18, 20), seq("Bir_C", 4, 18, 20),
  seq("Voyage", 10, 12, 16, { Voyage02: [5, 7], Voyage08: [5, 7] }),
  seq("Volcano", 4, 18, 20), seq("Volvic", 5, 18, 20), seq("Blue", 4, 18, 20),
];

let _archive = null;
export function loadCanyon() {
  if (_archive) return _archive;
  _archive = (async () => {
    return Archive.fromBytes(await fetchPs3File("canyon.qrc"));
  })();
  _archive.catch(() => { _archive = null; });
  return _archive;
}
// (the Visualizers Cache let go: read again when next needed)
export function dropCanyon() { _archive = null; }

// ------------------------------------------------------------------ shaders
const PYRAMID = [0.5, 1, 2, 4];
const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 p;
out vec4 v_TEXCOORD0;
void main() { v_TEXCOORD0 = vec4(p * 0.5 + 0.5, 0.0, 1.0); gl_Position = vec4(p, 0.0, 1.0); }
`;
function rsx(archive, id) { return transpile(parseProgram(archive.file(id)), {}, id.split("/").pop()); }
function patch(src, from, to) {
  if (!src.includes(from)) throw new Error("canyon_layer_blur: unexpected program");
  return src.split(from).join(to);
}
// canyon_layer_blur reads the blur pyramid and the last frame upside down (the console's
// surfaces): here all of them are the screen's way up. Its pyramid is a 3D texture.
function layerBlurFP(src) {
  src = patch(src, "precision highp sampler2D;", "precision highp sampler2D;\nprecision highp sampler3D;");
  src = patch(src, "t = -((R2).yyyy) + (vec4(0.0, 1.0, 0.0, 0.0)).yyyy;", "t = (R2).yyyy;");
  src = patch(src, "t = -((R2).wwww) + (vec4(1.0, 0.0, 0.0, 0.0)).xxxx;", "t = (R2).wwww;");
  return patch(src, "texture(Tex, (R3).xy)", "texture(Tex, (R3).xyz)");
}

// ------------------------------------------------------------------ matrices (column-major)
function perspective(fovy, aspect, n, f) {
  const t = 1 / Math.tan(fovy / 2), o = new Float64Array(16);
  o[0] = t / aspect; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
  return o;
}
function lookAt(e, c, u) {
  let fx = c[0] - e[0], fy = c[1] - e[1], fz = c[2] - e[2];
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let sx = fy * u[2] - fz * u[1], sy = fz * u[0] - fx * u[2], sz = fx * u[1] - fy * u[0];
  const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;
  return Float64Array.of(sx, ux, -fx, 0, sy, uy, -fy, 0, sz, uz, -fz, 0,
    -(sx * e[0] + sy * e[1] + sz * e[2]), -(ux * e[0] + uy * e[1] + uz * e[2]), fx * e[0] + fy * e[1] + fz * e[2], 1);
}
function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

// ------------------------------------------------------------------ the visualizer
export class Canyon {
  constructor(canvas, archive) {
    this.canvas = canvas; this.archive = archive;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("WebGL2 isn't available");
    this.gl = gl;
    this._loadParams();
    this._initGL();
    this.resetTerrain();
    this.acc = 0; this.last = 0; this.raf = 0; this.spectrum = null;
  }

  // ---------------------------------------------------------------- settings and presets
  _mnu(prefix) {
    const m = new Map();
    for (const f of FILES) {
      const id = prefix + "canyon/" + f + ".mnu";
      if (!this.archive.contains(id)) continue;
      for (const e of parseMnu(this.archive.text(id))) m.set(f + "." + e.name, e.value);
    }
    return m;
  }
  _loadParams() {
    this.base = this._mnu("");
    this.cur = new Map(this.base); this.from = new Map(this.base); this.to = new Map(this.base);
    this.mt = 0; this.md = 0;
    this.group = -1; this.next = Infinity; this.clock = 0;
  }
  P(k) { const v = this.cur.get(k); return v === undefined ? 0 : v; }
  // custom_render's preset change: a random group (never the same one twice running),
  // a random preset in it, morphed in over `secs`; the next one after its hold time
  _pickPreset(secs) {
    let g = Math.floor(Math.random() * (GROUPS.length - 1));
    if (this.group >= 0 && g >= this.group) g++;
    if (this.group < 0) g = Math.floor(Math.random() * GROUPS.length);
    this.group = g;
    const list = GROUPS[g].filter((p) => this.archive.contains("override/" + p.name + "/canyon/CANYON_LINE.mnu"));
    const p = list[Math.floor(Math.random() * list.length)];
    if (!p) return;
    const t = new Map(this.base);
    for (const [k, v] of this._mnu("override/" + p.name + "/")) t.set(k, v);
    this.from = new Map(this.cur); this.to = t; this.mt = 0; this.md = secs ?? p.blend;
    if (this.md <= 0) this.cur = new Map(t);
    this.preset = p.name;
    this.next = this.clock + p.hold;
  }
  _morph(dt) {
    this.clock += dt;
    if (this.clock >= this.next) this._pickPreset();
    if (this.mt >= this.md) return;
    this.mt = Math.min(this.md, this.mt + dt);
    const s = this.mt / this.md;
    for (const [k, b] of this.to) { const a = this.from.has(k) ? this.from.get(k) : b; this.cur.set(k, a + (b - a) * s); }
  }
  // a new song: the terrain starts again, the next preset comes in over 2 s
  newTrack() { this.resetTerrain(); this._pickPreset(2); }

  // ---------------------------------------------------------------- terrain (fn_3ef0, FUN_943c, FUN_61cc)
  resetTerrain() {
    this.T210 = -10; this.T218 = 0; this.slot = 0;
    this.Z = new Float32Array(ROWS);
    this.vel = new Float32Array(W); this.row294 = new Float32Array(W); this.row = new Float32Array(W);
    // lines: x, y, z, h, nx, ny, nz, nw
    this.P230 = new Float32Array(W * 8); this.P244 = new Float32Array(W * 8); this.P258 = new Float32Array(W * 8);
    for (let i = 0; i < W; i++) for (const [P, z] of [[this.P230, 0], [this.P244, 0.5], [this.P258, 1]]) {
      P[i * 8] = i - 64; P[i * 8 + 2] = z;
    }
    const v = this.vb || (this.vb = new Float32Array(ROWS * W * 4 * VF));
    const lp = (c) => { const a = Math.abs(c * -0.0078125 + 0.5) * 2; return a * a * -50; };
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < W; i++) {
      const w = rnd() * 500, o = (j * W + i) * 4 * VF;
      const vert = (k, x, z, cx, cy) => {
        const q = o + k * VF;
        v[q] = x; v[q + 1] = 0; v[q + 2] = z; v[q + 3] = 0;
        v[q + 4] = 0; v[q + 5] = 1; v[q + 6] = 0; v[q + 7] = rnd() * Math.PI;
        v[q + 8] = cx; v[q + 9] = cy; v[q + 10] = lp(i) + j; v[q + 11] = w;
      };
      vert(0, i - 64, j, i / 127, j / 127); vert(1, i + 1 - 64, j, (i + 1) / 127, j / 127);
      vert(2, i + 1 - 64, j + 1, (i + 1) / 127, (j + 1) / 127); vert(3, i - 64, j + 1, i / 127, (j + 1) / 127);
    }
    if (this.gl) { const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, v); }
  }
  // one frame of the terrain (FUN_d188 + FUN_943c): `L`, `R` the 256-band spectrum
  _step(dt, L, R) {
    const row = this.row, Wt = this.P("CANYON_TERRAIN.TERRAIN WIDTH");
    for (let i = 0; i < 64; i++) {
      row[i] = L[Math.trunc(f32(i * (1 / 64)) * 255)] || 0;
      row[64 + i] = R[Math.trunc(f32(i * (1 / 64)) * -255 + 255)] || 0;
    }
    let mx = 1;
    for (let i = 0; i < W; i++) {
      row[i] *= Math.exp((Math.abs(0.5 - i / 128) * -2) * Wt + Wt);
      if (row[i] > mx) mx = row[i];
    }
    for (let i = 0; i < W; i++) this.row294[i] = row[i] / mx;
    this.T210 += dt * this.P("CANYON_CAMERA.POS SPEED");
    if (this.T218 < this.T210) { this.T218 += 1; this._commit(); }
    if (this.T210 > 99) this._rebase();
  }
  _commit() {
    const P230 = this.P230, P244 = this.P244, P258 = this.P258, vel = this.vel, r = this.row294;
    const x0 = this.P("CANYON_TERRAIN.TERRAIN SLIDE") * -0.25 - 64;
    const VH = this.P("CANYON_TERRAIN.VALLEY HEIGHT"), VC = this.P("CANYON_TERRAIN.VALLEY CENTRE");
    const VW = this.P("CANYON_TERRAIN.VALLEY WIDTH"), VS = this.P("CANYON_TERRAIN.VALLEY SHARP");
    for (let i = 0; i < W; i++) {
      const d = (i * 0.0078125 - 0.5) * 2;
      const s = Math.min(1, Math.max(0, (Math.abs(d - VC) - VW) * VS));
      const h = s * s * (s * -2 + 3) * VH + r[i] + (rnd() * 0.5 + 0.5) * 0.02;
      r[i] = 0;
      const damp = Math.abs(d * 0.295) + 0.7;
      vel[i] += (h - P244[i * 8 + 1]) * (1 - damp);
      P258[i * 8] = i + x0; P258[i * 8 + 1] = P244[i * 8 + 1] + vel[i]; P258[i * 8 + 2] = 1; P258[i * 8 + 3] = h;
      vel[i] *= damp * 0.5;
    }
    for (let pass = 0; pass < 5; pass++) for (let i = 0; i < W; i++) {
      const y = P258[i * 8 + 1], a = P258[Math.max(0, i - 1) * 8 + 1], b = P258[Math.min(W - 1, i + 1) * 8 + 1];
      P258[i * 8 + 1] = (y * -2 + a + b) * 0.25 + y;
    }
    for (let i = 0; i < W; i++) { P230[i * 8 + 2] = 0; P244[i * 8 + 2] = 0.5; }
    // normals of the line before: cross(its neighbours' difference, the next line minus the last)
    for (let i = 0; i < W; i++) {
      const a = Math.max(0, i - 1) * 8, b = Math.min(W - 1, i + 1) * 8, o = i * 8;
      const ax = P244[a] - P244[b], ay = P244[a + 1] - P244[b + 1], az = P244[a + 2] - P244[b + 2];
      const bx = P258[o] - P230[o], by = P258[o + 1] - P230[o + 1], bz = P258[o + 2] - P230[o + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const l = Math.hypot(nx, ny, nz) || 1;
      P244[o + 4] = nx / l; P244[o + 5] = ny / l; P244[o + 6] = nz / l;
    }
    // the ring's next line: the last line (P230) at Z, the line before (P244) at Z + 1
    const slot = this.slot, z1 = this.T218 + 128, z0 = z1 - 1, v = this.vb;
    this.Z[slot] = z0;
    for (let k = 0; k < W; k++) {
      const c = Math.abs(k * -0.0078125 + 0.5) * 2, cz = c * c * -50 + z1, cw = rnd() * 500;
      const a = k * 8, b = Math.min(W - 1, k + 1) * 8, o = (slot * W + k) * 4 * VF;
      const put = (q, P, p, z) => {
        v[q] = P[p]; v[q + 1] = P[p + 1]; v[q + 2] = z; v[q + 3] = P[p + 3];
        v[q + 4] = P[p + 4]; v[q + 5] = P[p + 5]; v[q + 6] = P[p + 6];
        v[q + 10] = cz; v[q + 11] = cw;
      };
      put(o, P230, a, z0); put(o + VF, P230, b, z0); put(o + 2 * VF, P244, b, z1); put(o + 3 * VF, P244, a, z1);
    }
    const gl = this.gl, off = slot * W * 4 * VF;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, off * 4, v, off, W * 4 * VF);
    this.P230 = P244; this.P244 = P258; this.P258 = P230;
    this.slot = (slot + 1) & (ROWS - 1);
  }
  // (fn_2ff0) everything moved back, so the numbers stay small
  _rebase() {
    const d = Math.floor(this.T210), v = this.vb;
    this.T210 -= d; this.T218 -= d;
    for (let j = 0; j < ROWS; j++) this.Z[j] -= d;
    for (let q = 0; q < v.length; q += VF) { v[q + 2] -= d; v[q + 10] -= d; }
    const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, v);
  }

  // ---------------------------------------------------------------- GL
  _prog(vs, fs) {
    const gl = this.gl, sh = (t, s) => {
      const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
      if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error("Canyon: shader: " + gl.getShaderInfoLog(o));
      return o;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("Canyon: program: " + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i), name = a.name.replace(/\[0\]$/, ""); u[name] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  _tex(target = this.gl.TEXTURE_2D, wrap = this.gl.CLAMP_TO_EDGE) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(target, t);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    return t;
  }
  _initGL() {
    const gl = this.gl, A = this.archive;
    this.pTerrain = this._prog(rsx(A, "lib/canyon/canyon.vpo"), rsx(A, "lib/canyon/canyon.fpo"));
    this.pAmount = this._prog(rsx(A, "lib/canyon/canyon_blur_ammount.vpo"), rsx(A, "lib/canyon/canyon_blur_ammount.fpo"));
    this.pBlur = this._prog(QUAD_VS, rsx(A, "lib/canyon/canyon_layer_blur_blur.fpo"));
    this.pLayer = this._prog(QUAD_VS, layerBlurFP(rsx(A, "lib/canyon/canyon_layer_blur.fpo")));
    // the terrain's ring: 128 rows x 128 quads, as triangles
    this.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, ROWS * W * 4 * VF * 4, gl.DYNAMIC_DRAW);
    const idx = new Uint16Array(ROWS * W * 6);
    for (let q = 0; q < ROWS * W; q++) { const b = q * 4; idx.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6); }
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    for (const [loc, off] of [[0, 0], [2, 16], [8, 32]]) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, VF * 4, off); }
    this.qvao = gl.createVertexArray(); gl.bindVertexArray(this.qvao);
    const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // the normal map, the colour LUT (512 x 1) and the noise (128 x 128)
    const nm = decodeDds(A.file("canyon/textures/DDS/canyon_normalmap.dds"));
    this.tNormal = this._tex(gl.TEXTURE_2D, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, nm.width, nm.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, nm.pixels);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    this.tLut = this._tex(); this.lut = new Float32Array(512 * 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 512, 1, 0, gl.RGBA, gl.FLOAT, this.lut);
    this.tNoise = this._tex(gl.TEXTURE_2D, gl.REPEAT);
    const nz = new Uint8Array(128 * 128 * 4); for (let i = 0; i < nz.length; i++) nz[i] = Math.random() * 256;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, nz);
    // the blur pyramid: 256 x 144 x 4 slices
    this.t3d = this._tex(gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 256, 144, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.dof = [0, 1].map(() => this._target(256, 144));
    this.w = this.h = 0;
  }
  // a colour texture with its framebuffer (and a depth buffer, `depth`; `samples`: multisampled, no texture)
  _target(w, h, depth = false, samples = 0) {
    const gl = this.gl, fb = gl.createFramebuffer(), o = { fb, w, h };
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (samples) {
      o.rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, o.rb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, o.rb);
    } else {
      o.tex = this._tex(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o.tex, 0);
    }
    if (depth) {
      o.db = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, o.db);
      if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
      else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, o.db);
    }
    return o;
  }
  _free(o) {
    if (!o) return; const gl = this.gl;
    gl.deleteFramebuffer(o.fb); if (o.tex) gl.deleteTexture(o.tex); if (o.rb) gl.deleteRenderbuffer(o.rb); if (o.db) gl.deleteRenderbuffer(o.db);
  }
  _resize() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    let w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    const k = Math.min(1, 1920 / w, 1080 / h); w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    if (w === this.w && h === this.h) return;
    c.width = w; c.height = h; this.w = w; this.h = h;
    for (const o of new Set([this.ms, this.S, this.F, this.B0, this.B1])) this._free(o);
    const gl = this.gl, samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
    this.S = this._target(w, h, !samples); this.F = this._target(w, h);
    this.ms = samples ? this._target(w, h, true, samples) : this.S;
    const bh = Math.max(1, Math.round(h * 512 / w));
    this.B0 = this._target(512, bh, true); this.B1 = this._target(512, bh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.F.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // ---------------------------------------------------------------- frame
  _drawTerrain() {
    const gl = this.gl, s = this.slot, n = W * 6;
    gl.bindVertexArray(this.vao);
    if (s < ROWS - 1) gl.drawElements(gl.TRIANGLES, (ROWS - 1 - s) * n, gl.UNSIGNED_SHORT, (s + 1) * n * 2);
    if (s >= 2) gl.drawElements(gl.TRIANGLES, (s - 1) * n, gl.UNSIGNED_SHORT, 0);
  }
  _common(pr, mvm, eye) {
    const gl = this.gl, u = pr.u, P = (k) => this.P(k), d = this.T210;
    gl.useProgram(pr.p);
    if (u.MVM) gl.uniform4fv(u.MVM, mvm);
    if (u.Eye) gl.uniform3f(u.Eye, eye[0], eye[1], eye[2]);
    if (u.Line) gl.uniform4f(u.Line, P("CANYON_LINE.LINE WIDTH"), P("CANYON_LINE.LINE HEIGHT"), P("CANYON_LINE.LINE LENGTH"), P("CANYON_LINE.LINE BIAS"));
    if (u.Time) gl.uniform3f(u.Time, d + P("CANYON_LINE.LINE AHEAD"), d + P("CANYON_CAMERA.TIME AHEAD"), d + 126.9);
    if (u.Scale) gl.uniform3f(u.Scale, P("CANYON_TERRAIN.SCALE X"), P("CANYON_TERRAIN.TERRAIN HEIGHT") * 0.3, 1);
  }
  _blurPass(src, dst, sx, sy) {
    const gl = this.gl, u = this.pBlur.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(this.pBlur.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(u.Tex, 0); gl.uniform2f(u.Step, sx, sy);
    gl.bindVertexArray(this.qvao); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  render() {
    const gl = this.gl, P = (k) => this.P(k);
    this._resize();
    const w = this.w, h = this.h, d = this.T210;
    // camera (FUN_50f4)
    const eye = [P("CANYON_CAMERA.POS X"), P("CANYON_CAMERA.POS Y"), P("CANYON_CAMERA.POS Z") + d];
    const tgt = [P("CANYON_CAMERA.TARGET X"), P("CANYON_CAMERA.TARGET Y"), P("CANYON_CAMERA.TARGET Z") + d];
    const m = mul(perspective(P("CANYON_CAMERA.ZOOM") * Math.PI / 180, w / h, 0.1, 10000), lookAt(eye, tgt, [0, 1, 0]));
    const mvm = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) mvm[r * 4 + c] = m[c * 4 + r];
    // the colour LUT (FUN_7438)
    const fade = P("CANYON_COLOUR.FADE COLOUR"), sc = P("CANYON_COLOUR.COLOUR SCALE"), bi = P("CANYON_COLOUR.COLOUR BIAS");
    const ex = [P("CANYON_COLOUR.COLOUR R"), P("CANYON_COLOUR.COLOUR G"), P("CANYON_COLOUR.COLOUR B")];
    for (let i = 0; i < 512; i++) {
      const t = Math.max(0, f32(i * -0.00195695 + 1));
      for (let k = 0; k < 3; k++) this.lut[i * 4 + k] = (Math.pow(t, ex[k]) * sc + bi) * fade;
      this.lut[i * 4 + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tLut);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 1, gl.RGBA, gl.FLOAT, this.lut);
    const fog = [P("CANYON_FOG.FOG R") * fade, P("CANYON_FOG.FOG G") * fade, P("CANYON_FOG.FOG B") * fade];

    // 1. the terrain (canyon.vpo / .fpo), multisampled, into S
    gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.CULL_FACE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ms.fb); gl.viewport(0, 0, w, h);
    gl.clearColor(fog[0], fog[1], fog[2], 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const pt = this.pTerrain, u = pt.u;
    this._common(pt, mvm, eye);
    gl.uniform1f(u.TexScale, P("CANYON_TERRAIN.TEXTURE SCALE"));
    gl.uniform1f(u.Fog_min, P("CANYON_FOG.FOG MIN"));
    gl.uniform1f(u.Fog_max_min, P("CANYON_FOG.FOG MAX") - P("CANYON_FOG.FOG MIN"));
    gl.uniform3f(u.FogColour, fog[0], fog[1], fog[2]);
    gl.uniform3f(u.LineColour, P("CANYON_COLOUR.LINE R") * fade, P("CANYON_COLOUR.LINE G") * fade, P("CANYON_COLOUR.LINE B") * fade);
    gl.uniform1f(u.BumpScale, P("CANYON_TERRAIN.BUMP SCALE"));
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tNormal); gl.uniform1i(u.NormalMap, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tLut); gl.uniform1i(u.FresLUT, 1);
    this._drawTerrain();
    if (this.ms !== this.S) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.ms.fb); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.S.fb);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }

    // 2. how blurred each pixel is (canyon_blur_ammount), then softened 5 times
    const B0 = this.B0, B1 = this.B1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, B0.fb); gl.viewport(0, 0, B0.w, B0.h);
    gl.clearColor(P("CANYON_BLUR.SKY BLUR"), 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const pa = this.pAmount;
    this._common(pa, mvm, eye);
    gl.uniform1f(pa.u.Focal_depth, P("CANYON_BLUR.FOCAL DEPTH"));
    gl.uniform1f(pa.u.Focus, 1 / (P("CANYON_BLUR.FOCAL VARIANCE") || 1e-6));
    this._drawTerrain();
    gl.disable(gl.DEPTH_TEST);
    let a = B0, b = B1;
    for (let i = 0; i < 5; i++) { this._blurPass(a.tex, b, 1 / B0.w, 1 / B0.h); [a, b] = [b, a]; }
    const amount = a.tex;

    // 3. the blur pyramid: slice 0 is the picture at 256 x 144 (4 taps a quarter texel apart, so
    //    it's averaged, not blurred), then each slice is the one before blurred 1, 2 and 4 texels
    //    wide (matched to the console's video: one step sharper than before, no ghost of blur)
    let src = this.S.tex, k = 0;
    for (let s = 0; s < 4; s++) {
      const dst = this.dof[k];
      const K = PYRAMID[s]; this._blurPass(src, dst, K / 256, K / 144);
      gl.bindTexture(gl.TEXTURE_3D, this.t3d);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, dst.fb);
      gl.copyTexSubImage3D(gl.TEXTURE_3D, 0, 0, 0, s, 0, 0, 256, 144);
      src = dst.tex; k ^= 1;
    }

    // 4. canyon_layer_blur over the picture: the blurred layers and the last frame
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.S.fb); gl.viewport(0, 0, w, h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const pl = this.pLayer, ul = pl.u, rot = P("CANYON_BLUR.FEEDBACK ROT");
    gl.useProgram(pl.p);
    gl.uniform1f(ul.LOD, P("CANYON_BLUR.LOD"));
    gl.uniform1f(ul.Feedback, P("CANYON_BLUR.FEEDBACK"));
    gl.uniform2f(ul.ResRecip, 1 / w, 1 / h);
    gl.uniform3f(ul.NoiseUV, rnd() * 0.5 + 0.5, rnd() * 0.5 + 0.5, 1 / 128);
    gl.uniform2f(ul.FeedbackScale, P("CANYON_BLUR.FEEDBACK X"), P("CANYON_BLUR.FEEDBACK Y"));
    gl.uniform2f(ul.FeedbackRot, Math.sin(rot), Math.cos(rot));
    const bind = (unit, target, t, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t); if (ul[name]) gl.uniform1i(ul[name], unit); };
    bind(0, gl.TEXTURE_2D, amount, "Screen"); bind(1, gl.TEXTURE_2D, this.F.tex, "Front");
    bind(2, gl.TEXTURE_2D, this.tNoise, "Noise1"); bind(3, gl.TEXTURE_3D, this.t3d, "Tex"); bind(4, gl.TEXTURE_2D, this.tNoise, "Noise2");
    gl.bindVertexArray(this.qvao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    for (let i = 0; i < 5; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); gl.bindTexture(gl.TEXTURE_3D, null); }
    gl.activeTexture(gl.TEXTURE0);

    // 5. the frame kept for the next one (ScreenCopy), and shown
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.S.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.F.fb);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // `spectrum`: an object whose read() gives { L, R } (256 bands each)
  start(spectrum) {
    this.spectrum = spectrum;
    if (this.raf) return;
    this.last = performance.now(); this.acc = 0;
    if (this.group < 0) this._pickPreset(2);
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000)); this.last = now;
      this.acc += dt;
      let n = 0;
      if (this.acc >= STEP) {
        const s = this.spectrum ? this.spectrum.read() : null, z = s ? null : new Float32Array(256);
        while (this.acc >= STEP && n < 4) { this._morph(STEP); this._step(STEP, s ? s.L : z, s ? s.R : z); this.acc -= STEP; n++; }
        if (n === 4) this.acc = 0;
      }
      // (drawn about 60 times a second, like the console, however fast the screen: a
      // faster one (or V-Sync off) doesn't redraw the same picture, and the blur's
      // trail fades at the console's pace)
      if (now - this._drawn < 12.5) return;
      this._drawn = now;
      try { this.render(); } catch (e) { console.warn("Canyon:", e); this.stop(); if (this.onError) this.onError(e); }
    };
    this._drawn = 0;
    this.raf = requestAnimationFrame(loop);
  }
  // (made ready while hidden: its programs compiled and its pictures made at the screen's
  // size by one drawing, then the last frame cleared, so showing it later is instant)
  prepare() {
    try {
      this.render();
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.F.fb); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } catch (e) {}
  }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  destroy() {
    this.stop();
    const ext = this.gl.getExtension("WEBGL_lose_context"); if (ext) ext.loseContext();
  }
}
