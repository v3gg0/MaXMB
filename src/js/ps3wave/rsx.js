// RSX Cg binaries (.vpo / .fpo from lines.qrc) -> instruction-exact GLSL ES 3.00.
// A port of moyou's rsx/cgbinary.cpp + rsx/glsl.cpp (github.com/sagemono/moyou, MIT License,
// (c) 2026 sagemono): container parsing, microcode decoding and GLSL emission. The output is
// the same text, character for character, as `moyou-cli transpile` (with hwprec).

export class RsxFormatError extends Error {}

const bits = (v, lo, n) => (v >>> lo) & ((1 << n) - 1);

const VP_VEC = ["NOP", "MOV", "MUL", "ADD", "MAD", "DP3", "DPH", "DP4", "DST", "MIN", "MAX", "SLT",
  "SGE", "ARL", "FRC", "FLR", "SEQ", "SFL", "SGT", "SLE", "SNE", "STR", "SSG", "?17", "?18", "TXL"];
const VP_SCA = ["NOP", "MOV", "RCP", "RCC", "RSQ", "EXP", "LOG", "LIT", "BRA", "BRI", "CAL",
  "CLI", "RET", "LG2", "EX2", "SIN", "COS", "BRB", "CLB", "PSH", "POP"];
const VP_IN = Array.from({ length: 16 }, (_, i) => "ATTR" + i);
const VP_OUT = ["HPOS", "COL0", "COL1", "BFC0", "BFC1", "FOGC", "PSIZE", "TEXCOORD0", "TEXCOORD1", "TEXCOORD2",
  "TEXCOORD3", "TEXCOORD4", "TEXCOORD5", "TEXCOORD6", "TEXCOORD7", "TEXCOORD8"];
const FP_OPS = ["NOP", "MOV", "MUL", "ADD", "MAD", "DP3", "DP4", "DST", "MIN", "MAX", "SLT", "SGE", "SLE", "SGT", "SNE",
  "SEQ", "FRC", "FLR", "KIL", "PK4", "UP4", "DDX", "DDY", "TEX", "TXP", "TXD", "RCP", "RSQ", "EX2", "LG2",
  "LIT", "LRP", "STR", "SFL", "COS", "SIN", "PK2", "UP2", "POW", "PKB", "UPB", "PK16", "UP16", "BEM", "PKG",
  "UPG", "DP2A", "TXL", "?48", "TXB", "?50", "TEXBEM", "TXPBEM", "BEMLUM", "REFL", "TIMESWTEX", "DP2", "NRM",
  "DIV", "DIVSQ", "LIF", "FENCT", "FENCB", "?63", "BRK", "CAL", "IFE", "LOOP", "REP", "RET"];
const FP_IN = ["WPOS", "COL0", "COL1", "FOGC", "TEX0", "TEX1", "TEX2", "TEX3", "TEX4", "TEX5", "TEX6", "TEX7", "TEX8", "TEX9", "SSA"];
const CG_C = 2178;
const C = "xyzw";

const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
const asFloat = (u) => { _u32[0] = u >>> 0; return _f32[0]; };

function be32(d, o) {
  if (o + 4 > d.length) throw new RsxFormatError("CgBinary: read past end of data");
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
}
function be16(d, o) {
  if (o + 2 > d.length) throw new RsxFormatError("CgBinary: read past end of data");
  return (d[o] << 8) | d[o + 1];
}
// FP microcode words are stored with their 16-bit halves swapped
const fpword = (uc, o) => { const v = be32(uc, o); return ((v << 16) | (v >>> 16)) >>> 0; };
function cstr(d, o) {
  if (o === 0 || o >= d.length) return "";
  let e = o;
  while (e < d.length && d[e] !== 0) e++;
  if (e >= d.length) throw new RsxFormatError("CgBinary: unterminated string");
  let s = "";
  for (let i = o; i < e; i++) s += String.fromCharCode(d[i]);
  return s;
}

const isVpFlow = (op) => ["BRA", "BRI", "CAL", "CLI", "RET", "BRB", "CLB", "PSH", "POP"].includes(op);
const isFpFlow = (op) => ["IFE", "LOOP", "REP", "BRK", "CAL", "RET"].includes(op);
function fpInRes(r) {
  if (r === "WPOS") return "WPOS";
  if (r === "COL0") return "COLOR0";
  if (r === "COL1") return "COLOR1";
  if (r === "FOGC") return "FOGCOORD";
  const m = /^TEX(\d)$/.exec(r);
  return m ? "TEXCOORD" + m[1] : null;
}
function typeWidth(t) {
  switch (t) { case 1045: case 1091: case 1031: return 1; case 1046: case 1032: return 2; case 1047: case 1033: return 3; default: return 4; }
}
function typeRows(t) {
  switch (t) { case 1061: case 1062: case 1063: case 1064: return 4; case 1057: case 1058: case 1059: case 1060: return 3; default: return 1; }
}
function cgResName(res, idx) {
  res = res >>> 0;
  if (res === CG_C) return "c[" + idx + "]";
  if (res >= 2048 && res <= 2063) return "TEXUNIT" + (res - 2048);
  if (res >= 2113 && res <= 2128) return "ATTR" + (res - 2113);
  if (res >= 3220 && res <= 3227) return "TEXCOORD" + (res - 3220);
  switch (res) {
    case 2243: return "HPOS"; case 2245: return "COL0"; case 2757: return "COLOR0"; case 2758: return "COLOR1";
    case 2369: return "PSIZE"; case 2373: return "POSITION0"; case 2241: return "FOGCOORD"; case 3239: return "WPOS";
    case 3256: return "(embedded)";
    default: return "res" + res + "[" + idx + "]";
  }
}
function varyingByRes(prog, dir) {
  const m = new Map();
  for (const p of prog.params) if (p.variability === 4101 && p.direction === dir) m.set(cgResName(p.resource, p.resIndex), p.name);
  return m;
}

