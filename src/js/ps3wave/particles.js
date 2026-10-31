// The XMB sparkles: the PPU emitter and the SPU update step (particles.elf), with the SPU's
// round-toward-zero float arithmetic. A port of moyou's particles/particles.cpp
// (github.com/sagemono/moyou, MIT License, (c) 2026 sagemono).

const CAP = 2048, GRID_W = 128, GRID_H = 128, DEAD = -666, STEP = 1 / 60, CMD_CAP = 0x333;
const fr = Math.fround;
const _f = new Float32Array(1), _u = new Uint32Array(_f.buffer);
const hexf = (h) => { _u[0] = h >>> 0; return _f[0]; };
const FLT_MIN_D = 1.1754943508222875e-38, TOWARD_ZERO = 0.999999940395355224609375;
function rz(x) {
  let y = fr(x);
  if (y !== x && Math.abs(y) > Math.abs(x)) y = fr(y * TOWARD_ZERO);
  return (y < FLT_MIN_D && y > -FLT_MIN_D) ? 0 : y;
}
const truncd = (x) => (x < 0 ? Math.ceil(x) : Math.floor(x));

const C_TWO_PI = hexf(0x40c90fda), C_037 = hexf(0x3ebd70a3), C_017 = hexf(0x3e2e147a), C_031 = hexf(0x3e9eb851);
const C_SIXTIETH = hexf(0x3c888888), C_AGE_MAX = hexf(0x3f7fff58), C_094 = hexf(0x3f70a3d7), C_002 = hexf(0x3ca3d70a);
const C_FADE_K = hexf(0xc1855554), C_ONE_ULP = hexf(0x3f800001);
const SC_TWO_OVER_PI = hexf(0x3f22f983), SC_PIO2HI = hexf(0x3fc90fd9), SC_PIO2LO = hexf(0x33a22168);
const SC_C0 = hexf(0xbab24992), SC_C1 = hexf(0x3d2aa035), SC_C2 = hexf(0xbeffffdf);
const SC_S0 = hexf(0xb94c8c6d), SC_S1 = hexf(0x3c088342), SC_S2 = hexf(0xbe2aaaa1);

// float -> half, truncating (particles.elf func_6e08)
function halfTrunc(x) {
  _f[0] = x;
  const b = _u[0], s = (b >>> 16) & 0x8000, e = (b >>> 23) & 0xff, m = b & 0x7fffff;
  if (e > 142) return s | 0x7c00;
  if (e > 112) return s | ((e - 112) << 10) | (m >>> 13);
  return s;
}

const MENU = ["emit vel min", "emit vel mul", "emit vel var", "emit cone angle", "emit neg prob", "emit vel zscale",
  "emit per frame", "emit prob", "aging speed", "aging variance", "friction", "spin time scale", "delta time",
  "gravity", "wind dir x", "wind dir y", "wind dir z", "wind scale", "wind scale 10", "brownian scale",
  "spot pos x", "spot pos y", "spot pos z", "spot attn x", "spot attn y", "spot attn z", "specular power",
  "specular coeff", "lambert coeff", "exposure", "fresnel", "color_control", "iridescent exp", "global alpha",
  "size middle", "size near", "size far", "near focus", "near focus_dist", "near focus_pow", "near darkness",
  "near fuzziness", "far focus", "far focus_dist", "far focus_pow", "far darkness", "near align", "size align",
  "glare", "glare scale", "glare p1", "glare p2"];
const I = Object.fromEntries(MENU.map((n, i) => [n, i]));

function readParams(P) {
  const v = MENU.map((n) => { let x = P ? P(n) : NaN; if (Number.isNaN(x) || x === undefined) x = 0; return fr(x); });
  const p = { v, perFrame: truncd(v[I["emit per frame"]]), W: [0, 0, 0] };
  const wx = v[I["wind dir x"]], wy = v[I["wind dir y"]], wz = v[I["wind dir z"]];
  const wl = Math.sqrt(wx * wx + wy * wy + wz * wz), ws = fr(fr(v[I["wind scale 10"]] * 10) + v[I["wind scale"]]);
  if (wl >= 1e-4) { const inv = 1 / wl; p.W = [fr(fr(wx * inv) * ws), fr(fr(wy * inv) * ws), fr(fr(wz * inv) * ws)]; }
  return p;
}

