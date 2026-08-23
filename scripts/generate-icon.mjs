import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Helm's app icon: a multi-size .ico built from the wheel artwork.
 *
 * The mark is NOT drawn here. Unlike Jot, Nib, Loom and Tend, whose marks are
 * geometry in their generators, Helm's wheel is supplied artwork
 * (src/renderer/assets/helm-logo.png) and stays exactly as it is. This script
 * only changes how it is delivered.
 *
 * What that fixes: `build.win.icon` used to point straight at the 512px PNG, so
 * electron-builder produced the whole icon from one bitmap and Windows scaled
 * that to whatever it needed. Now each frame is resampled from the source at its
 * own size, by area-averaging every source pixel that falls inside it, and the
 * set includes 20 and 24 - the sizes the taskbar asks for at 125% and 150%
 * display scaling, where a missing frame means Windows resamples a neighbour.
 *
 * What it does NOT fix, and cannot: the wheel has eight spokes, eight handles and
 * a double rim, and at 16px those land under a pixel each whatever filter you
 * use. Its siblings solve that with a second, simplified drawing for the small
 * frames - Nib drops its vent hole, Jot widens its ring's gap. Doing that here
 * would mean redrawing the wheel as geometry, which is a change to the mark, so
 * it is deliberately not done. 16px stays dense.
 *
 * Run with `node scripts/generate-icon.mjs`. The output is committed, because
 * packaging must not depend on having run a script first.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = join(root, "src", "renderer", "assets", "helm-logo.png");
const outDir = join(root, "build");
mkdirSync(outDir, { recursive: true });

// ---------- PNG ----------

/** @param {Buffer} buffer */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Decode a non-interlaced 8-bit RGB/RGBA PNG to flat RGBA.
 *
 * Only what the source file needs - this is not a general decoder, and it says so
 * by throwing on anything else rather than guessing.
 *
 * @param {Buffer} file
 * @returns {{ width: number, height: number, pixels: Buffer }}
 */
function decodePng(file) {
  if (!file.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];

  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.subarray(offset + 4, offset + 8).toString("ascii");
    const data = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colourType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`unsupported PNG: depth ${bitDepth} colour ${colourType} interlace ${interlace}`);
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  const previous = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);

    // Undo the per-scanline filter. Byte-wise, `channels` back is the pixel to
    // the left; `previous` is the reconstructed row above.
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) {
        value += a;
      } else if (filter === 2) {
        value += b;
      } else if (filter === 3) {
        value += (a + b) >> 1;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter}`);
      }
      line[i] = value & 0xff;
    }
    line.copy(previous);

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      pixels[to] = line[from];
      pixels[to + 1] = line[from + 1];
      pixels[to + 2] = line[from + 2];
      pixels[to + 3] = channels === 4 ? line[from + 3] : 255;
    }
  }

  return { width, height, pixels };
}

/**
 * Resample to `size` by averaging every source pixel whose centre falls in the
 * target pixel's footprint.
 *
 * Alpha-weighted on purpose: averaging colour straight through would pull the
 * transparent background's RGB into the wheel's edge and leave a dark halo.
 *
 * @param {{ width: number, height: number, pixels: Buffer }} image
 * @param {number} size
 */
function resample(image, size) {
  const out = Buffer.alloc(size * size * 4);
  const scale = image.width / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scale);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));

      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          const a = image.pixels[i + 3] / 255;
          r += image.pixels[i] * a;
          g += image.pixels[i + 1] * a;
          b += image.pixels[i + 2] * a;
          alpha += a;
          count += 1;
        }
      }

      const to = (y * size + x) * 4;
      if (alpha > 0) {
        out[to] = Math.round(r / alpha);
        out[to + 1] = Math.round(g / alpha);
        out[to + 2] = Math.round(b / alpha);
        out[to + 3] = Math.round((alpha / count) * 255);
      }
    }
  }

  return out;
}

/** @param {number} size @param {Buffer} rgba */
function encodePng(size, rgba) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    rgba.copy(row, 1, y * size * 4, (y + 1) * size * 4);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------- ICO ----------

/**
 * A Vista-era .ico: a directory of entries, each holding a whole PNG. Identical
 * to the writer in Jot's, Nib's, Loom's and Tend's generators.
 *
 * @param {{ size: number, png: Buffer }[]} images
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    directory.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...directory, ...images.map((image) => image.png)]);
}

// ---------- output ----------

const artwork = decodePng(readFileSync(source));
if (artwork.width !== artwork.height) {
  throw new Error(`the artwork must be square, got ${artwork.width}x${artwork.height}`);
}

const sizes = [256, 128, 64, 48, 32, 24, 20, 16];
writeFileSync(
  join(outDir, "icon.ico"),
  buildIco(
    sizes.map((size) => ({
      size,
      png: encodePng(size, size === artwork.width ? artwork.pixels : resample(artwork, size))
    }))
  )
);

console.log(`Wrote build/icon.ico (${sizes.join(", ")}) from ${artwork.width}px artwork`);
