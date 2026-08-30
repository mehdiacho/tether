/**
 * A QR encoder, in about 300 lines and with no dependencies.
 *
 * ## Why not `npm i qrcode`
 *
 * This image is meant to be published and self-hosted by strangers, and a QR
 * matrix is pure arithmetic over a fixed spec — no I/O, no platform quirks,
 * nothing that rots. Vendoring the maths is cheaper to audit than adding a
 * dependency tree to the one code path that hands out credentials.
 *
 * Byte mode only, which is all a URL needs. Versions 1-40, all four error
 * correction levels. Structure follows the reference decomposition in
 * ISO/IEC 18004: choose a version, build the bitstream, split into blocks,
 * append Reed-Solomon parity, interleave, draw, then pick the mask that scores
 * lowest against the spec's four penalty rules.
 *
 * Verified against the `qrcode` npm package: 1280 symbols covering all 40
 * versions x 4 EC levels x 8 masks, each at that version's exact byte capacity,
 * are identical module-for-module, and the capacity boundaries agree in both
 * directions. Output also round-trips through the `jsQR` decoder. The one place
 * the two implementations differ is which mask they pick when left to choose —
 * the spec fixes the penalty rules but implementations read rule 3 differently,
 * and either choice decodes.
 */

export type EcLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** Width and height in modules, excluding the quiet zone. */
  readonly size: number;
  /** `modules[y][x]` — true is dark. */
  readonly modules: readonly boolean[][];
  readonly version: number;
  readonly ecLevel: EcLevel;
  /** Which of the eight mask patterns scored lowest. */
  readonly mask: number;
}

/* -------------------------------------------------------------- spec data -- */

/** Error correction codewords per block, indexed by version. */
const ECC_PER_BLOCK: Record<EcLevel, readonly number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** Number of error correction blocks, indexed by version. */
const EC_BLOCKS: Record<EcLevel, readonly number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** The two-bit code each EC level carries in the format information. */
const FORMAT_BITS: Record<EcLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/* ------------------------------------------------------------- GF(256) ---- */

/** Multiply in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1, the QR field. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial for `degree` parity codewords, minus its leading 1. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j] = result[j]! ^ result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) result[i] = result[i]! ^ gfMul(divisor[i]!, factor);
  }
  return result;
}

/* ------------------------------------------------------------- geometry --- */

/** Total module count available to data and parity, before the 8-bit floor. */
function rawDataModules(version: number): number {
  const size = version * 4 + 17;
  let result = size * size;
  result -= 8 * 8 * 3; // three finder patterns and their separators
  result -= 15 * 2 + 1; // format information and the always-dark module
  result -= (size - 16) * 2; // timing patterns
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    result -= (n - 1) * (n - 1) * 25; // alignment patterns
    result -= (n - 2) * 2 * 20; // ...minus where they overlap the timing pattern
    if (version >= 7) result -= 6 * 3 * 2; // version information
  }
  return result;
}

function dataCodewords(version: number, ecl: EcLevel): number {
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_PER_BLOCK[ecl][version]! * EC_BLOCKS[ecl][version]!
  );
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const n = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (n * 2 - 2)) * 2;
  const result: number[] = [];
  for (let i = 0, pos = version * 4 + 10; i < n - 1; i++, pos -= step) result.unshift(pos);
  result.unshift(6);
  return result;
}

/* ------------------------------------------------------------- encoding --- */

/** Byte mode's character-count field widens once, at version 10. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

class BitBuffer {
  readonly bits: number[] = [];
  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function buildCodewords(data: Uint8Array, version: number, ecl: EcLevel): number[] {
  const bb = new BitBuffer();
  bb.append(0b0100, 4); // byte mode
  bb.append(data.length, charCountBits(version));
  for (const b of data) bb.append(b, 8);

  const capacity = dataCodewords(version, ecl) * 8;
  // Terminator, then pad to a whole codeword, then the spec's alternating filler.
  bb.append(0, Math.min(4, capacity - bb.bits.length));
  bb.append(0, (8 - (bb.bits.length % 8)) % 8);
  for (let pad = 0xec; bb.bits.length < capacity; pad ^= 0xec ^ 0x11) bb.append(pad, 8);

  const codewords = new Array<number>(bb.bits.length / 8).fill(0);
  bb.bits.forEach((bit, i) => {
    codewords[i >>> 3]! |= bit << (7 - (i & 7));
  });
  return codewords;
}

/**
 * Split into blocks, add parity to each, then interleave.
 *
 * Interleaving is what makes the format resilient to a smudge: a physical blot
 * damages consecutive modules, which after de-interleaving is a few correctable
 * bytes spread across every block rather than one block destroyed outright.
 */
