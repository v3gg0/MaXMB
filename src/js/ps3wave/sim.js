// Wave geometry on the CPU: the 19x19 rope simulation (0x4f814 / 0x4bed0), the FFD deformation
// (ffd_shader1.fpo + 0x47b1c + spline.elf func_3c68) and the camera, producing the 19x19 control
// points in clip space that the spline job turns into the 128x128 wave sheet. A port of moyou's
// sim/wave.cpp (github.com/sagemono/moyou, MIT License, (c) 2026 sagemono).

export const NX = 19, NN = NX * NX;
const PI = Math.PI;
const f32 = Math.fround;

function bsp(t, out) {
  const s = 1 - t, t2 = t * t, t3 = t2 * t;
  out[0] = s * s * s / 6;
  out[1] = (3 * t3 - 6 * t2 + 4) / 6;
  out[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  out[3] = t3 / 6;
}

// column-major 4x4
export function mul(a, b) {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
export function inverse(a) {
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  const d = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  return Float64Array.of((a[5] * b11 - a[6] * b10 + a[7] * b09) * d, (a[2] * b10 - a[1] * b11 - a[3] * b09) * d,
    (a[13] * b05 - a[14] * b04 + a[15] * b03) * d, (a[10] * b04 - a[9] * b05 - a[11] * b03) * d,
    (a[6] * b08 - a[4] * b11 - a[7] * b07) * d, (a[0] * b11 - a[2] * b08 + a[3] * b07) * d,
    (a[14] * b02 - a[12] * b05 - a[15] * b01) * d, (a[8] * b05 - a[10] * b02 + a[11] * b01) * d,
    (a[4] * b10 - a[5] * b08 + a[7] * b06) * d, (a[1] * b08 - a[0] * b10 - a[3] * b06) * d,
    (a[12] * b04 - a[13] * b02 + a[15] * b00) * d, (a[9] * b02 - a[8] * b04 - a[11] * b00) * d,
    (a[5] * b07 - a[4] * b09 - a[6] * b06) * d, (a[0] * b09 - a[1] * b07 + a[2] * b06) * d,
    (a[13] * b01 - a[12] * b03 - a[14] * b00) * d, (a[8] * b03 - a[9] * b01 + a[10] * b00) * d);
}
// perspective(53 deg, 16:9, near, 1000) * ...; firmware 1.00 uses near = 9.99999975e-05
function makeProj(n) {
  const f = 1 / Math.tan(53 * PI / 360), fa = 1000, aspect = 16 / 9;
  return Float64Array.of(f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0);
}
const P493 = makeProj(0.1), P100 = makeProj(f32(9.99999975e-05));
export const projection = (fw = 493) => (fw === 100 ? P100 : P493);
const VIEW = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -2, 1);
export const view = () => VIEW;

// ffd_shader0..3.fpo per sample; u, v, w = _UVW, T = _Time
function ffdEval(n, u, v, w, T, out, o) {
  let dx, dy;
  switch (n) {
    case 0: {
      const A = f32(T + 2400), h = f32(A * 0.5), t1 = f32(A * 0.1), t13 = f32(A * 0.129999995);
      dx = 0.2 * u + 1.30999994 * u * u;
      dy = (0.5 - v) * (1 - Math.exp(-2 * u)) * Math.sin(h * (1 - 0.800000012 * u) - 6.28000021 * u) +
        Math.exp(-50 * Math.pow(u - 0.833333313 * (0.2 + Math.sin(t1)), 2)) -
        0.15 * Math.exp(-10 * Math.pow(u - 0.833333313 * (0.2 + Math.sin(t1 + 20)), 2)) +
        Math.sin(15.7000008 * u - t13 - 2) / 4;
      break;
    }
    case 2:
      dx = 0.2 * u + 1.3 * u * u;
      dy = 0.24 * (1 + Math.tanh(u - 0.5)) * (3 + Math.sin(2 * T)) * Math.exp(-T / 10000) * Math.sin(7.85 * u - 2.5 * T - 1.25);
      break;
    case 3:
      dx = 1.20000005 * u * u;
      dy = (1 - 2 * v) * (1 - Math.exp(-2 * u)) * Math.sin((T / 2) * (1 - 0.8 * u) - 6.28318548 * u) +
        Math.exp(-50 * Math.pow(u - Math.sin(T / 10), 2)) - 0.15 * Math.exp(-10 * Math.pow(u - Math.sin(T / 10 + 20), 2));
      break;
    default:   // 1, the shipping shader
      dx = 0.2 * u + 1.3 * u * u - 0.15;
      dy = 0.24 * (1 + Math.tanh(u - 0.5)) * (3 + Math.sin(2 * T)) * Math.exp(-T / 10000) * Math.sin(7.85 * u - 2.5 * T - 1.25) +
        Math.exp(-50 * Math.pow(u - (5 / 6) * (0.2 + Math.sin(T / 10)), 2)) + Math.sin(T / 4) / 2 + Math.sin(T - 6.28 * w) / 8;
  }
  out[o] = dx; out[o + 1] = dy;
}
function ffdPass(n, T, out) {
  for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++)
    ffdEval(n, i / 8, j / 4, k / 4, T, out, ((k * 4 + j) * 8 + i) * 2);
}

