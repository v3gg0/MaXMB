// The XMB wave frame on WebGL2: background (back_colours0), the wave sheet (lines1),
// LinesController, the HDR glare chain (GlareSourcePre, Copy, mips, Gaussian, AccGlare),
// ToneApplyDisplay (in the last pass, FS_PRESENT_GLARE) and the particles, every pass with the RSX program from lines.qrc. A port of
// moyou's render/renderer.cpp and its GLSL (github.com/sagemono/moyou, MIT License,
// (c) 2026 sagemono) for firmware 4.93 files, with MaXMB's additions: a custom background map
// (a Background Color), the wave without its background (a picture or video behind it), the
// wave's and the sparkles' colours, and the background on its own (for the icons' colour).

import { parseProgram, transpile, postParticleVP, postParticleFP } from "./rsx.js";
import { decodeDds, decodeTga } from "./formats.js";
import { mul, projection, view } from "./sim.js";

export const RES_W = 1920, RES_H = 1080;
const F = Math.fround;

// ------------------------------------------------------------------ GLSL
const RSX_LIB = `
vec4 rsx_q8(vec4 v) { return floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5) / 255.0; }
vec4 rsx_f16(vec4 v) { return vec4(unpackHalf2x16(packHalf2x16(v.xy)), unpackHalf2x16(packHalf2x16(v.zw))); }
int rsx_wrapi(int i, int n, int mode) { return mode == 1 ? ((i % n) + n) % n : clamp(i, 0, n - 1); }
vec4 rsx_texel(sampler2D s, ivec2 p, ivec2 n, ivec2 mode) {
  if ((mode.x == 5 && (p.x < 0 || p.x >= n.x)) || (mode.y == 5 && (p.y < 0 || p.y >= n.y))) return vec4(0.0);
  return texelFetch(s, ivec2(rsx_wrapi(p.x, n.x, mode.x), rsx_wrapi(p.y, n.y, mode.y)), 0);
}
vec4 rsx_bilerp(sampler2D s, vec2 uv, ivec2 mode) {
  ivec2 n = textureSize(s, 0);
  vec2 nf = vec2(n);
  if (mode.x == 5) uv.x = clamp(uv.x, 0.0, 1.0);
  if (mode.y == 5) uv.y = clamp(uv.y, 0.0, 1.0);
  if (mode.x == 3) uv.x = clamp(uv.x, 0.5 / nf.x, 1.0 - 0.5 / nf.x);
  if (mode.y == 3) uv.y = clamp(uv.y, 0.5 / nf.y, 1.0 - 0.5 / nf.y);
  vec2 p = uv * nf - 0.5;
  vec2 i = floor(p);
  vec2 f = floor((p - i) * 256.0) / 256.0;
  ivec2 i0 = ivec2(i);
  vec4 a = rsx_texel(s, i0, n, mode), b = rsx_texel(s, i0 + ivec2(1, 0), n, mode);
  vec4 c = rsx_texel(s, i0 + ivec2(0, 1), n, mode), d = rsx_texel(s, i0 + ivec2(1, 1), n, mode);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// The same filtering by the graphics card's own (much cheaper) bilinear filter:
// every surface and lookup texture is set to LINEAR, with CLAMP_TO_EDGE (mode 3)
// or REPEAT (mode 1) as its wrap; mode 5's border (the texels outside are 0) is
// the weight the edge texel keeps (only within half a texel of the edge)
vec4 rsx_hw(sampler2D s, vec2 uv, ivec2 mode) {
  vec2 nf = vec2(textureSize(s, 0));
  float k = 1.0;
  if (mode.x == 5) { uv.x = clamp(uv.x, 0.0, 1.0); k *= clamp(min(uv.x, 1.0 - uv.x) * nf.x + 0.5, 0.0, 1.0); }
  if (mode.y == 5) { uv.y = clamp(uv.y, 0.0, 1.0); k *= clamp(min(uv.y, 1.0 - uv.y) * nf.y + 0.5, 0.0, 1.0); }
  return texture(s, uv) * k;
}
vec4 rsx_aniso(sampler2D s, vec2 uv, float maxAniso, bool f16, ivec2 mode) {
  vec2 n = vec2(textureSize(s, 0));
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float la = length(dx * n), lc = length(dy * n);
  vec2 major = la >= lc ? dx : dy;
  float N = clamp(ceil(max(la, lc) / max(min(la, lc), 1e-6)), 1.0, maxAniso);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 16; i++) {
    if (float(i) >= N) break;
    vec4 v = rsx_hw(s, uv + major * ((float(i) + 0.5) / N - 0.5), mode);
    acc += f16 ? rsx_f16(v) : rsx_q8(v);
  }
  return acc / N;
}
vec4 rsx_gauss3(sampler2D s, vec2 uv, ivec2 mode) {
  ivec2 n = textureSize(s, 0);
  ivec2 c = ivec2(floor(uv * vec2(n)));
  vec4 acc = vec4(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++)
    acc += float((2 - abs(i)) * (2 - abs(j))) * rsx_texel(s, c + ivec2(i, j), n, mode);
  return acc / 16.0;
}
// rsx_gauss3 (mode 5) by four bilinear samples: each one on the corner between
// four texels averages them, and the four together weigh the 3 x 3 texels
// 1-2-1 x 1-2-1 / 16, exactly; the outermost texels (the border) the long way
vec4 rsx_gauss3hw(sampler2D s, vec2 uv) {
  ivec2 n = textureSize(s, 0), c = ivec2(floor(uv * vec2(n)));
  if (c.x <= 0 || c.y <= 0 || c.x >= n.x - 1 || c.y >= n.y - 1) return rsx_gauss3(s, uv, ivec2(5));
  vec2 r = 1.0 / vec2(n), b = vec2(c) * r;
  return 0.25 * (texture(s, b) + texture(s, b + vec2(r.x, 0.0)) + texture(s, b + vec2(0.0, r.y)) + texture(s, b + r));
}
`;
const VS_QUAD = `#version 300 es
layout(location = 0) in vec4 a_pos;
layout(location = 8) in vec4 a_tex;
out vec4 v_TEXCOORD0;
void main() { v_TEXCOORD0 = a_tex; gl_Position = vec4(a_pos.xy, 0.0, 1.0); }
`;
const WAVE_PRE = `
uniform highp sampler2D uCtrl;   // 19x19 control points after FFD + MVP (clip space)
vec4 bsB(float t) { float s = 1.0 - t, t2 = t * t, t3 = t2 * t;
  return vec4(s * s * s, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0; }
vec4 bsD(float t) { float s = 1.0 - t, t2 = t * t;
  return vec4(-s * s, 3.0 * t2 - 4.0 * t, -3.0 * t2 + 2.0 * t + 1.0, t2) * 0.5; }
float fadeF(float s) { return min(1.0, 10.0 * (0.5 - abs(0.5 - s))); }
`;
const WAVE_MAIN = `void main() {
  int I = gl_VertexID % 128, J = gl_VertexID / 128;
  int pi = I >> 3, pj = J >> 3;
  float tu = float(I & 7) * 0.125, tv = float(J & 7) * 0.125;
  vec4 bu = bsB(tu), bv = bsB(tv), du = bsD(tu), dv = bsD(tv);
  vec4 pos = vec4(0.0), Pu = vec4(0.0), Pv = vec4(0.0);
  for (int r = 0; r < 4; r++) {
    vec4 row = vec4(0.0), rowu = vec4(0.0);
    for (int c = 0; c < 4; c++) {
      vec4 C = texelFetch(uCtrl, ivec2(pi + c, pj + r), 0);
      row += bu[c] * C; rowu += du[c] * C;
    }
    pos += bv[r] * row; Pu += bv[r] * rowu; Pv += dv[r] * row;
  }
  a_oldpos = pos;
  a_oldnrm = vec4(cross(Pv.xyz, Pu.xyz), 0.0);
  a_oldcrd = vec4(float(J) / 127.0, fadeF(float(I) / 127.0) * fadeF(float(J) / 127.0), 0.0, 1.0);
  rsx_vp_main();
}`;
// the display buffer to the canvas (memory row 0 is the top of the screen). With uAlpha the
// background is black and the light becomes coverage (premultiplied: the wave and sparkles
// add their light to what's behind the canvas, as over the console's own background)
const FS_PRESENT = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform int uAlpha;
in vec4 v_TEXCOORD0; out vec4 o;
void main() {
  vec2 uv = vec2(v_TEXCOORD0.x, 1.0 - v_TEXCOORD0.y);
  vec3 c = texture(uTex, uv).rgb;
  if (uAlpha == 1) { float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0); o = vec4(a < 2.0 / 255.0 ? vec3(0.0) : c, a < 2.0 / 255.0 ? 0.0 : a); }
  else o = vec4(c, 1.0);
}`;
// The same, with the HDR glare added on the way (ToneApplyDisplay, done here
// instead of as its own full-screen pass into the display buffer: the same
// sum, as both only add light; the particles were added after it, which
// gives the same total). ToneApplyDisplay.fp: Glare * GlareWeight less an
// eighth of the noise, at the display buffer's own pixel (uRes; the noise by
// that pixel, rows counted from the top as on the RSX), not below 0.
const FS_PRESENT_GLARE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uTex, Glare, preexpose_Noise; uniform int uAlpha; uniform vec2 uRes; uniform float GlareWeight;
in vec4 v_TEXCOORD0; out vec4 o;
${"RSX_LIB_PLACEHOLDER"}
void main() {
  vec2 uv = vec2(v_TEXCOORD0.x, 1.0 - v_TEXCOORD0.y);
  ivec2 px = clamp(ivec2(floor(uv * uRes)), ivec2(0), ivec2(uRes) - 1);
  vec3 g = rsx_f16(rsx_hw(Glare, uv, ivec2(5))).rgb * GlareWeight;
  vec3 nz = texelFetch(preexpose_Noise, ivec2(px.x & 31, (int(uRes.y) - 1 - px.y) & 31), 0).rgb;
  vec3 add = clamp(g - nz * 0.125, 0.0, 1.0);
  vec3 c = min(texture(uTex, uv).rgb + add, vec3(1.0));
  if (uAlpha == 1) { float a = clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0); o = vec4(a < 2.0 / 255.0 ? vec3(0.0) : c, a < 2.0 / 255.0 ? 0.0 : a); }
  else o = vec4(c, 1.0);
}`;
// a Background Color's gradient into the background map (v: 0 = bottom of the screen)
const FS_GRAD = `#version 300 es
precision highp float;
in vec4 v_TEXCOORD0; out vec4 o;
uniform vec3 uStart, uEnd; uniform vec2 uDir; uniform float uTMin, uTSpan, uCurve, uAlpha;
void main() {
  vec2 yd = vec2(v_TEXCOORD0.x, 1.0 - v_TEXCOORD0.y);
  float t = dot(yd, uDir), u = clamp((t - uTMin) / max(uTSpan, 1e-6), 0.0, 1.0);
  float g = abs(uCurve - 1.0) < 1e-3 ? u * u * (3.0 - 2.0 * u) : 1.0 - pow(1.0 - u, uCurve);
  o = vec4(mix(uStart, uEnd, g), uAlpha);
}`;

