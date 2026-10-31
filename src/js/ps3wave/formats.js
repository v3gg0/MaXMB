// lines.qrc (QRCC / QRCF container), .mnu parameter files, DDS and TGA textures, and the
// rope start states in a decrypted custom_render_plugin. A port of moyou's formats/*.cpp and
// sim/wave.cpp's readPrx (github.com/sagemono/moyou, MIT License, (c) 2026 sagemono).

export class FormatError extends Error {}

const be32 = (d, o) => {
  if (o + 4 > d.length) throw new FormatError("qrc: truncated");
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
};
function cstr(d, o) {
  let s = "";
  while (o < d.length && d[o]) s += String.fromCharCode(d[o++]);
  return s;
}
async function inflate(bytes) {
  const ds = new DecompressionStream("deflate");
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

// The files in a lines.qrc, by id ("LINE1.mnu", "lib/moyou/lines1.fpo", ...)
export class Archive {
  constructor(files, ids) { this.files = files; this.order = ids; }
  static async fromBytes(bytes) {
    let d = bytes;
    if (d.length >= 8 && String.fromCharCode(d[0], d[1], d[2], d[3]) === "QRCC") d = await inflate(d.subarray(8));
    if (d.length < 0x38 || String.fromCharCode(d[0], d[1], d[2], d[3]) !== "QRCF") throw new FormatError("not a QRC container");
    const treeOff = be32(d, 8), idsOff = be32(d, 0x10), namesOff = be32(d, 0x18), dataOff = be32(d, 0x30);
    const files = new Map(), ids = [], seen = new Set();
    const walk = (rel, depth) => {
      if (depth > 64) throw new FormatError("qrc: tree too deep");
      while (rel !== -1) {
        const o = treeOff + (rel >>> 0);
        if (seen.has(o)) throw new FormatError("qrc: tree links loop");
        seen.add(o);
        const name = be32(d, o), nattr = be32(d, o + 4), next = be32(d, o + 16) | 0, first = be32(d, o + 20) | 0;
        let id = "", srcPos = 0, off = 0, size = 0;
        for (let i = 0; i < nattr; i++) {
          const ao = o + 28 + 16 * i, an = cstr(d, namesOff + be32(d, ao));
          if (an === "id") id = cstr(d, idsOff + be32(d, ao + 8) + 4);
          else if (an === "src") { srcPos = ao; off = be32(d, ao + 8); size = be32(d, ao + 12); }
        }
        if (cstr(d, namesOff + name) === "file" && srcPos) {
          if (dataOff + off + size > d.length) throw new FormatError("qrc: payload out of range");
          ids.push(id); files.set(id, d.slice(dataOff + off, dataOff + off + size));
        }
        if (first !== -1) walk(first, depth + 1);
        rel = next;
      }
    };
    walk(0, 0);
    return new Archive(files, ids);
  }
  ids() { return this.order.slice(); }
  contains(id) { return this.files.has(id); }
  file(id) {
    const f = this.files.get(id);
    if (!f) throw new FormatError("lines.qrc has no " + id);
    return f;
  }
  text(id) { return String.fromCharCode.apply(null, this.file(id)); }
}

// "NAME:type:value" lines (# comments)
export function parseMnu(text) {
  const out = [];
  for (let line of text.split("\n")) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line || line[0] === "#") continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const v = parseFloat(parts[2]);
    if (Number.isNaN(v) && !/nan/i.test(parts[2])) continue;
    out.push({ name: parts[0], type: parts[1], value: v });
  }
  return out;
}

