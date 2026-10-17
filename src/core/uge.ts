// Reads hUGETracker `.uge` files, versions 6 and 7 only. A port of hugecodec's reader.py; the layouts are
// FreePascal packed records (little-endian, enums are 4 bytes, ShortStrings are 256 bytes).

export interface UgeCell {
  note: number;
  instrument: number;
  volume: number; // unused by the driver; in tables this is the jump
  effectCode: number;
  effectParams: number;
}

export interface UgeInstrument {
  type: number; // 0 square, 1 wave, 2 noise
  name: string;
  length: number;
  lengthEnabled: boolean;
  initialVolume: number;
  volSweepDirection: number; // 0 up, 1 down
  volSweepAmount: number;
  sweepTime: number;
  sweepIncDec: number; // 0 up, 1 down
  sweepShift: number;
  duty: number;
  outputLevel: number;
  waveform: number;
  counterStep: number; // 0 fifteen-bit, 1 seven-bit
  subpatternEnabled: boolean;
  subpattern: UgeCell[]; // 64 cells; the driver uses the first 32
}

export interface UgeSong {
  version: number;
  name: string;
  artist: string;
  comment: string;
  duty: UgeInstrument[]; // 15 each, index 0 is instrument 1
  wave: UgeInstrument[];
  noise: UgeInstrument[];
  waves: number[][]; // 16 waves of 32 samples (0–15)
  ticksPerRow: number[]; // 4 values; V6 repeats its single value
  patterns: Map<number, UgeCell[]>;
  orderMatrix: number[][]; // 4 channels, each ending in an unplayed trailer entry
  routines: string[];
}

export class UgeError extends Error {}

class Reader {
  private bytes: Uint8Array;
  private view: DataView;
  pos = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number) {
    if (this.pos + n > this.bytes.length) {
      throw new UgeError(`file ends early: needed ${n} bytes at offset ${this.pos}`);
    }
  }
  int32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  byte(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }
  bool(): boolean {
    return this.byte() !== 0;
  }
  shortString(): string {
    this.need(256);
    const len = this.bytes[this.pos]!;
    const s = latin1(this.bytes.subarray(this.pos + 1, this.pos + 1 + len));
    this.pos += 256;
    return s;
  }
  ansiString(): string {
    const len = this.int32();
    if (len <= 0) return '';
    this.need(len);
    const s = latin1(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

function readPattern(r: Reader): UgeCell[] {
  const cells: UgeCell[] = [];
  for (let i = 0; i < 64; i++) {
    cells.push({
      note: r.int32(),
      instrument: r.int32(),
      volume: r.int32(),
      effectCode: r.int32(),
      effectParams: r.byte(),
    });
  }
  return cells;
}

const INSTRUMENT_SIZE = 1385;

function readInstrument(r: Reader): UgeInstrument {
  const start = r.pos;
  const inst: UgeInstrument = {
    type: r.int32(),
    name: r.shortString(),
    length: r.int32(),
    lengthEnabled: r.bool(),
    initialVolume: r.byte(),
    volSweepDirection: r.int32(),
    volSweepAmount: r.byte(),
    sweepTime: r.int32(),
    sweepIncDec: r.int32(),
    sweepShift: r.int32(),
    duty: r.byte(),
    outputLevel: r.int32(),
    waveform: r.int32(),
    counterStep: r.int32(),
    subpatternEnabled: r.bool(),
    subpattern: readPattern(r),
  };
  if (r.pos - start !== INSTRUMENT_SIZE) throw new UgeError(`instrument read ${r.pos - start} bytes`);
  return inst;
}

export function readUge(bytes: Uint8Array): UgeSong {
  const r = new Reader(bytes);
  const version = r.int32();
  if (version !== 6 && version !== 7) {
    throw new UgeError(
      `.uge version ${version} isn't supported; gbscore imports versions 6 and 7. ` +
        'Open the file in a current hUGETracker and save it to upgrade it.',
    );
  }
  const name = r.shortString();
  const artist = r.shortString();
  const comment = r.shortString();
  const bank = () => Array.from({ length: 15 }, () => readInstrument(r));
  const duty = bank();
  const wave = bank();
  const noise = bank();
  const waves: number[][] = [];
  for (let i = 0; i < 16; i++) waves.push(Array.from({ length: 32 }, () => r.byte()));
  let ticksPerRow: number[];
  if (version === 6) {
    const t = r.int32();
    ticksPerRow = [t, t, t, t];
  } else {
    ticksPerRow = [r.int32(), r.int32(), r.int32(), r.int32()];
  }
  r.bool(); // timer enabled: the game sets its own tick rate
  r.int32(); // timer divider
  const count = r.int32();
  if (count < 0 || count > 100_000) throw new UgeError(`implausible pattern count ${count}`);
  const patterns = new Map<number, UgeCell[]>();
  for (let i = 0; i < count; i++) {
    const key = r.int32();
    patterns.set(key, readPattern(r));
  }
  const orderMatrix: number[][] = [];
  for (let ch = 0; ch < 4; ch++) {
    const n = r.int32();
    if (n < 0 || n > 100_000) throw new UgeError(`implausible order count ${n}`);
    orderMatrix.push(Array.from({ length: n }, () => r.int32()));
  }
  const routines = Array.from({ length: 16 }, () => r.ansiString());
  return { version, name, artist, comment, duty, wave, noise, waves, ticksPerRow, patterns, orderMatrix, routines };
}