function patchFP(src, o, label) {
  let s = src.replace(/layout\(location = ([1-3])\) out vec4 (o_COLOR\d);/g, "vec4 $2;");
  s = s.replace(/texture\((\w+), (.*?)\);/g, (m, name, coordFull) => {
    const rep = o.samplers && o.samplers[name];
    if (!rep) return m;
    let coord = coordFull;
    const rect = " / vec2(textureSize(" + name + ", 0))";
    if (coord.endsWith(rect)) coord = coord.slice(0, -rect.length);
    return rep + "(" + coord + ");";
  });
  for (const [a, b] of o.fix || []) {
    const p = s.indexOf(a);
    if (p < 0) throw new Error("shader patch did not apply (" + label + "): " + a);
    s = s.slice(0, p) + b + s.slice(p + a.length);
  }
  let pre = RSX_LIB + (o.helpers || "");
  const sig = "void main() {";
  if (s.indexOf(sig) < 0) throw new Error("no main() in " + label);
  if (o.wpos) {
    s = s.replace(/gl_FragCoord/g, "rsx_wpos");
    pre = "uniform float uRsxWinH;\nvec4 rsx_wpos;\n" + pre;
    const mp = s.indexOf(sig);
    s = s.slice(0, mp) + pre + "\nvoid rsx_main() {" + s.slice(mp + sig.length);
    s += "\nvoid main() { rsx_wpos = vec4(gl_FragCoord.x, uRsxWinH - gl_FragCoord.y, gl_FragCoord.zw); rsx_main(); }\n";
  } else {
    const mp = s.indexOf(sig);
    s = s.slice(0, mp) + pre + "\nvoid main() {" + s.slice(mp + sig.length);
  }
  return s;
}
function patchVP(src, attrsAsGlobals, pre, main) {
  let s = src;
  if (attrsAsGlobals) s = s.replace(/layout\(location = \d+\) in vec4 (a_\w+);[^\n]*/g, "vec4 $1;");
  const sig = "void main() {", p = s.indexOf(sig);
  if (p < 0) throw new Error("no main() in vertex program");
  return s.slice(0, p) + pre + "\nvoid rsx_vp_main() {" + s.slice(p + sig.length) + "\n" + main + "\n";
}