function addEccAndInterleave(data: readonly number[], version: number, ecl: EcLevel): number[] {
  const numBlocks = EC_BLOCKS[ecl][version]!;
  const eccLen = ECC_PER_BLOCK[ecl][version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    // Short blocks get a placeholder so every block is the same length here;
    // the interleave below skips it rather than emitting it.
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]!);
    });
  }
  return result;
}

/* -------------------------------------------------------------- drawing --- */

class Canvas {
  readonly size: number;
  readonly modules: boolean[][];
  /** Function modules are exempt from masking and skipped when placing data. */
  private readonly isFunction: boolean[][];

  // Written out rather than declared as constructor parameter properties: Node
  // strips types rather than compiling them, and that syntax needs a compiler.
  readonly version: number;
  readonly ecLevel: EcLevel;

  constructor(version: number, ecLevel: EcLevel) {
    this.version = version;
    this.ecLevel = ecLevel;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  private set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);

    const align = alignmentPositions(this.version);
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        // The three corners belong to the finder patterns.
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === align.length - 1) ||
          (i === align.length - 1 && j === 0);
        if (!corner) this.drawAlignment(align[i]!, align[j]!);
      }
    }

    this.drawFormatBits(0); // placeholder; rewritten once the mask is chosen
    this.drawVersionBits();
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
          this.set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormatBits(mask: number): void {
    const data = (FORMAT_BITS[this.ecLevel] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;

    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(i));
    this.set(8, this.size - 8, true); // the module that is always dark
  }

  private drawVersionBits(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  /** Place codewords in the spec's upward/downward two-module-wide zigzag. */
  drawCodewords(data: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // the vertical timing pattern is not a data column
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  /** XOR the mask pattern over every non-function module. Self-inverse. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.isFunction[y]![x]) continue;
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  /**
   * The spec's four penalty rules: long same-colour runs, 2x2 blocks, patterns
   * that look like a finder, and an overall light/dark imbalance. Lower is
   * better; the winning mask is the one a scanner is least likely to misread.
   */
  penalty(): number {
    let result = 0;

    for (let y = 0; y < this.size; y++) {
      let runColor = false;
      let runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y]![x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          this.pushRun(runLen, history);
          if (!runColor) result += this.finderPatterns(history) * PENALTY_N3;
          runColor = this.modules[y]![x]!;
          runLen = 1;
        }
      }
      result += this.terminateRun(runColor, runLen, history) * PENALTY_N3;
    }

    for (let x = 0; x < this.size; x++) {
      let runColor = false;
      let runLen = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < this.size; y++) {
        if (this.modules[y]![x] === runColor) {
          runLen++;
          if (runLen === 5) result += PENALTY_N1;
          else if (runLen > 5) result++;
        } else {
          this.pushRun(runLen, history);
          if (!runColor) result += this.finderPatterns(history) * PENALTY_N3;
          runColor = this.modules[y]![x]!;
          runLen = 1;
        }
      }
      result += this.terminateRun(runColor, runLen, history) * PENALTY_N3;
    }

    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const c = this.modules[y]![x];
        if (
          c === this.modules[y]![x + 1] &&
          c === this.modules[y + 1]![x] &&
          c === this.modules[y + 1]![x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }

    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  }

  private pushRun(runLen: number, history: number[]): void {
    if (history[0] === 0) runLen += this.size; // the quiet zone counts as light
    history.pop();
    history.unshift(runLen);
  }

  private terminateRun(runColor: boolean, runLen: number, history: number[]): number {
    if (runColor) {
      this.pushRun(runLen, history);
      runLen = 0;
    }
    this.pushRun(runLen + this.size, history);
    return this.finderPatterns(history);
  }

  /** Count 1:1:3:1:1 sequences with a wide light margin on either side. */
  private finderPatterns(history: readonly number[]): number {
    const n = history[1]!;
    const core =
      n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (
      (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    );
  }
}