export class Wave {
  constructor() {
    this.ctrl = new Float32Array(NN * 4);
    this.prev = new Float64Array(NN * 4); this.cur = new Float64Array(NN * 4);
    this.vel = new Float64Array(NN * 4); this.pos = new Float64Array(NN * 4);
    this.samp = new Float64Array(128 * 4); this.lat = new Float64Array(539 * 4);
    this.ffdOut = new Float64Array(256); this.ffdFrozen = new Float64Array(256); this.ffdB = new Float64Array(256);
    this.ffdA = new Float64Array(256);
    this.ffdCur = 1; this.ffdPrev = 1; this.ffdSel = -1;
    this.ffdW = 0; this.ffdTcur = 0; this.ffdTold = 0; this.ffdFlag = false;
    this.rngN = 0; this.stepsN = 0; this.lineTime = 0; this.tsm = 0; this.acc = 0; this.ffdTime = 0;
    this.mvp = new Float64Array(16);
    this._invPV = inverse(mul(projection(), view()));
  }
  prm(p) {
    return { timestep: p.P("LINE1.TIMESTEP"), tension: p.P("LINE1.TENSION"), length: p.P("LINE1.LENGTH"), perturbation: p.P("LINE1.PERTURBATION"),
      damping: p.P("LINE1.DAMPING"), endY: p.P("LINE1.END Y"), endZ: p.P("LINE1.END Z") };
  }
  // The rope's start: a straight rope run 36000 + 3000 n steps until it moves
  // like the PS3's (warm: that run's result, made beforehand by warmRope, in a
  // worker so the window doesn't wait on it; made here if not given)
  loadState(n, p, warm = null) {
    const cur = this.cur, vel = this.vel;
    const w = warm || warmRope(n, this.prm(p));
    cur.set(w.cur); vel.set(w.vel);
    this.prev.set(cur); this.pos.set(cur);
    this.lineTime = 0; this.tsm = 0; this.acc = 0; this.stepsN = 0; this.rngN = 0; this.ffdTime = 0;
    this.ffdWrap();
    this.ffdW = 0; this.ffdFlag = false;
  }
  rnd() {   // integer noise on the counter at Lines+0x2d4
    this.rngN = (this.rngN + 1) | 0;
    let n = this.rngN >>> 0;
    n = ((n << 13) ^ n) >>> 0;
    const a = (Math.imul(Math.imul(n, n), 15731) + 789221) | 0;
    const v = (Math.imul(n, a) + 1376312589) & 0x7fffffff;
    return 1 - v / 1073741824;
  }
  spring(a, b, rest, k) {
    const cur = this.cur, vel = this.vel, ax = a * 4, bx = b * 4;
    const dx = cur[bx] - cur[ax], dy = cur[bx + 1] - cur[ax + 1], dz = cur[bx + 2] - cur[ax + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) return;
    const f = (len - rest) * k / len;
    vel[ax] += dx * f; vel[ax + 1] += dy * f; vel[ax + 2] += dz * f;
    vel[bx] -= dx * f; vel[bx + 1] -= dy * f; vel[bx + 2] -= dz * f;
  }
  step(q) {
    const cur = this.cur, vel = this.vel;
    this.prev.set(cur);
    const dt = q.timestep * 1e-4;
    this.lineTime += dt;
    if (this.lineTime > 10) { this.lineTime = 0; this.ffdWrap(); }
    const k = q.tension, L = q.length, kb = 10 * k;
    for (let j = 0; j < NX; j++) for (let i = 0; i < NX; i++) {
      const idx = j * NX + i;
      if (i > 0) this.spring(idx, idx - 1, L, k);
      if (i > 1) this.spring(idx, idx - 2, 2 * L, kb);
      if (j > 0) this.spring(idx, idx - NX, L, k);
      if (j > 1) this.spring(idx, idx - 2 * NX, 2 * L, kb);
      const o = idx * 4;
      vel[o] += this.rnd() * q.perturbation;
      vel[o + 1] += this.rnd() * q.perturbation;
      vel[o + 2] += this.rnd() * q.perturbation;
    }
    const damp = q.damping * q.timestep;
    for (let i = 0; i < NN * 4; i += 4) for (let c = 0; c < 3; c++) {
      cur[i + c] += vel[i + c] * dt;
      vel[i + c] -= vel[i + c] * damp;
    }
    this.tsm += (this.lineTime - this.tsm) * 0.1;   // constraints (0x4bce0)
    for (let j = 0; j < NX; j++) {
      vel[(j * NX) * 4] += q.timestep * 0.02;
      const s = j / NX + this.tsm, o = (j * NX + 18) * 4;
      cur[o] = 0;
      cur[o + 1] = (Math.sin(11 * s) * 0.5 + 0.5) * q.endY;
      cur[o + 2] = (Math.cos(15 * s) + 1) * 0.5 * q.endZ;
      cur[o + 3] = 1;
      vel[o] = vel[o + 1] = vel[o + 2] = vel[o + 3] = 0;
    }
    this.stepsN++;
  }
  ffdWrap() { this.ffdTold = this.ffdTcur; this.ffdFlag = false; this.ffdTcur = 0; this.ffdW = 1; this.ffdPrev = this.ffdCur; }
  ffdSelect(n) {
    if (this.ffdW >= 0.01) { const t = this.ffdOut; this.ffdOut = this.ffdFrozen; this.ffdFrozen = t; this.ffdFlag = true; }
    else this.ffdPrev = this.ffdCur;
    this.ffdCur = (n < 0 || n > 3) ? 3 : n;
    this.ffdTold = this.ffdTcur;
    this.ffdW = 1;
  }
  ffdSamples(T, S1, OFF) {
    this.ffdTold += T - this.ffdTcur;
    this.ffdTcur = T;
    const A = this.ffdA;
    ffdPass(this.ffdCur, this.ffdTcur, A);
    const w = this.ffdW, a = w * w * (3 - 2 * w);
    if (this.ffdW > 0) {
      if (!this.ffdFlag) ffdPass(this.ffdPrev, this.ffdTold, this.ffdB);
      this.ffdW -= 0.005;
      if (this.ffdW <= 0) { this.ffdW = 0; this.ffdFlag = false; }
    }
    const old = this.ffdFlag ? this.ffdFrozen : this.ffdB, out = this.ffdOut, samp = this.samp, lat = this.lat;
    for (let q = 0; q < 256; q++) out[q] = A[q] + (old[q] - A[q]) * a;
    for (let s = 0; s < 128; s++) {
      samp[s * 4] = out[s * 2] * S1[0] + OFF[0];
      samp[s * 4 + 1] = out[s * 2 + 1] * S1[1] + OFF[1];
      samp[s * 4 + 2] = OFF[2];
      samp[s * 4 + 3] = 1;
    }
    const cl = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);
    for (let k = -1; k < 6; k++) for (let j = -1; j < 6; j++) for (let i = -1; i < 10; i++) {
      const d = ((k + 1) * 77 + (j + 1) * 11 + (i + 1)) * 4, s = ((cl(k, 3) * 4 + cl(j, 3)) * 8 + cl(i, 7)) * 4;
      for (let c = 0; c < 4; c++) lat[d + c] = samp[s + c];
    }
  }
  ffdPoint(x, y, z, S1, S2, OFF, out) {
    const lx = (x - OFF[0]) / S1[0], ly = (y - OFF[1]) / S1[1], lz = (z - OFF[2]) / S1[2];
    const c = (v) => (v < 0 ? 0 : v > 0.999 ? 0.999 : v);
    const cx = c(lx) * 8, cy = c(ly) * 4, cz = c(lz) * 4;
    const ix = Math.floor(cx), iy = Math.floor(cy), iz = Math.floor(cz);
    const bx = this._bx || (this._bx = new Float64Array(4)), by = this._by || (this._by = new Float64Array(4)), bz = this._bz || (this._bz = new Float64Array(4));
    bsp(cx - ix, bx); bsp(cy - iy, by); bsp(cz - iz, bz);
    let sx = 0, sy = 0, sz = 0;
    const lat = this.lat;
    for (let kz = 0; kz < 4; kz++) for (let ky = 0; ky < 4; ky++) {
      const wyz = by[ky] * bz[kz], rowBase = ((iz + kz) * 77 + (iy + ky) * 11 + ix) * 4;
      for (let kx = 0; kx < 4; kx++) {
        const w = bx[kx] * wyz, li = rowBase + kx * 4;
        sx += w * lat[li]; sy += w * lat[li + 1]; sz += w * lat[li + 2];
      }
    }
    out[0] = (lx + sx) * S2[0]; out[1] = (ly + sy) * S2[1]; out[2] = (lz + sz) * S2[2];
  }
  // steps the rope at 60 Hz * speed and rebuilds the control points
  simulate(dtFrame, p, speed = 1, paused = false) {
    const q = this.prm(p);
    if (!paused) {
      this.acc += dtFrame * 60 * speed;
      let guard = 0;
      while (this.acc > 1 && guard++ < 2400) { this.step(q); this.acc -= 1; }
      if (this.acc > 1) this.acc = 1;
    }
    this.buildCtrl(p);
  }
  buildCtrl(p) {
    const x0 = p.P("LINE1.FFD PARAM 1"), prev = this.prev, cur = this.cur, pos = this.pos, acc = this.acc;
    for (let i = 0; i < NN; i++) {
      const o = i * 4;
      const px = prev[o] + (cur[o] - prev[o]) * acc, py = prev[o + 1] + (cur[o + 1] - prev[o + 1]) * acc, pz = prev[o + 2] + (cur[o + 2] - prev[o + 2]) * acc;
      const d = px - x0;
      let s = 0.3;
      if (d >= 0) { const qq = Math.min(d / 5, 1); s = 1.3 - Math.cos(d * PI / 2) * (1 - qq * qq * (3 - 2 * qq)); }
      pos[o] = px; pos[o + 1] = py * s; pos[o + 2] = pz * s; pos[o + 3] = 1;
    }
    const S1 = [p.P("LINE1.FFD SCALE1 X"), p.P("LINE1.FFD SCALE1 Y"), p.P("LINE1.FFD SCALE1 Z")];
    const S2 = [p.P("LINE1.FFD SCALE2 X"), p.P("LINE1.FFD SCALE2 Y"), p.P("LINE1.FFD SCALE2 Z")];
    const OFF = [p.P("LINE1.FFD OFFSET X"), p.P("LINE1.FFD OFFSET Y"), p.P("LINE1.FFD OFFSET Z")];
    const sel = Math.round(Math.min(100, Math.max(0, p.P("LINE1.FFD SHADER"))));
    if (this.ffdSel < 0) { this.ffdCur = this.ffdPrev = Math.min(sel, 3); this.ffdSel = sel; }
    else if (sel !== this.ffdSel) { this.ffdSel = sel; this.ffdSelect(sel); }
    // the FFD pass runs on the GPU and is read back a frame later: last frame's _Time
    this.ffdSamples(this.ffdTime, S1, OFF);
    this.ffdTime = this.lineTime * 10;
    let ax = p.P("LINE1.ANG X"), ay = p.P("LINE1.ANG Y"), az = p.P("LINE1.ANG Z");
    let al = Math.sqrt(ax * ax + ay * ay + az * az);
    if (al === 0) al = 1;
    ax /= al; ay /= al; az /= al;
    const t = p.P("LINE1.ANG ROT") * PI / 180, cs = Math.cos(t), sn = Math.sin(t), ic = 1 - cs;
    const model = Float64Array.of(ax * ax * ic + cs, ay * ax * ic + az * sn, az * ax * ic - ay * sn, 0,
      ax * ay * ic - az * sn, ay * ay * ic + cs, az * ay * ic + ax * sn, 0,
      ax * az * ic + ay * sn, ay * az * ic - ax * sn, az * az * ic + cs, 0,
      p.P("LINE1.POS X"), p.P("LINE1.POS Y"), p.P("LINE1.POS Z"), 1);
    const M = this.mvp = mul(projection(p.firmware), mul(view(), model));
    const v = this._v || (this._v = new Float64Array(3)), ctrl = this.ctrl;
    for (let i = 0; i < NN; i++) {
      this.ffdPoint(pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2], S1, S2, OFF, v);
      const x = v[0], y = v[1], z = v[2], o = i * 4;
      ctrl[o] = M[0] * x + M[4] * y + M[8] * z + M[12];
      ctrl[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      ctrl[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      ctrl[o + 3] = M[3] * x + M[7] * y + M[11] * z + M[15];
    }
  }
  // world position of wave vertex (i, j) of the 128x128 sheet
  surfaceWorld(i, j) {
    const pi = i >> 3, pj = j >> 3;
    const bu = this._bu || (this._bu = new Float64Array(4)), bv = this._bv || (this._bv = new Float64Array(4));
    bsp((i & 7) / 8, bu); bsp((j & 7) / 8, bv);
    let x = 0, y = 0, z = 0, w = 0;
    const ctrl = this.ctrl;
    for (let r = 0; r < 4; r++) for (let q = 0; q < 4; q++) {
      const k = bv[r] * bu[q], o = ((pj + r) * NX + (pi + q)) * 4;
      x += k * ctrl[o]; y += k * ctrl[o + 1]; z += k * ctrl[o + 2]; w += k * ctrl[o + 3];
    }
    const M = this._invPV;
    return [M[0] * x + M[4] * y + M[8] * z + M[12] * w, M[1] * x + M[5] * y + M[9] * z + M[13] * w, M[2] * x + M[6] * y + M[10] * z + M[14] * w];
  }
}