const IDENT_ZFLIP = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
const MVM = new Float32Array([2, 0, 0, -1, 0, 2, 0, -1, 0, 0, -1, 0, 0, 0, 0, 1]);
const _hf = new Float32Array(1), _hu = new Uint32Array(_hf.buffer);
function halfTrunc(x) {   // the VSH's float -> half: truncating mantissa, no denormals
  _hf[0] = x;
  const u = _hu[0];
  if (u === 0) return 0;
  let e = ((u >>> 23) & 0xff) - 112;
  if (e < 0) return 0;
  if (e > 31) e = 31;
  return ((e << 10) & 0x7c00) | ((u >>> 16) & 0x8000) | ((u >>> 13) & 0x3ff);
}
function gaussWeights(rIn) {   // 0x71260 / 0x70cec
  const r = F(rIn), half = Math.floor(F(r * 3)) - 1, w = [];
  let sum = 0;
  for (let i = 0; i <= 2 * half; i++) {
    const x = F(i - half), twoR = F(r + r), den = F(r * twoR), ex = F(F(-x * x) / den), num = F(Math.exp(ex));
    const v = F(num / F(r * 2.50662827));
    w.push(v); sum = F(sum + v);
  }
  const out = new Float32Array(8);
  for (let k = 0; k <= half && k < 8; k++) out[k] = F(w[half + k] / sum);
  return out;
}
function accWeights(GLin, spIn) {
  const GL = F(GLin), sp = F(spIn);
  let sum = 0;
  for (let k = 0; k < 6; k++) sum = F(sum + F(Math.pow(sp, k)));
  const out = new Float32Array(6);
  for (let k = 0; k < 6; k++) out[k] = F(F(F(F(Math.pow(sp, k)) / sum) * GL) * GL);
  return out;
}
const hermite = (t, m) => { const t2 = t * t, t3 = t2 * t; return (t3 - 2 * t2 + t) * m + (-2 * t3 + 3 * t2) + (t3 - t2) * m; };
function ss(a, b, x) {
  if (b <= a) return x >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Everything the renderer needs from lines.qrc, decoded and transpiled (throws on a bad file).
export function loadAssets(archive) {
  if (!archive.contains("lib/glutils/Gaussian.vpo")) throw new Error("only firmware 4.93 lines.qrc files are supported");
  const progs = {
    "back_colours0.fp": "lib/moyou/back_colours0.fpo", "Copy.fp": "lib/glutils/Copy.fpo",
    "back_colours1.fp": "lib/moyou/back_colours1.fpo", "back_colours2.fp": "lib/moyou/back_colours2.fpo",
    "lines1.vp": "lib/moyou/lines1.vpo", "lines1.fp": "lib/moyou/lines1.fpo",
    "LinesController.vp": "lib/moyou/LinesController.vpo", "LinesController.fp": "lib/moyou/LinesController.fpo",
    "Gaussian.vp": "lib/glutils/Gaussian.vpo", "Gaussian.fp": "lib/glutils/Gaussian.fpo", "AccGlare.fp": "lib/glutils/AccGlare.fpo",
    "GlareSourcePre.fp": "lib/glutils/GlareSourcePre.fpo",
  };
  const tr = (id) => transpile(parseProgram(archive.file(id)), {}, id.slice(id.lastIndexOf("/") + 1));
  const glsl = {};
  for (const [n, id] of Object.entries(progs)) glsl[n] = tr(id);
  const as = { glsl, months: [], fres: decodeTga(archive.file("textures/TGA/freslut1.tga")), particles: null };
  if (archive.contains("lib/particles/particles_quads.vpo")) {
    as.particles = {
      quadsVP: postParticleVP(tr("lib/particles/particles_quads.vpo")), quadsFP: postParticleFP(tr("lib/particles/particles_quads.fpo")),
      secondVP: postParticleVP(tr("lib/particles/particles_second.vpo")), secondFP: postParticleFP(tr("lib/particles/particles_second.fpo")),
      texture: decodeTga(archive.file("particles/proc_iridescent.tga")),
    };
  }
  for (let k = 0; k < 2; k++) for (let mo = 1; mo <= 12; mo++)
    as.months.push(decodeDds(archive.file(`textures/month_bg/${k ? "night" : "rgb"}/${String(mo).padStart(2, "0")}.dds`)));
  return as;
}

export class Renderer {
  constructor(gl) {
    this.gl = gl; this.ready = false; this._pending = [];
    // (the shaders are compiled in the background where the browser can: the
    // window never waits on the graphics driver; see compiled())
    try { this.khrParallel = gl.getExtension("KHR_parallel_shader_compile"); } catch (e) { this.khrParallel = null; }
  }
  // A program: compiling starts now; it's checked (and its uniforms looked up)
  // by compiled(), or the first time it's used
  link(vs, fs, label) {
    const gl = this.gl, R = this;
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, fs);
    const id = gl.createProgram();
    gl.attachShader(id, v); gl.attachShader(id, f); gl.linkProgram(id);
    const pr = { id, label, v, f, uniforms: null,
      loc(nm) { if (!this.uniforms) R._finish(this); return this.uniforms.has(nm) ? this.uniforms.get(nm) : null; } };
    this._pending.push(pr);
    return pr;
  }
  _finish(pr) {
    if (pr.uniforms) return;
    const gl = this.gl, i = this._pending.indexOf(pr);
    if (i >= 0) this._pending.splice(i, 1);
    if (!gl.getProgramParameter(pr.id, gl.LINK_STATUS)) {
      let log = gl.getProgramInfoLog(pr.id);
      for (const [sh, k] of [[pr.v, " vs"], [pr.f, " fs"]]) if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) log = "shader compile failed (" + pr.label + k + "): " + gl.getShaderInfoLog(sh);
      gl.deleteShader(pr.v); gl.deleteShader(pr.f); gl.deleteProgram(pr.id);
      pr.uniforms = new Map();
      throw new Error(log && log.startsWith("shader") ? log : "program link failed (" + pr.label + "): " + log);
    }
    gl.deleteShader(pr.v); gl.deleteShader(pr.f); pr.v = pr.f = null;
    const uniforms = new Map(), n = gl.getProgramParameter(pr.id, gl.ACTIVE_UNIFORMS);
    for (let k = 0; k < n; k++) {
      const info = gl.getActiveUniform(pr.id, k);
      let name = info.name;
      const loc = gl.getUniformLocation(pr.id, name);
      if (name.endsWith("[0]")) name = name.slice(0, -3);
      uniforms.set(name, loc);
    }
    pr.uniforms = uniforms;
  }
  // Every program linked so far, ready: waits (without holding up the window)
  // for the driver to finish them, then checks them, one per tick. Rejects on
  // a broken shader, a lost context, or when deadline (performance.now() ms)
  // passes first.
  async compiled(deadline = Infinity) {
    const gl = this.gl, ext = this.khrParallel;
    const tick = (ms) => new Promise((r) => setTimeout(r, ms));
    const check = () => {
      if (gl.isContextLost()) throw new Error("the graphics context was lost");
      if (performance.now() > deadline) throw new Error("the graphics driver took too long to prepare the wave");
    };
    if (ext) {
      while (this._pending.some((pr) => !gl.getProgramParameter(pr.id, ext.COMPLETION_STATUS_KHR))) { check(); await tick(25); }
    }
    while (this._pending.length) {
      check();
      this._finish(this._pending[0]);
      await tick(0);
    }
    check();
  }
  texture(w, h, ifmt, fmt, type, data, filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    return t;
  }
  surface(w, h, f16, linear) {
    const gl = this.gl;
    // (always LINEAR: the shaders filter with the graphics card's bilinear filter,
    // rsx_hw; texelFetch and same-size copies read them as before)
    const tex = this.texture(w, h, f16 ? gl.RGBA16F : gl.RGBA8, gl.RGBA, f16 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null, gl.LINEAR);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("a " + (f16 ? "half-float" : "RGBA8") + " render target is not supported");
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }
  // bgOnly: just what the background on its own needs (backgroundPixels), no 1080p buffers
  init(as, bgOnly = false) {
    const gl = this.gl;
    if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) throw new Error("no half-float render targets");
    const G = (n) => { if (!as.glsl[n]) throw new Error("missing program " + n); return as.glsl[n]; };
    this.progCopy = this.link(VS_QUAD, G("Copy.fp"), "Copy");
    // COLOUR SHADER 1 (procedural, _DayTime + _Alpha: the Music Player's) and 2 (writes only alpha)
    this.progBack1 = this.link(VS_QUAD, G("back_colours1.fp"), "back_colours1");
    this.progBack2 = this.link(VS_QUAD, G("back_colours2.fp"), "back_colours2");
    this.progBack = this.link(VS_QUAD, patchFP(G("back_colours0.fp"), { samplers: { MonthlyTex1Day: "S_M1D", MonthlyTex2Day: "S_M2D", MonthlyTex1Night: "S_M1N", MonthlyTex2Night: "S_M2N" }, helpers: `
vec4 S_M1D(vec2 uv) { return rsx_q8(rsx_bilerp(MonthlyTex1Day, uv, ivec2(3))); }
vec4 S_M2D(vec2 uv) { return rsx_q8(rsx_bilerp(MonthlyTex2Day, uv, ivec2(3))); }
vec4 S_M1N(vec2 uv) { return rsx_q8(rsx_bilerp(MonthlyTex1Night, uv, ivec2(3))); }
vec4 S_M2N(vec2 uv) { return rsx_q8(rsx_bilerp(MonthlyTex2Night, uv, ivec2(3))); }` }, "back_colours0"), "back_colours0");
    this.progGrad = this.link(VS_QUAD, FS_GRAD, "gradient");
    this.progLC = this.link(patchVP(G("LinesController.vp"), false, "", "void main() { rsx_vp_main(); gl_Position.y = -gl_Position.y; }"),
      patchFP(G("LinesController.fp"), { samplers: { Tex0: "S_Tex0", Back: "S_Back", preexpose_Noise: "S_Noise", preexpose_ExposeTex0: "S_Ex0", preexpose_ExposeTex1: "S_Ex1" }, helpers: `
vec4 S_Tex0(vec2 uv) { return rsx_q8(rsx_gauss3hw(Tex0, uv)); }
vec4 S_Back(vec2 uv) { return rsx_f16(rsx_hw(Back, uv, ivec2(3))); }
vec4 S_Noise(vec2 c) { ivec2 p = ivec2(floor(c)); return texelFetch(preexpose_Noise, ivec2(p.x & 31, p.y & 31), 0); }
vec4 S_Ex0(vec2 c) { return rsx_f16(rsx_hw(preexpose_ExposeTex0, c / 128.0, ivec2(5))).xyxy; }
vec4 S_Ex1(vec2 c) { return rsx_f16(rsx_hw(preexpose_ExposeTex1, c / 128.0, ivec2(5))).xyxy; }`, wpos: true }, "LinesController"), "LinesController");
    // quads in the RSX layout (pos at ATTR0, texcoord at ATTR8)
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, 1, 1, 1, 1, -1, 1, 0, 1]), gl.STATIC_DRAW);
    for (let k = 0; k < 2; k++) {   // vaoLC: oldpos = oldcrd in [0,1], _MVM maps to clip space
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, k ? 8 : 0);
      gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 2, gl.FLOAT, false, 16, 8);
      if (k) this.vaoLC = vao; else this.vaoQuad = vao;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.bgMap = this.surface(64, 32, true);
    this.bgSnap = this.surface(64, 32, true);
    this.bgTmp = this.surface(64, 32, true);
    this.small = this.surface(64, 36, false);   // the background on its own, read back now and then
    this.monthTex = as.months.map((m) => this.texture(m.width, m.height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, m.pixels));
    {
      const fr = as.fres, fres = new Uint8Array(fr.width * 4);
      for (let i = 0; i < fr.width; i++) { fres[i * 4] = fr.pixels[i * 4]; fres[i * 4 + 1] = fr.pixels[i * 4 + 1]; fres[i * 4 + 3] = 255; }
      this.fresTex = this.texture(fr.width, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, fres, gl.LINEAR);
    }
    {   // Stripes (0x4bad0): 16 x 4
      const st = new Uint8Array(16 * 4 * 4);
      for (let r = 0; r < 4; r++) for (let x = 0; x < 16; x++) {
        const q = r / 3, fx = x / 15 - 0.5;
        const v = Math.floor(Math.min(1, Math.pow(1.01 - 4 * fx * fx, 20 * q * q * q) * (0.5 + q / 2)) * 255);
        st.fill(v, (r * 16 + x) * 4, (r * 16 + x) * 4 + 4);
      }
      this.stripesTex = this.texture(16, 4, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, st, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);   // (mode 1 across)
    }
    {   // _Encode (0x4b928)
      const enc = new Uint8Array(4096 * 4);
      for (let i = 0; i < 4096; i++) {
        const y = F(F(F(i / 4095) * 32) * 4), ip = Math.floor(y), fr = F(y - ip);
        const b0 = Math.trunc(Math.min(255, Math.max(0, F(F(fr * 0.25) * 255))));
        const b1 = Math.trunc(Math.min(255, Math.max(0, F(F(ip * 0.015625) * 255))));
        enc[i * 4] = b0; enc[i * 4 + 1] = b1; enc[i * 4 + 2] = b0; enc[i * 4 + 3] = b1;
      }
      this.encodeTex = this.texture(4096, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, enc);
    }
    this.ctrlTex = this.texture(19, 19, gl.RGBA32F, gl.RGBA, gl.FLOAT, null);
    this.exTex0 = this.texture(128, 128, gl.RG16F, gl.RG, gl.HALF_FLOAT, null, gl.LINEAR);
    this.exTex1 = this.texture(128, 128, gl.RG16F, gl.RG, gl.HALF_FLOAT, null, gl.LINEAR);
    this.noiseTex = this.texture(32, 32, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.zeroTex = this.texture(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.noiseCounter = 0; this.bgShader = -1; this.hdrKey = "";
    const pv = mul(projection(), view());
    this.pcam = { mvp: Float32Array.from(pv), modelview: Float32Array.from(view()), fovy: 53 * Math.PI / 180, color: [1, 1, 1], gamma: 1 };
    if (!bgOnly) {
    const waveHelpers = `
vec4 S_Stripes(vec2 uv) { return rsx_q8(rsx_hw(Stripes, uv, ivec2(1, 3))); }
vec4 S_FresLUT(vec2 uv) { return rsx_q8(rsx_hw(FresLUT, uv, ivec2(3, 3))); }
vec4 S_Encode(vec2 uv) { return texelFetch(Encode, ivec2(clamp(int(floor(uv.x * 4096.0)), 0, 4095), 0), 0); }`;
    this.progWave = this.link(patchVP(G("lines1.vp"), true, WAVE_PRE, WAVE_MAIN),
      patchFP(G("lines1.fp"), { samplers: { Stripes: "S_Stripes", FresLUT: "S_FresLUT", Encode: "S_Encode" }, helpers: waveHelpers,
        // THINNESS = 1 in every preset makes this 0/0; NaN texture coordinates resolve to 0 on the RSX.
        fix: [["t = rsx_h(H0 / ((H0).wwww).x);", "t = rsx_h((H0).w == 0.0 ? vec4(0.0) : H0 / ((H0).wwww).x);"]] }, "lines1"), "lines1");
    this.progGSP = this.link(VS_QUAD, patchFP(G("GlareSourcePre.fp"), { samplers: { TexSamp: "S_TexSamp" },
      helpers: "vec4 S_TexSamp(vec2 uv) { return rsx_aniso(TexSamp, uv, 16.0, false, ivec2(3)); }" }, "GlareSourcePre"), "GlareSourcePre");
    this.progCopyAniso = this.link(VS_QUAD, patchFP(G("Copy.fp"), { samplers: { CopyTex: "S_CopyTex" },
      helpers: "vec4 S_CopyTex(vec2 uv) { return rsx_aniso(CopyTex, uv, 16.0, true, ivec2(5)); }" }, "Copy (aniso)"), "Copy (aniso)");
    const gaussFP = patchFP(G("Gaussian.fp"), { samplers: { TexSamp: "S_TexSamp" }, helpers: `
uniform int uGaussMode;
vec4 S_TexSamp(vec2 uv) {
  if (uGaussMode == 0) return rsx_f16(rsx_hw(TexSamp, uv, ivec2(5)));
  ivec2 n = textureSize(TexSamp, 0);
  return texelFetch(TexSamp, clamp(ivec2(floor(clamp(uv, 0.0, 1.0) * vec2(n))), ivec2(0), n - 1), 0);
}` }, "Gaussian");
    this.progGauss = this.link(patchVP(G("Gaussian.vp"), false, "", "void main() { rsx_vp_main(); }"), gaussFP, "Gaussian");
    this.progAcc = this.link(VS_QUAD, patchFP(G("AccGlare.fp"), { samplers: { TexSamp: "S_TexSamp" },
      helpers: "vec4 S_TexSamp(vec2 uv) { return rsx_f16(rsx_hw(TexSamp, uv, ivec2(5))); }" }, "AccGlare"), "AccGlare");
    this.progPresent = this.link(VS_QUAD, FS_PRESENT, "present");
    this.progPresentG = this.link(VS_QUAD, FS_PRESENT_GLARE.replace("RSX_LIB_PLACEHOLDER", RSX_LIB), "present (glare)");
    this.vaoWave = gl.createVertexArray();
    gl.bindVertexArray(this.vaoWave);
    const idx = new Uint16Array(127 * 127 * 6);
    let n = 0;
    for (let J = 0; J < 127; J++) for (let I = 0; I < 127; I++) {
      const a = J * 128 + I;
      idx[n++] = a; idx[n++] = a + 128; idx[n++] = a + 1; idx[n++] = a + 1; idx[n++] = a + 128; idx[n++] = a + 129;
    }
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    this.setSize(RES_W, RES_H);
    this.glsrc = this.surface(128, 540, true);
    this.acc = this.surface(128, 64, true);
    this.lvl = []; this.hb = []; this.vb = [];
    for (let k = 0, w = 128, h = 64; k < 7; k++, w >>= 1, h = Math.max(1, h >> 1)) {
      this.lvl.push(this.surface(w, h, true, true));
      if (k < 6) { this.hb.push(this.surface(w, h, true)); this.vb.push(this.surface(w, h, true)); }
    }
    }
    this.ready = true;
  }
  // The display buffer's size (the console's 1920 x 1080 by default; smaller on
  // a small window or a graphics card that can't keep up: original.js). The
  // RSX shaders work in the buffer's own pixels, so only the buffers change.
  setSize(w, h) {
    if (this.wave && this.W === w && this.H === h) return;
    const gl = this.gl;
    for (const t of [this.wave, this.main]) if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.tex); }
    this.W = w; this.H = h;
    this.wave = this.surface(w, h, false);
    this.main = this.surface(w, h, false, true);
  }
  buildHdrTables(Ein, Win, Tin) {   // 0x71794
    const gl = this.gl, E = F(Ein), W = F(Win), T = F(Tin), wsr = F(1 / F(W * W));
    const fH = new Uint16Array(128), gH = new Uint16Array(128);
    for (let i = 0; i < 128; i++) {
      const L = F(F(F(i / 127) * 16) * E);
      const y = F(F(1 / F(L + 1)) * F(L * F(wsr * L + 1)));
      fH[i] = halfTrunc(y);
      const g = F(F(F(y / Math.min(1, Math.max(0, y))) * F(y - T)) * 0.125);
      gH[i] = halfTrunc(Number.isNaN(g) ? F(-T * 0.125) : g);
    }
    const t0 = new Uint16Array(128 * 128 * 2), t1 = new Uint16Array(128 * 128 * 2);
    for (let r = 0; r < 128; r++) for (let c = 0; c < 128; c++) {
      const o = (r * 128 + c) * 2;
      t0[o] = fH[c]; t0[o + 1] = fH[r];
      t1[o] = fH[c]; t1[o + 1] = gH[Math.max(r, c)];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.exTex0); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RG, gl.HALF_FLOAT, t0);
    gl.bindTexture(gl.TEXTURE_2D, this.exTex1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 128, gl.RG, gl.HALF_FLOAT, t1);
    this.buildNoise();
  }
  buildNoise() {
    const gl = this.gl, jitter = F(1 / 255), nz = this._nz || (this._nz = new Uint8Array(32 * 32 * 4));
    for (let i = 0; i < 1024; i++) {
      this.noiseCounter = (this.noiseCounter + 1) | 0;
      let n = this.noiseCounter >>> 0;
      n = (n ^ (n << 13)) >>> 0;
      const a = (Math.imul(Math.imul(n, n), 15731) + 789221) | 0;
      const v = (Math.imul(n, a) + 1376312589) & 0x7fffffff;
      const x = F(F(F(F(F(v * -9.31322575e-10 + 1) * 0.5 + 0.5) * jitter)) * 8);
      const u = Math.trunc(Math.min(1, Math.max(-1, x)) * 255) & 0xff;
      nz[i * 4] = nz[i * 4 + 1] = nz[i * 4 + 2] = u; nz[i * 4 + 3] = 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, nz);
  }
  target(s) { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo); gl.viewport(0, 0, s.w, s.h); }
  bind(unit, tex) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); }
  quad(vao) { const gl = this.gl; gl.bindVertexArray(vao || this.vaoQuad); gl.drawArrays(gl.TRIANGLE_FAN, 0, 4); }
  copy(src, dst) {
    const gl = this.gl;
    this.target(dst); gl.useProgram(this.progCopy.id);
    this.bind(0, src.tex); gl.uniform1i(this.progCopy.loc("CopyTex"), 0);
    this.quad();
  }
  // background map: the month maps by the time of day, or `look.gradient` (a Background Color)
  passBackground(dt, p, look) {
    const gl = this.gl, clk = p.clk;
    const shader = Math.min(2, Math.max(0, Math.round(p.P("BACKGROUND.COLOUR SHADER"))));
    const key = look.gradient ? "grad:" + JSON.stringify(look.gradient) : "month:" + shader;
    if (this.bgKey !== undefined && key !== this.bgKey) { clk.snap = true; clk.fadeT = 0; clk.fadeDur = 2; }
    this.bgKey = key;
    if (clk.snap) { this.copy(this.bgMap, this.bgSnap); clk.snap = false; }
    this.copy(this.bgSnap, this.bgMap);
    // (Still Waves: no time goes by between its frames, so a new background is
    // shown at once instead of fading in, which would never happen)
    if (this.bgInstant) clk.fadeT = clk.fadeDur * 1.5;
    const t = clk.fadeT, tmax = clk.fadeDur;
    let alpha = 1;
    if (t !== tmax) { const s = Math.min(1, Math.max(0, t / tmax)); alpha = s * s * (3 - 2 * s); }
    if (t < tmax * 1.5) clk.fadeT = F(t + dt);
    this.drawBackground(this.bgMap, F(alpha), p, look);
  }
  // the background map for `look` into dst, blended in with alpha (1: replaces it)
  drawBackground(dst, alpha, p, look) {
    const gl = this.gl, clk = p.clk;
    this.target(dst);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (look.gradient) {
      const g = look.gradient, u = this.progGrad;
      gl.useProgram(u.id);
      gl.uniform3fv(u.loc("uStart"), g.startRgb); gl.uniform3fv(u.loc("uEnd"), g.endRgb); gl.uniform2fv(u.loc("uDir"), g.dir);
      gl.uniform1f(u.loc("uTMin"), g.tMin); gl.uniform1f(u.loc("uTSpan"), g.tSpan); gl.uniform1f(u.loc("uCurve"), g.curve ?? 1);
      gl.uniform1f(u.loc("uAlpha"), alpha);
      this.quad(); gl.disable(gl.BLEND);
      return;
    }
    const d = clk.dayFrac, mo = Math.min(12, Math.max(0, clk.month)), m = Math.floor(mo) % 12;
    const shader = Math.min(2, Math.max(0, Math.round(p.P("BACKGROUND.COLOUR SHADER"))));
    if (shader !== 0 && this.progBack1) {   // 0x52ad8: back_colours1 gets _DayTime = clamp(d,0,1)*41.6666679 (no DAYSPREAD)
      const u = shader === 1 ? this.progBack1 : this.progBack2;
      gl.useProgram(u.id);
      gl.uniform1f(u.loc("DayTime"), F(F(Math.min(1, Math.max(0, d))) * 41.6666679));
      gl.uniform1f(u.loc("Alpha"), alpha);
      this.quad(); gl.disable(gl.BLEND);
      return;
    }
    const nb = p.P("BACKGROUND.NIGHT BLEND");
    const ndb = (ss(p.P("BACKGROUND.NIGHT2DAY BEGIN") / 24, p.P("BACKGROUND.NIGHT2DAY END") / 24, d) *
      (1 - ss(p.P("BACKGROUND.DAY2NIGHT BEGIN") / 24, p.P("BACKGROUND.DAY2NIGHT END") / 24, d)) - 1) * nb + 1;
    const u = this.progBack;
    gl.useProgram(u.id);
    gl.uniform1f(u.loc("DayTime"), F(hermite(d, p.P("BACKGROUND.DAYSPREAD")) * 2400));
    gl.uniform1f(u.loc("NightTime"), F((d - 0.5 < 0 ? d + 0.5 : d - 0.5) * 2400));
    gl.uniform1f(u.loc("MonthTime"), F((mo - Math.floor(mo)) * 30));
    gl.uniform1f(u.loc("NightBrightness"), F(p.P("BACKGROUND.NIGHT WHIT BIAS")));
    gl.uniform1f(u.loc("NightDayBlend"), F(ndb));
    gl.uniform1f(u.loc("Alpha"), alpha);
    gl.uniform1f(u.loc("PI"), F(3.14159274));
    const tex = [["MonthlyTex1Day", m], ["MonthlyTex2Day", (m + 1) % 12], ["MonthlyTex1Night", 12 + m], ["MonthlyTex2Night", 12 + (m + 1) % 12]];
    tex.forEach(([nm, i], unit) => { this.bind(unit, this.monthTex[i]); gl.uniform1i(u.loc(nm), unit); });
    this.quad(); gl.disable(gl.BLEND);
  }
  passWave(p, wave, look) {
    const gl = this.gl;
    this.target(this.wave);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    if (!look.waves || Math.round(p.P("LINE1.STATE")) === 0 || Math.round(p.P("LINE1.SHADER")) !== 1) return;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.colorMask(true, true, false, false);
    const u = this.progWave;
    gl.useProgram(u.id);
    this.bind(0, this.ctrlTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 19, 19, gl.RGBA, gl.FLOAT, wave.ctrl);
    gl.uniform1i(u.loc("uCtrl"), 0);
    this.bind(1, this.stripesTex); gl.uniform1i(u.loc("Stripes"), 1);
    this.bind(2, this.fresTex); gl.uniform1i(u.loc("FresLUT"), 2);
    this.bind(3, this.encodeTex); gl.uniform1i(u.loc("Encode"), 3);
    gl.uniform1f(u.loc("MipmapBias"), F(p.P("LINE1.MIPMAP BIAS")));
    gl.uniform1f(u.loc("Brightness"), F(p.P("LINE1.BRIGHTNESS")));
    gl.uniform1f(u.loc("Fresnel"), F(p.P("LINE1.FRESNEL")));
    gl.uniform1f(u.loc("Spacing"), F(p.P("LINE1.SPACING")));
    gl.uniform1f(u.loc("Thinness"), F(p.P("LINE1.THINNESS")));
    gl.bindVertexArray(this.vaoWave);
    gl.drawElements(gl.TRIANGLES, 127 * 127 * 6, gl.UNSIGNED_SHORT, 0);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
  }
  // look.bgLevel: the background's brightness (0: black, for a picture behind); look.waveRgb:
  // the wave's colour instead of BACKGROUND 3 / 4 (null: the file's)
  passLinesController(p, look, dst, waveTex, backTex) {
    const gl = this.gl, u = this.progLC;
    this.target(dst);
    gl.useProgram(u.id);
    gl.uniform4fv(u.loc("MVM"), MVM);
    const k = look.bgLevel ?? 1;
    for (let c = 1; c <= 4; c++) {   // _Colour1 takes menu colour 2 and _Colour2 colour 1
      const n = "BACKGROUND." + (c <= 2 ? 3 - c : c) + " ";
      let rgb = [p.P(n + "RED"), p.P(n + "GREEN"), p.P(n + "BLUE")];
      // (look.flatBg: a Background Color's own gradient, shown as it is, not
      // tinted by the time of day's background colours)
      if (c <= 2) rgb = look.flatBg ? [k, k, k] : rgb.map((x) => x * k);
      else if (look.waveRgb) { const lvl = Math.max(rgb[0], rgb[1], rgb[2]); rgb = look.waveRgb.map((x) => x * lvl); }
      gl.uniform4f(u.loc("Colour" + c), F(rgb[0]), F(rgb[1]), F(rgb[2]), 1);
    }
    gl.uniform2f(u.loc("ScreenSizeRecip"), F(1 / dst.w), F(1 / dst.h));
    gl.uniform2f(u.loc("ScreenOffset"), 0.25, 0.25);
    gl.uniform1f(u.loc("Dither"), F(1 / 255));
    gl.uniform1f(u.loc("uRsxWinH"), dst.h);
    this.bind(0, waveTex.tex || waveTex); gl.uniform1i(u.loc("Tex0"), 0);
    this.bind(1, backTex || this.bgMap.tex); gl.uniform1i(u.loc("Back"), 1);
    this.bind(13, this.noiseTex); gl.uniform1i(u.loc("preexpose_Noise"), 13);
    this.bind(14, this.exTex1); gl.uniform1i(u.loc("preexpose_ExposeTex1"), 14);
    this.bind(15, this.exTex0); gl.uniform1i(u.loc("preexpose_ExposeTex0"), 15);
    this.quad(this.vaoLC);
  }
  // the glare's light, made ready for present() to add (FS_PRESENT_GLARE)
  passGlare(p) {
    if (Math.round(p.P("HDR.GLARE")) === 0) return;
    this.glareChain(p);
    this.glareReady = true;
  }
  glareChain(p) {
    const gl = this.gl, E = F(p.P("HDR.EXPOSURE")), W = F(p.P("HDR.WHITE LEVEL"));
    this.target(this.glsrc);
    gl.useProgram(this.progGSP.id);
    gl.uniform1f(this.progGSP.loc("Exposure"), E);
    gl.uniform1f(this.progGSP.loc("WhiteSqrRcp"), F(1 / F(W * W)));
    this.bind(0, this.main.tex); gl.uniform1i(this.progGSP.loc("TexSamp"), 0);
    this.quad();
    this.target(this.lvl[0]);
    gl.useProgram(this.progCopyAniso.id);
    this.bind(0, this.glsrc.tex); gl.uniform1i(this.progCopyAniso.loc("CopyTex"), 0);
    this.quad();
    for (let k = 1; k < 7; k++) this.copy(this.lvl[k - 1], this.lvl[k]);
    const wr = gaussWeights(p.P("HDR.GAUSSIAN RAD R")), wg = gaussWeights(p.P("HDR.GAUSSIAN RAD G")), wb = gaussWeights(p.P("HDR.GAUSSIAN RAD B"));
    const u = this.progGauss;
    gl.useProgram(u.id);
    gl.uniform4fv(u.loc("ModelviewProjection"), IDENT_ZFLIP);
    for (let k = 0; k < 8; k++) gl.uniform4f(u.loc("Weights" + k), wr[k], wg[k], wb[k], 0);
    gl.uniform1i(u.loc("TexSamp"), 0);
    for (let k = 0; k < 6; k++) {
      const d = this.hb[k];
      this.target(d); this.bind(0, this.lvl[k].tex);
      gl.uniform1i(u.loc("uGaussMode"), k === 0 ? 0 : 1);
      gl.uniform2f(u.loc("Offset"), F(1 / d.w), 0);
      this.quad();
    }
    for (let k = 0; k < 6; k++) {
      const d = this.vb[k];
      this.target(d); this.bind(0, this.hb[k].tex);
      gl.uniform1i(u.loc("uGaussMode"), 0);
      gl.uniform2f(u.loc("Offset"), 0, F(1 / d.h));
      this.quad();
    }
    this.target(this.acc);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.progAcc.id);
    gl.uniform1i(this.progAcc.loc("TexSamp"), 0);
    const aw = accWeights(p.P("HDR.GLARE LEVEL"), p.P("HDR.GLARE SUM POW"));
    for (let k = 5; k >= 0; k--) { this.bind(0, this.vb[k].tex); gl.uniform1f(this.progAcc.loc("Weight"), aw[k]); this.quad(); }
    gl.disable(gl.BLEND);
  }
  hdrBegin(p) {
    const key = [F(p.P("HDR.EXPOSURE")), F(p.P("HDR.WHITE LEVEL")), F(p.P("HDR.GLARE THRESH"))].join(",");
    const hdrOn = Math.round(p.P("HDR.ENABLED")) !== 0;
    if (hdrOn || !this.hdrKey) {
      if (key !== this.hdrKey) { this.hdrKey = key; this.buildHdrTables(p.P("HDR.EXPOSURE"), p.P("HDR.WHITE LEVEL"), p.P("HDR.GLARE THRESH")); }
      else this.buildNoise();
    }
    return hdrOn;
  }
  // One frame into the 1920x1080 display buffer. look: { gradient, bgLevel, waveRgb, waves, particles,
  // dotRgb, transparent }; ps: the particle system (or null)
  render(dt, p, wave, ps, look, particleCam) {
    if (!this.ready) return;
    const gl = this.gl;
    const hdrOn = this.hdrBegin(p);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
    this.passBackground(dt, p, look);
    this.passWave(p, wave, look);
    this.passLinesController(p, look, this.main, this.wave);
    this.glareReady = false;
    if (hdrOn) this.passGlare(p);
    if (ps) {
      const PP = (n) => p.P("PARTICLES." + n);
      const cam = particleCam || this.pcam;
      cam.color = look.dotRgb || [1, 1, 1];
      ps.update(dt, PP, cam);
      if (look.particles) { this.target(this.main); ps.draw(gl, PP, cam, -1, !!look.transparent); }
    }
  }
  // the display buffer to the bound canvas framebuffer (w x h), stretched (both are 16:9 here, or
  // the screen's own shape: the PS3 picture fills it as the console's does a 16:10 screen)
  present(w, h, transparent) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    const u = this.glareReady ? this.progPresentG : this.progPresent;
    gl.useProgram(u.id);
    this.bind(0, this.main.tex);
    gl.uniform1i(u.loc("uTex"), 0);
    gl.uniform1i(u.loc("uAlpha"), transparent ? 1 : 0);
    if (this.glareReady) {
      this.bind(1, this.acc.tex); gl.uniform1i(u.loc("Glare"), 1);
      this.bind(13, this.noiseTex); gl.uniform1i(u.loc("preexpose_Noise"), 13);
      gl.uniform1f(u.loc("GlareWeight"), 1);
      gl.uniform2f(u.loc("uRes"), this.W, this.H);
    }
    this.quad();
  }
  // the background as it shows, on its own (no wave, no sparkles, no glare): 64 x 36 RGBA, top row first
  backgroundPixels(p, look) {
    const gl = this.gl;
    // (settled: the background `look` asks for, not the cross-fade on screen)
    this.drawBackground(this.bgTmp, 1, p, look);
    this.passLinesController(p, { ...look, bgLevel: look.bgLevel ?? 1 }, this.small, this.zeroTex, this.bgTmp.tex);
    const px = new Uint8Array(64 * 36 * 4);
    gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.UNSIGNED_BYTE, px);   // (memory row 0 is the top of the screen)
    return px;
  }
  // The same without waiting for the graphics card: the picture is copied into
  // a buffer and fetched once the card has finished it (backgroundPixelsTake,
  // a frame or two later). Returns false where that isn't possible.
  backgroundPixelsStart(p, look) {
    const gl = this.gl;
    if (this._bgSync) return true;
    this.drawBackground(this.bgTmp, 1, p, look);
    this.passLinesController(p, { ...look, bgLevel: look.bgLevel ?? 1 }, this.small, this.zeroTex, this.bgTmp.tex);
    try {
      if (!this._bgPbo) { this._bgPbo = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._bgPbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 64 * 36 * 4, gl.STREAM_READ); }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._bgPbo);
      gl.readPixels(0, 0, 64, 36, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this._bgSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      return !!this._bgSync;
    } catch (e) { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); this._bgSync = null; return false; }
  }
  // the pixels started above once they're ready (null: not yet)
  backgroundPixelsTake() {
    const gl = this.gl, s = this._bgSync;
    if (!s) return null;
    const st = gl.clientWaitSync(s, 0, 0);
    if (st === gl.TIMEOUT_EXPIRED) return null;
    gl.deleteSync(s); this._bgSync = null;
    if (st === gl.WAIT_FAILED) return null;
    const px = new Uint8Array(64 * 36 * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._bgPbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    return px;
  }
  // the display buffer as RGBA (top row first), for tests
  grab() {
    const gl = this.gl, px = new Uint8Array(this.W * this.H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.main.fbo);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }
}