// printf("%.<p>g", v)
function fmtG(v, p) {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  if (v === 0) return Object.is(v, -0) ? "-0" : "0";
  const ex = v.toExponential(p - 1);
  const X = parseInt(ex.slice(ex.indexOf("e") + 1), 10);
  const strip = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (X < -4 || X >= p) {
    const m = strip(ex.slice(0, ex.indexOf("e")));
    return m + "e" + (X < 0 ? "-" : "+") + String(Math.abs(X)).padStart(2, "0");
  }
  return strip(v.toFixed(Math.max(0, p - 1 - X)));
}
function flit(v) {
  if (Number.isNaN(v)) return "0.0";
  let s = fmtG(v, 9);
  if (s.includes("inf")) return v > 0 ? "3.4e38" : "-3.4e38";
  if (!s.includes(".") && !s.includes("e")) s += ".0";
  return s;
}
function ident(name) {
  const s = name.replace(/[^0-9A-Za-z_]/g, "_");
  const b = s.search(/[^_]/);
  if (b < 0) return "unnamed";
  let e = s.length - 1;
  while (s[e] === "_") e--;
  return s.slice(b, e + 1);
}

function vpConstMap(prog) {
  const cmap = new Map();
  for (const p of prog.params) {
    if ((p.resource >>> 0) !== CG_C || p.resIndex < 0 || !p.referenced) continue;
    const rows = typeRows(p.type);
    for (let r = 0; r < rows; r++) {
      const idx = p.resIndex + r;
      if (p.variability === 4103 && p.defaults.length) {
        const w = typeWidth(p.type), values = [];
        for (let k = w * r; k < w * r + w && k < p.defaults.length; k++) values.push(p.defaults[k]);
        for (let k = w; k < 4; k++) values.push(0);
        cmap.set(idx, { literal: true, values, name: "" });
      } else if (!cmap.has(idx)) {
        cmap.set(idx, { literal: false, values: [], name: rows === 1 ? p.name : p.name + "[" + r + "]" });
      }
    }
  }
  return cmap;
}

function decodeVp(prog) {
  const uc = prog.ucode;
  if (uc.length % 4) throw new RsxFormatError("VP ucode size is not a multiple of 4");
  const insts = [];
  for (let i = 0; i < Math.floor(uc.length / 16); i++) {
    const d0 = be32(uc, 16 * i), d1 = be32(uc, 16 * i + 4), d2 = be32(uc, 16 * i + 8), d3 = be32(uc, 16 * i + 12);
    const srcRaw = [(bits(d2, 23, 9) | (bits(d1, 0, 8) << 9)) >>> 0, bits(d2, 6, 17), (bits(d3, 21, 11) | (bits(d2, 0, 6) << 11)) >>> 0];
    const absf = [bits(d0, 21, 1) !== 0, bits(d0, 22, 1) !== 0, bits(d0, 23, 1) !== 0];
    const ins = { index: i, srcs: [], vecDst: [], scaDst: [], vmask: "", smask: "" };
    for (let k = 0; k < 3; k++) {
      const s = srcRaw[k], rt = bits(s, 0, 2);
      ins.srcs.push({
        kind: rt === 1 ? "Temp" : rt === 2 ? "In" : rt === 3 ? "Const" : "Bad",
        reg: rt === 1 ? bits(s, 2, 6) : rt === 2 ? bits(d1, 8, 4) : bits(d1, 12, 10),
        swz: [bits(s, 14, 2), bits(s, 12, 2), bits(s, 10, 2), bits(s, 8, 2)],
        neg: bits(s, 16, 1) !== 0, abs: absf[k], indexed: bits(d3, 1, 1) !== 0,
        addrReg: bits(d0, 24, 1), addrSwz: bits(d0, 0, 2),
      });
    }
    const vo = bits(d1, 22, 5), so = bits(d1, 27, 5);
    ins.vecOp = vo < VP_VEC.length ? VP_VEC[vo] : "?";
    ins.scaOp = so < VP_SCA.length ? VP_SCA[so] : "?";
    for (let c = 0; c < 4; c++) {
      if (bits(d3, 16 - c, 1)) ins.vmask += C[c];
      if (bits(d3, 20 - c, 1)) ins.smask += C[c];
    }
    const vecResult = bits(d0, 30, 1) !== 0, dstOut = bits(d3, 2, 5);
    const ccUpd = bits(d0, 14, 1) || bits(d0, 29, 1), ccSel = bits(d0, 25, 1);
    const dsts = (isSca) => {
      const tmp = isSca ? bits(d3, 7, 6) : bits(d0, 15, 6), isRes = isSca ? !vecResult : vecResult, out = [];
      if (isRes && dstOut !== 0x1f) {
        if (dstOut >= VP_OUT.length) throw new RsxFormatError("VP: invalid output register");
        out.push({ kind: "Out", value: dstOut });
      }
      if (tmp !== 0x3f) out.push({ kind: (!isSca && ins.vecOp === "ARL") ? "Addr" : "Temp", value: tmp });
      if (ccUpd) out.push({ kind: "Cc", value: ccSel });
      return out;
    };
    ins.vecDst = dsts(false); ins.scaDst = dsts(true);
    ins.sat = bits(d0, 26, 1) !== 0;
    ins.tex = bits(d2, 8, 2);
    ins.cond = bits(d0, 13, 1) ? bits(d0, 10, 3) : 7;
    ins.ccSel = ccSel;
    ins.ccSwz = [bits(d0, 8, 2), bits(d0, 6, 2), bits(d0, 4, 2), bits(d0, 2, 2)];
    ins.end = bits(d3, 0, 1) !== 0;
    insts.push(ins);
    if (bits(d3, 0, 1)) break;
  }
  return insts;
}

