/**
 * Pure TypeScript QR Code generator (zero dependencies).
 * Generates QR Code data URLs (SVG/PNG) without requiring external npm modules.
 */

// GF(256) tables for Reed-Solomon
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x >= 128 ? 0x11d : 0);
}

function gmul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  const logA = LOG[a] ?? 0;
  const logB = LOG[b] ?? 0;
  return EXP[logA + logB] ?? 0;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = EXP[i] ?? 0;
    for (let j = 0; j < poly.length; j++) {
      const cur = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ gmul(cur, root);
      next[j + 1] = (next[j + 1] ?? 0) ^ cur;
    }
    poly = next;
  }
  return poly;
}

function rsCompute(data: Uint8Array, numEc: number): Uint8Array {
  const gen = rsGeneratorPoly(numEc);
  const res = new Uint8Array(numEc);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ res[0]!;
    for (let j = 0; j < numEc - 1; j++) {
      res[j] = res[j + 1]! ^ gmul(gen[numEc - j]!, factor);
    }
    res[numEc - 1] = gmul(gen[0]!, factor);
  }
  return res;
}

export interface QrOptions {
  width?: number;
  margin?: number;
  color?: {
    dark?: string;
    light?: string;
  };
}

export function generateQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  // Choose version: Version 3 (29x29) handles up to 55 bytes in L mode
  // Version 4 (33x33) handles up to 80 bytes in L mode
  let version = 3;
  let totalDataBytes = 44;
  let ecBytes = 26;
  if (bytes.length > 32) {
    version = 4;
    totalDataBytes = 64;
    ecBytes = 36;
  }
  if (bytes.length > 50) {
    version = 6;
    totalDataBytes = 108;
    ecBytes = 64;
  }

  const size = 17 + version * 4;
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));

  // Function to place 7x7 finder pattern
  const placeFinder = (r: number, c: number) => {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const row = r + y;
        const col = c + x;
        if (row >= 0 && row < size && col >= 0 && col < size) {
          if (
            (x >= 0 && x <= 6 && (y === 0 || y === 6)) ||
            (y >= 0 && y <= 6 && (x === 0 || x === 6)) ||
            (x >= 2 && x <= 4 && y >= 2 && y <= 4)
          ) {
            matrix[row]![col] = true;
          } else {
            matrix[row]![col] = false;
          }
        }
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0;
    if (matrix[6]![i] === null) matrix[6]![i] = val;
    if (matrix[i]![6] === null) matrix[i]![6] = val;
  }

  // Alignment pattern for version >= 2
  if (version >= 2) {
    const alignPos = size - 7;
    for (let y = -2; y <= 2; y++) {
      for (let x = -2; x <= 2; x++) {
        const isBorder = Math.abs(x) === 2 || Math.abs(y) === 2;
        const isCenter = x === 0 && y === 0;
        matrix[alignPos + y]![alignPos + x] = isBorder || isCenter;
      }
    }
  }

  // Format reserve bits
  for (let i = 0; i < 9; i++) {
    if (matrix[8]![i] === null) matrix[8]![i] = false;
    if (matrix[i]![8] === null) matrix[i]![8] = false;
  }
  for (let i = size - 8; i < size; i++) {
    if (matrix[8]![i] === null) matrix[8]![i] = false;
    if (matrix[i]![8] === null) matrix[i]![8] = false;
  }

  // Encode data: byte mode (0100) + length (8 bits) + payload + terminator + padding
  const bitBuf: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bitBuf.push((val >> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8); // Length
  for (const b of bytes) pushBits(b, 8);
  pushBits(0, 4); // Terminator
  while (bitBuf.length % 8 !== 0) bitBuf.push(0);

  const rawBytes: number[] = [];
  for (let i = 0; i < bitBuf.length; i += 8) {
    let byteVal = 0;
    for (let j = 0; j < 8; j++) byteVal = (byteVal << 1) | bitBuf[i + j]!;
    rawBytes.push(byteVal);
  }

  // Pad bytes
  const pad = [0xec, 0x11];
  let pIdx = 0;
  while (rawBytes.length < totalDataBytes) {
    rawBytes.push(pad[pIdx % 2]!);
    pIdx++;
  }

  // Error correction
  const ec = rsCompute(new Uint8Array(rawBytes), ecBytes);
  const finalBits: number[] = [];
  for (const b of [...rawBytes, ...ec]) {
    for (let i = 7; i >= 0; i--) finalBits.push((b >> i) & 1);
  }

  // Place data bits in matrix (right to left, zig-zag)
  let bitIdx = 0;
  let dir = -1; // up
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c--; // Skip vertical timing column
    const rows = [];
    if (dir === -1) {
      for (let r = size - 1; r >= 0; r--) rows.push(r);
    } else {
      for (let r = 0; r < size; r++) rows.push(r);
    }

    for (const r of rows) {
      for (let dc = 0; dc < 2; dc++) {
        const col = c - dc;
        if (matrix[r]![col] === null) {
          const bit = bitIdx < finalBits.length ? finalBits[bitIdx]! === 1 : false;
          // Apply mask 0: (r + col) % 2 === 0
          const mask = (r + col) % 2 === 0;
          matrix[r]![col] = bit !== mask;
          bitIdx++;
        }
      }
    }
    dir = -dir;
  }

  return matrix.map((row) => row.map((cell) => cell ?? false));
}

export function generateQrSvg(text: string, options: QrOptions = {}): string {
  const matrix = generateQrMatrix(text);
  const size = matrix.length;
  const margin = options.margin ?? 2;
  const totalSize = size + margin * 2;
  const width = options.width ?? 220;
  const dark = options.color?.dark ?? '#0f172a';
  const light = options.color?.light ?? '#ffffff';

  let rects = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r]![c]) {
        rects += `<rect x="${c + margin}" y="${r + margin}" width="1" height="1" fill="${dark}" />`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalSize} ${totalSize}" width="${width}" height="${width}"><rect width="100%" height="100%" fill="${light}"/>${rects}</svg>`;
}

export async function toDataURL(text: string, options: QrOptions = {}): Promise<string> {
  const svg = generateQrSvg(text, options);
  const encoded = encodeURIComponent(svg)
    .replace(/'/g, '%27')
    .replace(/"/g, '%22');
  return `data:image/svg+xml;charset=utf-8,${encoded}`;
}

export async function toString(text: string, _options?: any): Promise<string> {
  const matrix = generateQrMatrix(text);
  return matrix.map((row) => row.map((cell) => (cell ? '██' : '  ')).join('')).join('\n');
}

export default {
  toDataURL,
  toString,
  generateQrSvg,
  generateQrMatrix,
};