function invert4(a) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = a;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10,
    b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12,
    b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30,
    b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  return [(a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det];
}
function quatFromRot(m) {
  const m00 = m[0], m11 = m[5], m22 = m[10], tr = m00 + m11 + m22;
  let x, y, z, w, s;
  if (tr > 0) { s = Math.sqrt(tr + 1) * 2; w = 0.25 * s; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s; }
  else if (m00 > m11 && m00 > m22) { s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m[6] - m[9]) / s; x = 0.25 * s; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s; }
  else if (m11 > m22) { s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = 0.25 * s; z = (m[9] + m[6]) / s; }
  else { s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = 0.25 * s; }
  return [x, y, z, w];
}
const DEFAULT_MV = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -2, 1];
const modelviewOf = (cam) => (cam.modelview && cam.modelview.some((v) => v !== 0) ? cam.modelview : DEFAULT_MV);
function camInfo(camera) {
  const mv = modelviewOf(camera);
  const inv = invert4(Array.from(mv, (v) => v)) || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1];
  const eye = [inv[12] / inv[15], inv[13] / inv[15], inv[14] / inv[15]];
  const ax = [mv[2], mv[6], mv[10]];
  let al = Math.sqrt(ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]);
  if (!al) al = 1;
  return { eye, axis: ax.map((c) => c / al), ffq: quatFromRot(inv), fovy: camera.fovy };
}
const LB_MIN = [-10, -10, -12], LB_MAX = [10, 10, 7];
function computeUniforms(P, camera) {
  const p = readParams(P), v = p.v, c = camInfo(camera), g = (n) => v[I[n]];
  const F = (a) => Float32Array.from(a);
  return {
    ParticleSize: F([g("size middle"), g("size near"), g("size far")]),
    Transparency: F([g("fresnel"), g("global alpha")]),
    Focus: F([g("near focus"), fr(g("near focus") + g("near focus_dist")), g("far focus"), fr(g("far focus") + g("far focus_dist"))]),
    FocusCurves: F([g("near focus_pow"), g("far focus_pow"), fr(c.fovy)]),
    NearControl: F([g("size align"), g("near fuzziness"), g("near align"), 0]),
    Darkness: F([g("near darkness"), g("far darkness")]),
    Glare: F([g("glare"), g("glare scale"), g("glare p1"), g("glare p2")]),
    LifeBoundsMin: F(LB_MIN), LifeBoundsMax: F(LB_MAX),
    FrontFacingQuaternion: F(c.ffq),
    LightPack: F([c.eye[0], g("spot pos x"), g("spot attn x"), g("lambert coeff"),
      c.eye[1], g("spot pos y"), g("spot attn y"), g("specular coeff"),
      c.eye[2], g("spot pos z"), g("spot attn z"), g("exposure"),
      1, g("specular power"), 0, g("color_control")]),
    Color: F(camera.color), Gamma: fr(camera.gamma), IridescentExp: fr(g("iridescent exp")),
  };
}