const FP_SCALE = [1.0, 2.0, 4.0, 8.0, 1.0, 0.5, 0.25, 0.125];
const FP_KIND = ["Temp", "In", "Const", "Bad"];
function decodeFp(prog) {
  const emb = new Map();
  for (const p of prog.params) for (const o of p.embedded) emb.set(o, p.name);
  const uc = prog.ucode, insts = [];
  let off = 0;
  while (off + 16 <= uc.length) {
    const dst = fpword(uc, off), s = [fpword(uc, off + 4), fpword(uc, off + 8), fpword(uc, off + 12)];
    const opcode = bits(dst, 24, 6) | (bits(s[1], 31, 1) << 6);
    const ins = { offset: off, op: opcode < FP_OPS.length ? FP_OPS[opcode] : "?" + opcode, srcs: [], konst: [0, 0, 0, 0], constName: null, mask: "" };
    ins.hasConst = !isFpFlow(ins.op) && (bits(s[0], 0, 2) === 2 || bits(s[1], 0, 2) === 2 || bits(s[2], 0, 2) === 2);
    if (ins.hasConst) {
      for (let k = 0; k < 4; k++) ins.konst[k] = asFloat(fpword(uc, off + 16 + 4 * k));
      if (emb.has(off + 16)) ins.constName = emb.get(off + 16);
    }
    const attr = bits(dst, 13, 4);
    for (let k = 0; k < 3; k++) {
      const x = s[k], rt = bits(x, 0, 2);
      ins.srcs.push({
        kind: FP_KIND[rt], fp16: bits(x, 8, 1) !== 0, reg: bits(x, 2, 6),
        swz: [bits(x, 9, 2), bits(x, 11, 2), bits(x, 13, 2), bits(x, 15, 2)],
        neg: bits(x, 17, 1) !== 0, abs: (k === 0 ? bits(x, 29, 1) : bits(x, 18, 1)) !== 0,
        pmod: bits(s[1], 19 + 3 * k, 3),
        inReg: rt === 1 ? (attr < FP_IN.length ? FP_IN[attr] : "IN" + attr) : "",
      });
    }
    for (let c = 0; c < 4; c++) if (bits(dst, 9 + c, 1)) ins.mask += C[c];
    ins.hasDst = !bits(dst, 30, 1);
    ins.dstFile = bits(dst, 7, 1) ? "H" : "R";
    ins.dstReg = bits(dst, 1, 6);
    ins.setCc = bits(dst, 8, 1) !== 0;
    ins.ccReg = bits(s[0], 30, 1);
    ins.sat = bits(dst, 31, 1) !== 0;
    ins.prec = bits(dst, 22, 2);
    ins.scale = FP_SCALE[bits(s[1], 28, 3)];
    ins.tex = bits(dst, 17, 4);
    ins.cond = bits(s[0], 18, 1) | (bits(s[0], 19, 1) << 1) | (bits(s[0], 20, 1) << 2);
    ins.condReg = bits(s[0], 31, 1);
    ins.condSwz = [bits(s[0], 21, 2), bits(s[0], 23, 2), bits(s[0], 25, 2), bits(s[0], 27, 2)];
    ins.end = bits(dst, 0, 1) !== 0;
    off += ins.hasConst ? 32 : 16;
    insts.push(ins);
    if (bits(dst, 0, 1)) break;
  }
  return insts;
}