/* ---------------------------------------------------------------- public -- */

export class QrTooLongError extends Error {}

/**
 * Encode `text` as the smallest QR symbol that fits it at the given error
 * correction level.
 *
 * `forceMask` exists for testing — pinning the mask is what lets this be
 * compared module-for-module against another implementation without the two
 * mask heuristics disagreeing. Leave it undefined in production.
 */
export function encodeQr(text: string, ecLevel: EcLevel = 'M', forceMask?: number): QrMatrix {
  const data = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 40; v++) {
    if (4 + charCountBits(v) + data.length * 8 <= dataCodewords(v, ecLevel) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    throw new QrTooLongError(`${data.length} bytes is too long for a QR code at level ${ecLevel}.`);
  }

  const canvas = new Canvas(version, ecLevel);
  canvas.drawFunctionPatterns();
  canvas.drawCodewords(addEccAndInterleave(buildCodewords(data, version, ecLevel), version, ecLevel));

  // Try all eight masks and keep the least penalised, as the spec requires.
  let bestMask = forceMask ?? 0;
  if (forceMask === undefined) {
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      canvas.applyMask(mask);
      canvas.drawFormatBits(mask);
      const p = canvas.penalty();
      if (p < bestPenalty) {
        bestPenalty = p;
        bestMask = mask;
      }
      canvas.applyMask(mask); // undo
    }
  }
  canvas.applyMask(bestMask);
  canvas.drawFormatBits(bestMask);

  return { size: canvas.size, modules: canvas.modules, version, ecLevel, mask: bestMask };
}

export interface SvgOptions {
  /** Quiet zone in modules. The spec says four; below that, scanners struggle. */
  border?: number;
  dark?: string;
  light?: string;
  /** Value for the SVG's own width/height. Omit for a viewBox-only, fluid SVG. */
  size?: string;
}

/**
 * Render as an SVG path.
 *
 * One path with many subpaths rather than a rect per module: a version-10 code
 * is 3600 modules, and 3600 elements is enough to make a phone browser stutter
 * on a panel that also runs a countdown.
 */
export function toSvg(qr: QrMatrix, options: SvgOptions = {}): string {
  const border = options.border ?? 4;
  const dark = options.dark ?? '#000000';
  const light = options.light ?? '#ffffff';
  const dim = qr.size + border * 2;

  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]![x]) parts.push(`M${x + border},${y + border}h1v1h-1z`);
    }
  }

  const sizeAttr = options.size ? ` width="${options.size}" height="${options.size}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"${sizeAttr} ` +
    `shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${parts.join('')}" fill="${dark}"/>` +
    `</svg>`
  );
}

/**
 * Render for a terminal, two module rows per text row.
 *
 * Colours are set explicitly rather than relying on block characters against
 * the terminal's own background: a dark-themed terminal would otherwise render
 * an inverted code, which most phone scanners refuse.
 */
export function toAnsi(qr: QrMatrix, border = 2): string {
  const dim = qr.size + border * 2;
  const dark = (y: number, x: number): boolean => {
    const my = y - border;
    const mx = x - border;
    if (my < 0 || mx < 0 || my >= qr.size || mx >= qr.size) return false;
    return qr.modules[my]![mx]!;
  };

  const lines: string[] = [];
  for (let y = 0; y < dim; y += 2) {
    let line = '';
    for (let x = 0; x < dim; x++) {
      const top = dark(y, x) ? 0 : 15;
      const bottom = y + 1 < dim && dark(y + 1, x) ? 0 : 15;
      line += `\x1b[38;5;${top}m\x1b[48;5;${bottom}m▀`;
    }
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n');
}