export class ParticleSystem {
  // assets: { textureRGBA, textureW, textureH, surfaceSampler(i, j) -> [x, y, z], seed }
  constructor(assets) {
    this.assets = assets;
    this.S = new Float32Array(CAP * 12);
    this.freeList = new Int32Array(CAP);
    this.freeCount = 0;
    this.vbPos = new Float32Array(CAP * 4);
    this.vbRot = new Uint16Array(CAP * 4);
    this.vbCount = 0; this.vbDirty = true;
    this.lcg = new Uint32Array(3);
    this.glReady = false;
    this.reset(assets.seed || 0);
  }
  R(x) { return rz(x); }
  fM(a, b) { return rz(a * b); }
  fA(a, b) { return rz(a + b); }
  fS(a, b) { return rz(a - b); }
  fMA(a, b, c) { return rz(a * b + c); }
  fNMS(a, b, c) { return rz(c - a * b); }
  spuSinCos(x, isCos) {
    let q = this.fM(x, SC_TWO_OVER_PI);
    q = this.fA(q, q >= 0 ? 0.5 : -0.5);
    const k = truncd(q);
    let r = this.fNMS(k, SC_PIO2HI, x);
    r = this.fNMS(k, SC_PIO2LO, r);
    const z = this.fM(r, r);
    const off = ((k | 0) & 3) + (isCos ? 1 : 0);
    const res = (off & 1) === 0 ? this.fMA(this.fMA(this.fMA(z, SC_S0, SC_S1), z, SC_S2), this.fM(z, r), r)
      : this.fMA(this.fMA(this.fMA(z, SC_C0, SC_C1), z, SC_C2), z, 1);
    return (off & 2) ? -res : res;
  }
  lcgRand(i) {
    this.lcg[i] = Math.imul(this.lcg[i], 16807);
    return fr(hexf(0x40000000 | (this.lcg[i] >>> 9)) - 3);
  }
  qrand() {
    this.qCounter = (this.qCounter + 1) | 0;
    let n = this.qCounter >>> 0;
    n = (n ^ (n << 13)) >>> 0;
    const t = (Math.imul(Math.imul(n, n), 15731) + 789221) | 0;
    const r = (Math.imul(n, t) + 1376312589) & 0x7fffffff;
    return fr(fr(r) * -9.313225746154785e-10 + 1);
  }
  reset(seed) {
    for (let i = 0; i < CAP; i++) {
      const o = i * 12;
      this.S.fill(0, o, o + 12); this.S[o + 3] = DEAD; this.S[o + 11] = 1;
      this.freeList[i] = i;
    }
    this.freeCount = CAP;
    this.reqPrev = []; this.reqCur = []; this.cmds = [];
    this.streak = { count: 0, x: 0, y: 0 };
    this.qCounter = seed | 0;
    this.frame = 0; this.accum = 0; this.vbCount = 0; this.tSim = 0;
  }
  cellPos(i, j) {
    i = ((i % GRID_W) + GRID_W) % GRID_W; j = ((j % GRID_H) + GRID_H) % GRID_H;
    const p = this.assets.surfaceSampler(i, j);
    return [fr(p[0]), fr(p[1]), fr(p[2])];
  }
  static cellFromRand(r, n) { return truncd(fr(fr(fr(r + 1) * 0.5) * (n - 1))); }
  emission(p, cam) {
    const v = p.v, g = (n) => v[I[n]];
    this.reqCur = [];
    const r = this.qrand();
    if (fr(r * 0.5 + 0.5) < g("emit prob") && p.perFrame !== 0) {
      for (let k = 0; k < p.perFrame; k++) {
        const x = ParticleSystem.cellFromRand(this.qrand(), GRID_W), y = ParticleSystem.cellFromRand(this.qrand(), GRID_H);
        const c = this.cellPos(x, y);
        this.reqCur.push({ x, y, px: c[0], py: c[1], pz: c[2] });
      }
    }
    const st = this.streak;
    if (st.count === 0) {
      if (fr(this.qrand() * 0.5 + 0.5) < fr(0.06)) {
        st.x = ParticleSystem.cellFromRand(this.qrand(), GRID_W);
        st.y = ParticleSystem.cellFromRand(this.qrand(), GRID_H);
        const cf = fr(this.qrand() * 80);
        st.count = truncd(cf) + 100;
      }
    } else if ((this.frame & 1) === 0) {
      if (GRID_W > st.x) {
        const cs = this.cellPos(st.x, st.y);
        this.reqCur.push({ x: st.x, y: st.y, px: cs[0], py: cs[1], pz: cs[2] });
        st.x++; st.count--;
      } else st.count = 0;
    }
    const invDt = fr(1 / g("delta time"));
    const [ax, ay, az] = cam.axis;
    const cone = fr(g("emit cone angle") * fr(0.0174532924));
    const cmds = this.cmds;
    for (const rq of this.reqPrev) {
      const now = this.cellPos(rq.x, rq.y);
      const vx = fr(fr(now[0] - rq.px) * invDt), vy = fr(fr(now[1] - rq.py) * invDt), vz = fr(fr(now[2] - rq.pz) * invDt);
      const len2 = fr(fr(vx * vx + vy * vy) + vz * vz), len = fr(Math.sqrt(len2));
      if (!(len >= fr(1e-4))) continue;
      const il = fr(1 / Math.sqrt(len2));
      let dx = fr(vx * il), dy = fr(vy * il), dz = fr(vz * il);
      if (fr(fr(this.qrand() + 1) * 0.5) < g("emit neg prob")) { dx = -dx; dy = -dy; dz = -dz; }
      const n4 = fr(dy * dy + dz * dz), n6 = fr(dx * dx + dz * dz), n5 = fr(dx * dx + dy * dy);
      let p1;
      if (n4 > n6 && n4 > n5) p1 = [0, dz, -dy, n4];
      else if (!(n4 > n6) && n6 > n5) p1 = [-dz, 0, dx, n6];
      else p1 = [dy, -dx, 0, n5];
      const ip = fr(1 / Math.sqrt(p1[3]));
      const p1x = fr(p1[0] * ip), p1y = fr(p1[1] * ip), p1z = fr(p1[2] * ip);
      const p2x = fr(dy * p1z - dz * p1y), p2y = fr(dz * p1x - dx * p1z), p2z = fr(dx * p1y - dy * p1x);
      const th = fr(fr(fr(this.qrand() + 1) * 0.5) * cone);
      const ph = fr(fr(fr(this.qrand() + 1) * 0.5) * fr(6.28318548));
      const sth = fr(Math.sin(th)), cph = fr(Math.cos(ph)), sph = fr(Math.sin(ph)), cth = fr(Math.cos(th));
      const sx = fr(sth * cph), sy = fr(sth * sph);
      const ex = fr(dx * cth + fr(p1x * sx + fr(p2x * sy))), ey = fr(dy * cth + fr(p1y * sx + fr(p2y * sy))),
        ez = fr(dz * cth + fr(p1z * sx + fr(p2z * sy)));
      const t = fr(fr(fr(ex * ax + ey * ay) + ez * az) * fr(1 / fr(fr(ax * ax + ay * ay) + az * az)));
      const prx = fr(ax * t), pry = fr(ay * t), prz = fr(az * t), zs = g("emit vel zscale");
      const ox = fr(fr(prx * zs) + fr(ex - prx)), oy = fr(fr(pry * zs) + fr(ey - pry)), oz = fr(fr(prz * zs) + fr(ez - prz));
      const mulv = fr(g("emit vel mul") * fr(this.qrand() * g("emit vel var") + 1));
      let spd = fr(Math.sqrt(fr(len * mulv)));
      if (spd < g("emit vel min")) spd = g("emit vel min");
      let rate = fr(g("aging speed") * fr(this.qrand() * g("aging variance") + 1));
      if (fr(0.001) >= rate) rate = fr(0.001);
      if (cmds.length < CMD_CAP) cmds.push([0, 0, 0, 0]); else continue;
      if (cmds.length < CMD_CAP) cmds.push([1, now[0], now[1], now[2]]); else continue;
      if (cmds.length < CMD_CAP) cmds.push([2, fr(ox * spd), fr(oy * spd), fr(oz * spd)]); else continue;
      if (cmds.length < CMD_CAP) cmds.push([4, rate, 0, 0]);
    }
    this.reqPrev = this.reqCur;
    this.reqCur = [];
  }
  execCommands() {
    let cur = -1;
    const S = this.S;
    for (const c of this.cmds) {
      if (c[0] === 0) {
        cur = -1;
        if (this.freeCount > 0) { cur = this.freeList[--this.freeCount]; S.fill(0, cur * 12, cur * 12 + 8); }
        continue;
      }
      if (cur < 0) continue;
      const b = cur * 12;
      if (c[0] === 1) { S[b] = c[1]; S[b + 1] = c[2]; S[b + 2] = c[3]; }
      else if (c[0] === 2) { S[b + 4] = c[1]; S[b + 5] = c[2]; S[b + 6] = c[3]; }
      else if (c[0] === 3) { S[b + 4] = S[b + 4] + c[1]; S[b + 5] = S[b + 5] + c[2]; S[b + 6] = S[b + 6] + c[3]; }
      else if (c[0] === 4) S[b + 7] = c[1];
    }
    this.cmds = [];
  }
  spuUpdate(p) {
    this.lcg[0] = 0x98756161; this.lcg[1] = 0x21324889; this.lcg[2] = 0x82181158;
    const v = p.v, g = (n) => v[I[n]];
    const brown = g("brownian scale"), grav = g("gravity"), frc = g("friction"), dt = g("delta time");
    const spinS = this.fM(g("spin time scale"), C_SIXTIETH);
    const [Wx, Wy, Wz] = p.W, S = this.S, vbPos = this.vbPos, vbRot = this.vbRot;
    let n = 0;
    for (let i = 0; i < CAP; i++) {
      const o = i * 12;
      if (S[o + 3] === DEAD) continue;
      const r0 = this.lcgRand(0), r1 = this.lcgRand(1), r2 = this.lcgRand(2);
      const Fx = this.fA(this.fM(r0, brown), Wx), Fy = this.fA(this.fM(r1, brown), Wy), Fz = this.fA(this.fM(r2, brown), Wz);
      let vx = S[o + 4], vy = S[o + 5], vz = S[o + 6];
      const rate = S[o + 7];
      const axv = this.fNMS(frc, vx, this.fA(0, Fx)), ayv = this.fNMS(frc, vy, this.fA(grav, Fy)), azv = this.fNMS(frc, vz, this.fA(0, Fz));
      vx = this.fA(vx, this.fM(axv, dt)); vy = this.fA(vy, this.fM(ayv, dt)); vz = this.fA(vz, this.fM(azv, dt));
      const px = this.fA(S[o], this.fM(vx, dt)), py = this.fA(S[o + 1], this.fM(vy, dt)), pz = this.fA(S[o + 2], this.fM(vz, dt));
      const age = this.fA(S[o + 3], rate);
      const a = this.fM(age, C_TWO_PI);
      const wx = this.spuSinCos(this.fM(a, C_037), false), wy = this.spuSinCos(this.fM(a, C_017), true), wz = this.spuSinCos(this.fM(a, C_031), true);
      let qx = S[o + 8], qy = S[o + 9], qz = S[o + 10], qw = S[o + 11];
      let rx = this.fM(qx, 0), ry = this.fM(qy, 0), rzz = this.fM(qz, 0), rw = this.fM(qw, 0);
      rx = this.fMA(this.fM(qw, wx), 1, rx); ry = this.fMA(this.fM(qz, wx), -1, ry); rzz = this.fMA(this.fM(qy, wx), 1, rzz); rw = this.fMA(this.fM(qx, wx), -1, rw);
      rx = this.fMA(this.fM(qz, wy), 1, rx); ry = this.fMA(this.fM(qw, wy), 1, ry); rzz = this.fMA(this.fM(qx, wy), -1, rzz); rw = this.fMA(this.fM(qy, wy), -1, rw);
      rx = this.fMA(this.fM(qy, wz), -1, rx); ry = this.fMA(this.fM(qx, wz), 1, ry); rzz = this.fMA(this.fM(qw, wz), 1, rzz); rw = this.fMA(this.fM(qz, wz), -1, rw);
      qx = this.fA(qx, this.fM(this.fM(rx, 0.5), spinS)); qy = this.fA(qy, this.fM(this.fM(ry, 0.5), spinS));
      qz = this.fA(qz, this.fM(this.fM(rzz, 0.5), spinS)); qw = this.fA(qw, this.fM(this.fM(rw, 0.5), spinS));
      const dd = this.fA(this.fA(this.fA(this.fM(qx, qx), this.fM(qy, qy)), this.fM(qz, qz)), this.fM(qw, qw));
      const y0 = fr(1 / Math.sqrt(dd));
      const nn = this.fMA(this.fNMS(y0, this.fM(y0, dd), C_ONE_ULP), this.fM(y0, 0.5), y0);
      qx = this.fM(qx, nn); qy = this.fM(qy, nn); qz = this.fM(qz, nn); qw = this.fM(qw, nn);
      S[o + 4] = vx; S[o + 5] = vy; S[o + 6] = vz;
      S[o] = px; S[o + 1] = py; S[o + 2] = pz;
      S[o + 8] = qx; S[o + 9] = qy; S[o + 10] = qz; S[o + 11] = qw;
      const alive = age < C_AGE_MAX;
      const inb = !(px < LB_MIN[0] || px > LB_MAX[0] || py < LB_MIN[1] || py > LB_MAX[1] || pz < LB_MIN[2] || pz > LB_MAX[2]);
      if (!(alive && inb)) { S[o + 3] = DEAD; this.freeList[this.freeCount++] = i; continue; }
      S[o + 3] = age;
      const fa = age > C_002 ? C_002 : age;
      let fb = this.fS(age, C_094);
      if (0 > fb) fb = 0;
      const fade = this.fM(this.fM(fa, 50), this.fMA(fb, C_FADE_K, 1));
      vbPos[n * 4] = px; vbPos[n * 4 + 1] = py; vbPos[n * 4 + 2] = pz; vbPos[n * 4 + 3] = fade;
      vbRot[n * 4] = halfTrunc(qx); vbRot[n * 4 + 1] = halfTrunc(qy); vbRot[n * 4 + 2] = halfTrunc(qz); vbRot[n * 4 + 3] = halfTrunc(qw);
      n++;
    }
    this.vbCount = n;
  }
  stepOnce(P, camera, doEmit = true) {
    const p = readParams(P), cam = camInfo(camera);
    if (doEmit) this.emission(p, cam);
    this.execCommands();
    this.spuUpdate(p);
    this.vbDirty = true;
    this.frame = (this.frame + 1) >>> 0; this.tSim += STEP;
  }
  update(dtSeconds, P, cam) {
    this.accum += dtSeconds > 0 ? dtSeconds : 0;
    let steps = 0;
    while (this.accum >= STEP && steps < 8) { this.stepOnce(P, cam, true); this.accum -= STEP; steps++; }
    if (this.accum > STEP * 8) this.accum = 0;
    if (steps) this.vbDirty = true;
    return steps;
  }
  count() { return this.vbCount; }