// Parses a CgBinary container (throws RsxFormatError).
export function parseProgram(d) {
  if (d.length < 32) throw new RsxFormatError("CgBinary: truncated header");
  const prog = { profile: be32(d, 0), params: [], ucode: null, vp: null, fp: null };
  const pcount = be32(d, 12), parr = be32(d, 16), progOff = be32(d, 20), ucodeSize = be32(d, 24), ucodeOff = be32(d, 28);
  prog.vertex = prog.profile === 7003;
  for (let i = 0; i < pcount; i++) {
    const o = parr + 48 * i;
    if (o + 48 > d.length) throw new RsxFormatError("CgBinary: parameter table past end of data");
    const p = { type: be32(d, o) | 0, resource: be32(d, o + 4) | 0, variability: be32(d, o + 8) | 0, resIndex: be32(d, o + 12) | 0,
      defaults: [], embedded: [] };
    const nameOff = be32(d, o + 16), defv = be32(d, o + 20), emb = be32(d, o + 24), sem = be32(d, o + 28);
    p.direction = be32(d, o + 32) | 0; p.paramno = be32(d, o + 36) | 0; p.referenced = be32(d, o + 40) !== 0;
    p.name = cstr(d, nameOff); p.semantic = cstr(d, sem);
    if (defv) { const n = typeWidth(p.type) * typeRows(p.type); for (let k = 0; k < n; k++) p.defaults.push(asFloat(be32(d, defv + 4 * k))); }
    if (emb) {
      const cnt = be32(d, emb);
      if (emb + 4 + 4 * cnt > d.length) throw new RsxFormatError("CgBinary: embedded constant list past end of data");
      for (let k = 0; k < cnt; k++) p.embedded.push(be32(d, emb + 4 + 4 * k));
    }
    prog.params.push(p);
  }
  const ub = Math.min(ucodeOff, d.length), ue = Math.min(ucodeOff + ucodeSize, d.length);
  prog.ucode = d.subarray(ub, ue);
  if ((prog.profile === 7003 || prog.profile === 7004) && progOff + 24 > d.length) throw new RsxFormatError("CgBinary: program header past end of data");
  if (prog.profile === 7004) {
    prog.fp = { instructionCount: be32(d, progOff), inputMask: be32(d, progOff + 4), texcoordMask: be16(d, progOff + 12),
      texcoord2d: be16(d, progOff + 14), registerCount: d[progOff + 18], outputFromH0: d[progOff + 19], depthReplace: d[progOff + 20], pixelKill: d[progOff + 21] };
  } else if (prog.profile === 7003) {
    prog.vp = { instructionCount: be32(d, progOff) };
  }
  return prog;
}

// ------------------------------------------------------------------ GLSL emission
const LIT_FN = `vec4 rsx_lit(vec4 s) {
    float d = max(s.x, 0.0);
    float sp = s.x > 0.0 ? exp2(clamp(s.w, -128.0, 128.0) * log2(max(s.y, 1e-30))) : 0.0;
    return vec4(1.0, d, sp, 1.0);
}`;
const HWPREC_FNS = `vec4 rsx_h(vec4 v) { return vec4(unpackHalf2x16(packHalf2x16(v.xy)), unpackHalf2x16(packHalf2x16(v.zw))); }
vec4 rsx_x12(vec4 v) { return clamp(floor(v * 1024.0 + 0.5) / 1024.0, -2.0, 2.0 - 1.0 / 1024.0); }
vec4 rsx_x9(vec4 v) { return clamp(floor(v * 256.0 + 0.5) / 256.0, -1.0, 1.0 - 1.0 / 256.0); }`;