// ------------------------------------------------------------------ images (RGBA8, rows in file order)
const le32 = (d, o) => {
  if (o + 4 > d.length) throw new FormatError("image: truncated header");
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
};
function bc1Block(d, b, dxt1, out) {
  const c0 = d[b] | (d[b + 1] << 8), c1 = d[b + 2] | (d[b + 3] << 8);
  const rgb = (c) => { const r = c >> 11, g = (c >> 5) & 63, bl = c & 31; return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (bl << 3) | (bl >> 2), 255]; };
  const pal = [rgb(c0), rgb(c1), [0, 0, 0, 255], [0, 0, 0, 255]];
  const four = !dxt1 || c0 > c1;
  for (let k = 0; k < 3; k++) {
    pal[2][k] = four ? Math.floor((2 * pal[0][k] + pal[1][k]) / 3) : Math.floor((pal[0][k] + pal[1][k]) / 2);
    pal[3][k] = four ? Math.floor((pal[0][k] + 2 * pal[1][k]) / 3) : 0;
  }
  pal[3][3] = four ? 255 : 0;
  const idx = (d[b + 4] | (d[b + 5] << 8) | (d[b + 6] << 16) | (d[b + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++) { const p = pal[(idx >>> (2 * i)) & 3]; for (let k = 0; k < 4; k++) out[i * 4 + k] = p[k]; }
}
function decodeDxt(d, w, h, fourcc) {
  const dxt1 = fourcc === 0x31545844, dxt3 = fourcc === 0x33545844, dxt5 = fourcc === 0x35545844;
  if (!dxt1 && !dxt3 && !dxt5) throw new FormatError("DDS: unsupported compressed format (DXT1/3/5 only)");
  const bw = (w + 3) >> 2, bh = (h + 3) >> 2, bs = dxt1 ? 8 : 16;
  if (128 + bw * bh * bs > d.length) throw new FormatError("DDS: truncated pixel data");
  const px = new Uint8Array(w * h * 4), blk = new Uint8Array(64);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const b = 128 + (by * bw + bx) * bs;
    bc1Block(d, b + (dxt1 ? 0 : 8), dxt1, blk);
    if (dxt3) for (let i = 0; i < 16; i++) blk[i * 4 + 3] = ((d[b + (i >> 1)] >> (4 * (i & 1))) & 15) * 17;
    if (dxt5) {
      const a = [d[b], d[b + 1]];
      for (let k = 2; k < 8; k++) a[k] = a[0] > a[1] ? Math.floor(((8 - k) * a[0] + (k - 1) * a[1]) / 7)
        : k < 6 ? Math.floor(((6 - k) * a[0] + (k - 1) * a[1]) / 5) : (k === 6 ? 0 : 255);
      let bitsLo = 0, bitsHi = 0;   // 48 bits of 3-bit indices
      for (let k = 0; k < 3; k++) bitsLo += d[b + 2 + k] * 2 ** (8 * k);
      for (let k = 0; k < 3; k++) bitsHi += d[b + 5 + k] * 2 ** (8 * k);
      for (let i = 0; i < 16; i++) {
        const v = i < 8 ? Math.floor(bitsLo / 2 ** (3 * i)) & 7 : Math.floor(bitsHi / 2 ** (3 * (i - 8))) & 7;
        blk[i * 4 + 3] = a[v];
      }
    }
    for (let i = 0; i < 16; i++) {
      const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
      if (x < w && y < h) for (let k = 0; k < 4; k++) px[(y * w + x) * 4 + k] = blk[i * 4 + k];
    }
  }
  return { width: w, height: h, pixels: px };
}
export function decodeDds(d) {
  if (d.length < 128 || d[0] !== 0x44 || d[1] !== 0x44 || d[2] !== 0x53 || d[3] !== 0x20) throw new FormatError("not a DDS file");
  const height = le32(d, 12), width = le32(d, 16), pfFlags = le32(d, 80), bitsN = le32(d, 88);
  if (!width || !height || width > 16384 || height > 16384) throw new FormatError("DDS: bad size");
  if (pfFlags & 0x4) return decodeDxt(d, width, height, le32(d, 84));
  if (!(pfFlags & 0x40) || bitsN !== 32) throw new FormatError("DDS: only A8R8G8B8 and DXT1/3/5 are supported");
  const rm = le32(d, 92), gm = le32(d, 96), bm = le32(d, 100), am = le32(d, 104);
  if (rm !== 0x00ff0000 || gm !== 0x0000ff00 || bm !== 0x000000ff || (am && am !== 0xff000000)) throw new FormatError("DDS: unexpected channel masks");
  const n = width * height;
  if (128 + n * 4 > d.length) throw new FormatError("DDS: truncated pixel data");
  const px = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = 128 + i * 4;
    px[i * 4] = d[p + 2]; px[i * 4 + 1] = d[p + 1]; px[i * 4 + 2] = d[p]; px[i * 4 + 3] = am ? d[p + 3] : 255;
  }
  return { width, height, pixels: px };
}
export function decodeTga(d) {
  if (d.length < 18) throw new FormatError("not a TGA file");
  const idLen = d[0], cmap = d[1], type = d[2], width = d[12] | (d[13] << 8), height = d[14] | (d[15] << 8), bpp = d[16];
  if (type !== 2 || cmap !== 0 || (bpp !== 24 && bpp !== 32)) throw new FormatError("TGA: only uncompressed 24/32-bit truecolour");
  if (!width || !height) throw new FormatError("TGA: bad size");
  const n = width * height, step = bpp / 8, base = 18 + idLen;
  if (base + n * step > d.length) throw new FormatError("TGA: truncated pixel data");
  const px = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = base + i * step;
    px[i * 4] = d[p + 2]; px[i * 4 + 1] = d[p + 1]; px[i * 4 + 2] = d[p]; px[i * 4 + 3] = step === 4 ? d[p + 3] : 255;
  }
  return { width, height, pixels: px };
}

