import {deflateSync} from 'node:zlib';

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(value: number): Uint8Array {
  return Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((char) => char.charCodeAt(0)));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type);
  return concat([u32be(data.byteLength), typeBytes, data, u32be(crc32(concat([typeBytes, data])))]);
}

export function makePngFixture(width: number, height: number, mode: 'solid' | 'stripes' | 'noise' = 'stripes'): Uint8Array {
  const rowBytes = width * 3 + 1;
  const raw = new Uint8Array(rowBytes * height);
  let seed = 0x5eed1234;
  const nextByte = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed & 0xff;
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * rowBytes;
    raw[row] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3;
      if (mode === 'solid') {
        raw[i] = 0x1d;
        raw[i + 1] = 0x9b;
        raw[i + 2] = 0xf0;
      } else if (mode === 'noise') {
        raw[i] = nextByte();
        raw[i + 1] = nextByte();
        raw[i + 2] = nextByte();
      } else {
        const stripe = Math.floor(x / 64) ^ Math.floor(y / 64);
        raw[i] = stripe & 1 ? 0x1d : 0xf5;
        raw[i + 1] = stripe & 1 ? 0x9b : 0xf5;
        raw[i + 2] = stripe & 1 ? 0xf0 : 0xf5;
      }
    }
  }

  const ihdr = concat([
    u32be(width),
    u32be(height),
    Uint8Array.from([8, 2, 0, 0, 0]), // 8-bit RGB, deflate, no interlace
  ]);

  return concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, {level: 9})),
    chunk('IEND', new Uint8Array()),
  ]);
}
