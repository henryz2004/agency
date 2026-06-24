// _pixpng.mjs — a tiny zero-dependency pixel canvas + PNG encoder, shared by the
// charsheet / animsheet generators. The character & pet renderers in
// public/sprites.js only use fillStyle + fillRect (+ save/translate/scale/restore
// for the cat's flip), so this shim is enough to run them headlessly in Node and
// dump the result to a PNG via stdlib zlib + a hand-rolled CRC32.
import zlib from 'node:zlib';

export function parseColor(s) {
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = parseInt(h, 16);
    return [(n >>> 16) & 255, (n >>> 8) & 255, n & 255, 255];
  }
  const m = (s.match(/[\d.]+/g) || [0, 0, 0, 0]).map(Number); // rgba(...)
  return [m[0] | 0, m[1] | 0, m[2] | 0, Math.round((m[3] ?? 1) * 255)];
}

// Canvas2D-ish context backed by an RGBA buffer. Supports the subset sprites.js
// uses: fillStyle, fillRect, and a scale+translate transform stack (enough for an
// axis-aligned mirror — the cat's `scale(-1,1)` flip).
export class Ctx {
  constructor(w, h, bg) {
    this.W = w; this.H = h; this.buf = new Uint8Array(w * h * 4); this._c = [0, 0, 0, 255];
    this._t = { sx: 1, sy: 1, tx: 0, ty: 0 }; this._stack = [];
    if (bg != null) { const [r, g, b] = parseColor(bg); for (let i = 0; i < this.buf.length; i += 4) { this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = 255; } }
  }
  set fillStyle(s) { this._c = parseColor(s); }
  get fillStyle() { return this._c; }
  save() { this._stack.push({ ...this._t }); }
  restore() { if (this._stack.length) this._t = this._stack.pop(); }
  translate(x, y) { this._t.tx += this._t.sx * x; this._t.ty += this._t.sy * y; }
  scale(x, y) { this._t.sx *= x; this._t.sy *= y; }
  fillRect(x, y, w, h) {
    const [r, g, b, a] = this._c;
    if (a === 0) return;
    const T = this._t;
    const x0 = T.sx * x + T.tx, y0 = T.sy * y + T.ty, x1 = T.sx * (x + w) + T.tx, y1 = T.sy * (y + h) + T.ty;
    const rx = Math.round(Math.min(x0, x1)), ry = Math.round(Math.min(y0, y1));
    const rw = Math.round(Math.abs(x1 - x0)), rh = Math.round(Math.abs(y1 - y0));
    const X1 = Math.max(0, rx), Y1 = Math.max(0, ry), X2 = Math.min(this.W, rx + rw), Y2 = Math.min(this.H, ry + rh);
    const ia = a / 255, na = 1 - ia;
    for (let yy = Y1; yy < Y2; yy++) {
      let o = (yy * this.W + X1) * 4;
      for (let xx = X1; xx < X2; xx++, o += 4) {
        if (a === 255) { this.buf[o] = r; this.buf[o + 1] = g; this.buf[o + 2] = b; }
        else { this.buf[o] = r * ia + this.buf[o] * na; this.buf[o + 1] = g * ia + this.buf[o + 1] * na; this.buf[o + 2] = b * ia + this.buf[o + 2] * na; }
        this.buf[o + 3] = 255;
      }
    }
  }
}

export function upscale(buf, w, h, s) {
  if (s === 1) return buf;
  const OW = w * s, out = new Uint8Array(OW * h * s * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    for (let dy = 0; dy < s; dy++) { let oo = (((y * s + dy) * OW) + x * s) * 4; for (let dx = 0; dx < s; dx++, oo += 4) { out[oo] = buf[o]; out[oo + 1] = buf[o + 1]; out[oo + 2] = buf[o + 2]; out[oo + 3] = 255; } }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
export function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const rowLen = w * 4, raw = Buffer.alloc(h * (1 + rowLen));
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < h; y++) { raw[y * (1 + rowLen)] = 0; src.copy(raw, y * (1 + rowLen) + 1, y * rowLen, (y + 1) * rowLen); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Structural self-check: shim fill + alpha blend + a valid PNG that round-trips.
// Throws on any failure. Both generators call this before rendering.
export function selfCheckPNG() {
  const t = new Ctx(2, 1, '#ffffff');
  const ok = (c, m) => { if (!c) throw new Error('pixpng self-check failed: ' + m); };
  t.fillStyle = '#ff0000'; t.fillRect(0, 0, 1, 1);
  ok(t.buf[0] === 255 && t.buf[1] === 0 && t.buf[2] === 0, 'opaque fill');
  t.fillStyle = 'rgba(0,0,255,0.5)'; t.fillRect(1, 0, 1, 1);
  ok(Math.abs(t.buf[4] - 128) <= 2 && t.buf[6] === 255, 'alpha blend');
  t.save(); t.translate(12, 0); t.scale(-1, 1); t.fillStyle = '#00ff00'; t.fillRect(10, 0, 2, 1); t.restore(); // mirror → x∈[0,2)
  ok(t.buf[1] === 255, 'mirror transform');
  const png = encodePNG(2, 1, t.buf);
  ok(png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png signature');
  ok(png.readUInt32BE(16) === 2 && png.readUInt32BE(20) === 1, 'png dims');
  const idat = png.slice(png.indexOf(Buffer.from('IDAT')) + 4, png.indexOf(Buffer.from('IEND')) - 8);
  ok(zlib.inflateSync(idat).length === 1 * (1 + 2 * 4), 'idat round-trips');
}