function glslType(t) {
  switch (t) {
    case 1045: case 1091: case 1031: return "float";
    case 1046: case 1032: return "vec2";
    case 1047: case 1033: return "vec3";
    case 1048: case 1034: return "vec4";
    case 1064: return "mat4";
    default: return "vec4";
  }
}
const samplerType = (t) => (t === 1067 ? "sampler3D" : t === 1069 ? "samplerCube" : "sampler2D");
const vec4lit = (vals) => "vec4(" + vals.map(flit).join(", ") + ")";
const swz = (s) => s.map((c) => C[c]).join("");
function header(gl330, fp) {
  if (gl330) return ["#version 330 core"];
  const h = ["#version 300 es", "precision highp float;", "precision highp int;"];
  if (fp) h.push("precision highp sampler2D;");
  return h;
}
function scalarFn(op, a) {
  const x = "(" + a + ").x";
  if (op === "RCP") return "vec4(1.0 / " + x + ")";
  if (op === "RCC") return "vec4(clamp(1.0 / " + x + ", 5.42101e-20, 1.884467e19))";
  if (op === "RSQ") return "vec4(inversesqrt(abs(" + x + ")))";
  if (op === "EX2" || op === "EXP") return "vec4(exp2(" + x + "))";
  if (op === "LG2" || op === "LOG") return "vec4(log2(" + x + "))";
  if (op === "SIN") return "vec4(sin(" + x + "))";
  if (op === "COS") return "vec4(cos(" + x + "))";
  return null;
}
function vecExpr(op, a, b, c) {
  const sf = scalarFn(op, a);
  if (sf !== null) return sf;
  const p = (s) => "(" + s + ")";
  switch (op) {
    case "MOV": return a;
    case "MUL": return a + " * " + b;
    case "ADD": return a + " + " + b;
    case "MAD": return a + " * " + b + " + " + c;
    case "DP2": return "vec4(dot(" + p(a) + ".xy, " + p(b) + ".xy))";
    case "DP2A": return "vec4(dot(" + p(a) + ".xy, " + p(b) + ".xy) + " + p(c) + ".x)";
    case "DP3": return "vec4(dot(" + p(a) + ".xyz, " + p(b) + ".xyz))";
    case "DP4": return "vec4(dot(" + a + ", " + b + "))";
    case "DPH": return "vec4(dot(" + p(a) + ".xyz, " + p(b) + ".xyz) + " + p(b) + ".w)";
    case "DST": return "vec4(1.0, " + p(a) + ".y * " + p(b) + ".y, " + p(a) + ".z, " + p(b) + ".w)";
    case "MIN": return "min(" + a + ", " + b + ")";
    case "MAX": return "max(" + a + ", " + b + ")";
    case "SLT": return "vec4(lessThan(" + a + ", " + b + "))";
    case "SGE": return "vec4(greaterThanEqual(" + a + ", " + b + "))";
    case "SLE": return "vec4(lessThanEqual(" + a + ", " + b + "))";
    case "SGT": return "vec4(greaterThan(" + a + ", " + b + "))";
    case "SNE": return "vec4(notEqual(" + a + ", " + b + "))";
    case "SEQ": return "vec4(equal(" + a + ", " + b + "))";
    case "SFL": return "vec4(0.0)";
    case "STR": return "vec4(1.0)";
    case "FRC": return "fract(" + a + ")";
    case "FLR": return "floor(" + a + ")";
    case "SSG": return "sign(" + a + ")";
    case "LRP": return "mix(" + c + ", " + b + ", " + a + ")";
    case "POW": return "vec4(pow(" + p(a) + ".x, " + p(b) + ".x))";
    case "DIV": return a + " / " + p(b) + ".x";
    case "DIVSQ": return a + " * inversesqrt(" + p(b) + ".x)";
    case "NRM": return "vec4(normalize(" + p(a) + ".xyz), 0.0).xyzz";
    case "DDX": return "dFdx(" + a + ")";
    case "DDY": return "dFdy(" + a + ")";
    case "REFL": return "vec4(reflect(" + p(b) + ".xyz, " + p(a) + ".xyz), 0.0)";
    case "LIT": return "rsx_lit(" + a + ")";
    case "PK2": return "vec4(uintBitsToFloat(packHalf2x16(" + p(a) + ".xy)))";
    case "UP2": return "unpackHalf2x16(floatBitsToUint(" + p(a) + ".x)).xyxy";
    case "PK4": return "vec4(uintBitsToFloat(packSnorm4x8(" + a + ")))";
    case "UP4": return "unpackSnorm4x8(floatBitsToUint(" + p(a) + ".x))";
    case "PKB": return "vec4(uintBitsToFloat(packUnorm4x8(" + a + ")))";
    case "UPB": return "unpackUnorm4x8(floatBitsToUint(" + p(a) + ".x))";
    case "PK16": return "vec4(uintBitsToFloat(packUnorm2x16(" + p(a) + ".xy)))";
    case "UP16": return "unpackUnorm2x16(floatBitsToUint(" + p(a) + ".x)).xyxy";
    default: return null;
  }
}
function condTest(code, v) {
  const ops = ["", " < 0.0", " == 0.0", " <= 0.0", " > 0.0", " != 0.0", " >= 0.0", ""];
  if (code === 7) return "true";
  if (code === 0) return "false";
  return v + ops[code];
}
function emitWrite(lines, dsts, mask, e, cond, sat, scale, prec, hwprec) {
  if (!mask) return;
  if (scale !== 1.0) e = "(" + e + ") * " + flit(scale);
  if (sat) e = "clamp(" + e + ", 0.0, 1.0)";
  if (hwprec) {
    if (prec === 2) e = "rsx_x12(" + e + ")";
    else if (prec === 3) e = "rsx_x9(" + e + ")";
    else if (prec === 1 || dsts.some((d) => d.startsWith("H"))) e = "rsx_h(" + e + ")";
  }
  if (!cond) {
    if (dsts.length === 1 && mask === "xyzw") lines.push("    " + dsts[0] + " = " + e + ";");
    else {
      lines.push("    t = " + e + ";");
      for (const d of dsts) lines.push("    " + d + "." + mask + " = t." + mask + ";");
    }
  } else {
    lines.push("    t = " + e + ";");
    for (let i = 0; i < 4; i++) {
      const ch = C[i];
      if (!mask.includes(ch)) continue;
      const test = condTest(cond.code, cond.reg + "." + C[cond.swz[i]]);
      for (const d of dsts) lines.push("    if (" + test + ") " + d + "." + ch + " = t." + ch + ";");
    }
  }
}
// matrix-row / array-element uniform names: "name[3]"
function splitIndexed(name) {
  const m = /^(.*)\[(\d+)\]$/.exec(name);
  return m ? [m[1], m[2]] : null;
}
const sortNum = (s) => [...s].sort((a, b) => a - b);