// the rope's start state (see Wave.loadState): { cur, vel } (NN x 4 each)
export function warmRope(n, q) {
  const w = new Wave(), cur = w.cur, vel = w.vel, L = q.length;
  for (let j = 0; j < NX; j++) for (let i = 0; i < NX; i++) {
    const o = (j * NX + i) * 4;
    cur[o] = (NX - 1 - i) * L; cur[o + 1] = 0.2; cur[o + 2] = 0.2 + 0.01 * j; cur[o + 3] = 1;
    vel[o] = vel[o + 1] = vel[o + 2] = vel[o + 3] = 0;
  }
  for (let k = 0; k < 36000 + 3000 * n; k++) w.step(q);
  return { cur, vel };
}
// the same in a worker (the window keeps going meanwhile); here if workers can't be used
export function warmRopeAsync(n, q) {
  return new Promise((resolve) => {
    let wk = null;
    const here = () => { try { wk && wk.terminate(); } catch (e) {} resolve(warmRope(n, q)); };
    try { wk = new Worker(new URL("./warm.worker.js", import.meta.url), { type: "module" }); } catch (e) { here(); return; }
    wk.onmessage = (e) => { wk.terminate(); resolve(e.data); };
    wk.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); here(); };
    wk.postMessage({ n, q });
  });
}