  // ---- WebGL2: draws 35 (particles_quads) and 36 (particles_second)
  initGL(gl, link, shaders) {
    if (this.glReady) return;
    this.programs = [link(shaders.quadsVP, shaders.quadsFP, "particles_quads"), link(shaders.secondVP, shaders.secondFP, "particles_second")];
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(8); gl.vertexAttribPointer(8, 2, gl.FLOAT, false, 8, 0);
    this.posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, CAP * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(0, 1);
    this.rotBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rotBuf);
    gl.bufferData(gl.ARRAY_BUFFER, CAP * 8, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(11); gl.vertexAttribPointer(11, 4, gl.HALF_FLOAT, false, 8, 0); gl.vertexAttribDivisor(11, 1);
    gl.bindVertexArray(null);
    const a = this.assets;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (a.textureRGBA && a.textureW > 0) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, a.textureW, a.textureH, 0, gl.RGBA, gl.UNSIGNED_BYTE, a.textureRGBA);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    this.glReady = true; this.vbDirty = true;
  }
  draw(gl, P, cam, flipY, blendTransparent = false) {
    if (!this.glReady || !this.vbCount) return;
    if (this.vbDirty) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vbPos, 0, this.vbCount * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.rotBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vbRot, 0, this.vbCount * 4);
      this.vbDirty = false;
    }
    const u = computeUniforms(P, cam), mvp = cam.mvp, mv = modelviewOf(cam);
    const mvpRows = new Float32Array(16), mvRows = new Float32Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { mvpRows[r * 4 + c] = mvp[c * 4 + r]; mvRows[r * 4 + c] = mv[c * 4 + r]; }
    // RSX state of draws 35/36: blend ONE/ONE add, no depth, no cull. Over a see-through
    // target (a picture behind) the alpha adds up as coverage instead of being forced to 1.
    gl.enable(gl.BLEND);
    if (blendTransparent) gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.bindVertexArray(this.vao);
    for (const pr of this.programs) {
      gl.useProgram(pr.id);
      const L = (n) => pr.loc(n);
      const v = (n, a) => { const l = L(n); if (l === null) return; const k = a.length;
        if (k === 1) gl.uniform1f(l, a[0]); else if (k === 2) gl.uniform2fv(l, a); else if (k === 3) gl.uniform3fv(l, a); else gl.uniform4fv(l, a); };
      let l;
      if ((l = L("ModelviewProjection")) !== null) gl.uniform4fv(l, mvpRows);
      if ((l = L("Modelview")) !== null) gl.uniform4fv(l, mvRows);
      if ((l = L("LightPack")) !== null) gl.uniform4fv(l, u.LightPack);
      for (let k = 0; k < 4; k++) v("LightPack_" + k, u.LightPack.subarray(k * 4, k * 4 + 4));
      v("ParticleSize", u.ParticleSize); v("Transparency", u.Transparency); v("Focus", u.Focus);
      v("FocusCurves", u.FocusCurves); v("FrontFacingQuaternion", u.FrontFacingQuaternion);
      v("NearControl", u.NearControl); v("LifeBoundsMin", u.LifeBoundsMin); v("LifeBoundsMax", u.LifeBoundsMax);
      v("Darkness", u.Darkness); v("Glare", u.Glare); v("Color", u.Color); v("Gamma", [u.Gamma]); v("IridescentExp", [u.IridescentExp]);
      v("u_flipY", [flipY]);
      if ((l = L("IridescentTex")) !== null) gl.uniform1i(l, 0);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.vbCount);
    }
    gl.bindVertexArray(null);
  }
}