function fpToGlsl(prog, opt, name) {
  const h = prog.fp, insts = decodeFp(prog), lines = header(opt.gl330, true);
  lines.push("// transpiled from " + name + " (sce_fp_rsx, " + h.instructionCount + " slots)");
  const samplers = new Map(), uniforms = [];
  for (const p of prog.params) {
    if (!p.referenced) continue;
    const res = p.resource >>> 0;
    if (res >= 2048 && res <= 2063) {
      samplers.set(res - 2048, { name: ident(p.name), type: samplerType(p.type), rect: p.type === 1068 });
    } else if (p.embedded.length) {
      const t = glslType(p.type);
      let init = "";
      if (p.defaults.length) init = t !== "float" ? " = " + t + "(" + p.defaults.map(flit).join(", ") + ")" : " = " + flit(p.defaults[0]);
      uniforms.push({ name: ident(p.name), type: t, init, offsets: p.embedded });
    }
  }
  const emb = new Map();
  for (const u of uniforms) for (const o of u.offsets) emb.set(o, [u.name, u.type]);
  const usedIn = new Set();
  for (const ins of insts) for (const s of ins.srcs) if (s.kind === "In") usedIn.add(s.inReg);
  const inRes = (r) => fpInRes(r) ?? r;
  for (const r of [...usedIn].sort()) if (r !== "WPOS") lines.push("in vec4 v_" + inRes(r) + ";");
  for (const u of uniforms) {
    lines.push("uniform " + u.type + " " + u.name + (opt.gl330 ? u.init : "") + ";");
    if (u.init && !opt.gl330) lines[lines.length - 1] += "   // default" + u.init;
  }
  for (const unit of sortNum(samplers.keys())) {
    const s = samplers.get(unit);
    lines.push("uniform " + s.type + " " + s.name + ";   // TEXUNIT" + unit + (s.rect ? " (samplerRECT: unnormalized coords)" : ""));
  }
  const mrt = [0, h.outputFromH0 ? 4 : 2, h.outputFromH0 ? 6 : 3, h.outputFromH0 ? 8 : 4];
  const base = h.outputFromH0 ? "H" : "R";
  const regs = new Set();
  for (const ins of insts) {
    if (ins.hasDst) regs.add(ins.dstFile + ins.dstReg);
    for (const s of ins.srcs) if (s.kind === "Temp") regs.add((s.fp16 ? "H" : "R") + s.reg);
  }
  const outs = [];
  for (let i = 0; i < 4; i++) if (regs.has(base + mrt[i])) outs.push(i);
  for (const i of outs) lines.push("layout(location = " + i + ") out vec4 o_COLOR" + i + ";");
  if (insts.some((i) => i.op === "LIT")) lines.push(LIT_FN);
  if (opt.hwprec) lines.push(HWPREC_FNS);
  lines.push("void main() {", "    vec4 t;", "    vec4 CC0 = vec4(0.0), CC1 = vec4(0.0);");
  const sorted = [...regs].sort((a, b) => (a[0] === b[0] ? parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10) : a[0] < b[0] ? -1 : 1));
  for (const r of sorted) lines.push("    vec4 " + r + " = vec4(0.0);");
  for (const ins of insts) {
    const op = ins.op;
    if (op === "NOP" || op === "FENCT" || op === "FENCB") continue;
    if (isFpFlow(op)) { lines.push("    // UNSUPPORTED flow control " + op); continue; }
    const src = (k) => {
      const s = ins.srcs[k];
      let r;
      if (s.kind === "Temp") r = (s.fp16 ? "H" : "R") + s.reg;
      else if (s.kind === "In") {
        if (s.inReg === "WPOS") r = "gl_FragCoord";
        else if (s.inReg === "COL0" || s.inReg === "COL1") r = "clamp(v_" + inRes(s.inReg) + ", 0.0, 1.0)";
        else r = "v_" + inRes(s.inReg);
      } else if (s.kind === "Const") {
        const it = emb.get(ins.offset + 16);
        if (ins.constName && it) {
          const [nm, t] = it;
          if (t === "float") r = "vec4(" + nm + ")";
          else if (t === "vec2") r = "vec4(" + nm + ", 0.0, 0.0)";
          else if (t === "vec3") r = "vec4(" + nm + ", 0.0)";
          else if (t === "vec4") r = nm;
          else r = "vec4(" + nm + ")";
        } else r = vec4lit(ins.konst);
      } else r = "vec4(0.0)";
      const sw = swz(s.swz);
      if (sw !== "xyzw") r = "(" + r + ")." + sw;
      let pm = s.kind === "Bad" || (s.kind === "In" && s.inReg === "SSA") ? 0 : s.pmod;
      if (pm === 1 && s.kind === "Temp" && s.fp16) pm = 0;
      if (pm === 4) r = "clamp(" + r + ", 0.0, 1.0)";
      if (s.abs) r = "abs(" + r + ")";
      if (pm >= 1 && pm <= 3 && opt.hwprec) r = (pm === 1 ? "rsx_h(" : pm === 2 ? "rsx_x12(" : "rsx_x9(") + r + ")";
      if (s.neg) r = "-(" + r + ")";
      return r;
    };
    if (ins.cond === 0) continue;
    const cond = ins.cond !== 7 ? { code: ins.cond, reg: "CC" + ins.condReg, swz: ins.condSwz } : null;
    if (op === "KIL") {
      if (!cond) lines.push("    discard;");
      else {
        let tests = "";
        for (let i = 0; i < 4; i++) tests += (i ? " || " : "") + condTest(ins.cond, "CC" + ins.condReg + "." + C[ins.condSwz[i]]);
        lines.push("    if (" + tests + ") discard;");
      }
      continue;
    }
    const a = src(0), b = src(1), c = src(2);
    let expr;
    if (["TEX", "TXP", "TXB", "TXL", "TXD"].includes(op)) {
      const smp = samplers.get(ins.tex) || { name: "tex" + ins.tex, type: "sampler2D", rect: false };
      let crd = "(" + a + ").xy";
      if (smp.rect) crd = "(" + crd + ") / vec2(textureSize(" + smp.name + ", 0))";
      if (op === "TEX") expr = "texture(" + smp.name + ", " + crd + ")";
      else if (op === "TXP") expr = "textureProj(" + smp.name + ", (" + a + ").xyw)";
      else if (op === "TXB") expr = "texture(" + smp.name + ", " + crd + ", (" + a + ").w)";
      else if (op === "TXL") expr = "textureLod(" + smp.name + ", " + crd + ", (" + a + ").w)";
      else expr = "textureGrad(" + smp.name + ", " + crd + ", (" + b + ").xy, (" + c + ").xy)";
    } else expr = vecExpr(op, a, b, c);
    if (expr === null) { lines.push("    // UNSUPPORTED op " + op); continue; }
    const dsts = [];
    if (ins.hasDst) dsts.push(ins.dstFile + ins.dstReg);
    if (ins.setCc) dsts.push("CC" + ins.ccReg);
    if (dsts.length) emitWrite(lines, dsts, ins.mask, expr, cond, ins.sat, ins.scale, ins.prec, opt.hwprec);
  }
  for (const i of outs) lines.push("    o_COLOR" + i + " = " + base + mrt[i] + ";");
  lines.push("}");
  return lines.join("\n") + "\n";
}

const varyingName = (o) => { const n = VP_OUT[o & 15]; return n === "COL0" ? "COLOR0" : n === "COL1" ? "COLOR1" : n; };

function vpToGlsl(prog, opt, name) {
  const insts = decodeVp(prog), cmap = vpConstMap(prog), vin = varyingByRes(prog, 4097);
  const lines = header(opt.gl330, false);
  lines.push("// transpiled from " + name + " (sce_vp_rsx, " + insts.length + " instructions)");
  const usedIn = new Set(), usedC = new Set(), usedOut = new Set(), regs = new Set();
  for (const ins of insts) {
    for (const s of ins.srcs) {
      if (s.kind === "In") usedIn.add(s.reg);
      else if (s.kind === "Const") usedC.add(s.reg);
      else if (s.kind === "Temp") regs.add(s.reg);
    }
    for (const lst of [ins.vecDst, ins.scaDst]) for (const d of lst) {
      if (d.kind === "Out") usedOut.add(d.value);
      else if (d.kind === "Temp") regs.add(d.value);
    }
  }
  const attrName = (r) => vin.get(VP_IN[r & 15]) ?? "attr" + r;
  for (const r of sortNum(usedIn)) lines.push("layout(location = " + r + ") in vec4 a_" + ident(attrName(r)) + ";   // " + VP_IN[r & 15]);
  const paramType = (n) => { for (const p of prog.params) if (p.name === n) return glslType(p.type); return "vec4"; };
  const uniDecl = [];
  const declare = (key, decl) => { const e = uniDecl.find((u) => u[0] === key); if (e) e[1] = decl; else uniDecl.push([key, decl]); };
  for (const idx of sortNum(usedC)) {
    const it = cmap.get(idx);
    if (!it) declare("c" + idx, "uniform vec4 c" + idx + ";");
    else if (!it.literal) {
      const n = it.name, m = splitIndexed(n);
      if (m) declare(m[0], "uniform vec4 " + ident(m[0]) + "[4];   // matrix rows (RSX c[] layout)");
      else declare(n, "uniform " + paramType(n) + " " + ident(n) + ";");
    }
  }
  for (const [, v] of uniDecl) lines.push(v);
  const outsSorted = sortNum(usedOut);
  for (const o of outsSorted) if (o !== 0) lines.push("out vec4 v_" + varyingName(o) + ";");
  lines.push("void main() {", "    vec4 t, ts;", "    vec4 CC0 = vec4(0.0), CC1 = vec4(0.0);", "    ivec4 A0 = ivec4(0);");
  for (const r of sortNum(regs)) lines.push("    vec4 R" + r + " = vec4(0.0);");
  for (const o of outsSorted) lines.push("    vec4 o_" + VP_OUT[o] + " = vec4(0.0, 0.0, 0.0, 1.0);");
  const constRef = (idx) => {
    const it = cmap.get(idx);
    if (!it) return "c" + idx;
    if (it.literal) return vec4lit(it.values);
    const n = it.name, m = splitIndexed(n);
    if (m) return ident(m[0]) + "[" + m[1] + "]";
    const t = paramType(n);
    if (t === "float") return "vec4(" + ident(n) + ")";
    if (t === "vec2") return "vec4(" + ident(n) + ", 0.0, 0.0)";
    if (t === "vec3") return "vec4(" + ident(n) + ", 0.0)";
    return ident(n);
  };
  for (const ins of insts) {
    const src = (k) => {
      const s = ins.srcs[k];
      let r;
      if (s.kind === "Temp") r = "R" + s.reg;
      else if (s.kind === "In") r = "a_" + ident(attrName(s.reg));
      else if (s.kind === "Const") r = s.indexed ? "/*indexed*/ c[A0." + C[s.addrSwz] + " + " + s.reg + "]" : constRef(s.reg);
      else r = "vec4(0.0)";
      const sw = swz(s.swz);
      if (sw !== "xyzw") r = "(" + r + ")." + sw;
      if (s.abs) r = "abs(" + r + ")";
      if (s.neg) r = "-(" + r + ")";
      return r;
    };
    const cond = ins.cond !== 7 ? { code: ins.cond, reg: "CC" + ins.ccSel, swz: ins.ccSwz } : null;
    const writes = [];
    if (ins.vecOp !== "NOP") {
      const op = ins.vecOp, a = src(0);
      let b = src(1);
      const c = src(2);
      if (op === "ADD") b = c;   // the VP adder takes its second operand from src2
      let expr = null;
      if (op === "TXL") expr = "textureLod(vtex" + ins.tex + ", (" + a + ").xy, (" + a + ").w)";
      else if (op === "ARL") lines.push("    A0 = ivec4(floor(" + a + "));");
      else expr = vecExpr(op, a, b, c);
      if (expr) { lines.push("    t = " + expr + ";"); writes.push(["t", ins.vecDst, ins.vmask]); }
    }
    if (ins.scaOp !== "NOP") {
      const op = ins.scaOp;
      if (isVpFlow(op)) lines.push("    // UNSUPPORTED flow control " + op);
      else {
        const s = src(2);
        lines.push("    ts = " + (vecExpr(op, s, s, s) ?? "None") + ";");
        writes.push(["ts", ins.scaDst, ins.smask]);
      }
    }
    for (const [tv, dl, mask] of writes) {
      const names = [];
      for (const d of dl) {
        if (d.kind === "Temp") names.push("R" + d.value);
        else if (d.kind === "Out") names.push("o_" + VP_OUT[d.value & 15]);
        else if (d.kind === "Cc") names.push("CC" + d.value);
      }
      const val = ins.sat ? "clamp(" + tv + ", 0.0, 1.0)" : tv;
      for (const n of names) {
        if (!cond) lines.push(mask !== "xyzw" ? "    " + n + "." + mask + " = (" + val + ")." + mask + ";" : "    " + n + " = " + val + ";");
        else for (let i = 0; i < 4; i++) {
          const ch = C[i];
          if (!mask.includes(ch)) continue;
          lines.push("    if (" + condTest(cond.code, cond.reg + "." + C[ins.ccSwz[i]]) + ") " + n + "." + ch + " = (" + val + ")." + ch + ";");
        }
      }
    }
  }
  for (const o of outsSorted) lines.push(o === 0 ? "    gl_Position = o_HPOS;" : "    v_" + varyingName(o) + " = o_" + VP_OUT[o] + ";");
  lines.push("}");
  return lines.join("\n") + "\n";
}

// Transpiles to GLSL; `name` (a file name) goes in the header comment.
export function transpile(prog, opt = {}, name = "") {
  const o = { hwprec: opt.hwprec !== false, gl330: !!opt.gl330 };
  return prog.vertex ? vpToGlsl(prog, o, name) : fpToGlsl(prog, o, name);
}

// Post-processing applied to the particle programs
export function postParticleVP(glsl) {
  const pos = "gl_Position = o_HPOS;";
  if (!glsl.includes(pos)) throw new RsxFormatError("postParticleVP: no gl_Position = o_HPOS;");
  const src = glsl.split(pos).join("gl_Position = vec4(o_HPOS.x, o_HPOS.y * u_flipY, o_HPOS.z, o_HPOS.w);");
  const lines = src.split("\n");
  let last = -1;
  for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("uniform ")) last = i;
  if (last < 0) throw new RsxFormatError("postParticleVP: no uniform declaration");
  lines.splice(last + 1, 0, "uniform float u_flipY;   // +1/-1: framebuffer orientation (RSX viewport y-scale -540)");
  return lines.join("\n");
}
export function postParticleFP(glsl) {
  let src = glsl;
  for (const k of [1, 2]) {
    const decl = "layout(location = " + k + ") out vec4 o_COLOR" + k + ";";
    if (!src.includes(decl)) throw new RsxFormatError("postParticleFP: missing " + decl);
    src = src.split(decl).join("vec4 o_COLOR" + k + ";   // unused MRT output on the RSX (single colour target)");
  }
  const t = src.replace(/[\s\x1c-\x1f]+$/, "");
  const idx = t.lastIndexOf("}");
  const head = idx < 0 ? src.slice(0, Math.max(0, src.length - 1)) : src.slice(0, idx);
  return head + "    if (!(o_COLOR0.w > 0.0)) discard;   // RSX alpha test: GREATER, ref 0\n}\n";
}
