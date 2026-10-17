import { DUTY_NAMES, type Effect, type InstrumentKind } from './schema.ts';

// Named effects to and from hUGEDriver's effect code and parameter byte. `kind` is the channel the effect runs on
// (a lane's instrument kind, or a table's instrument kind), because 9xx means duty, wave or noise mode by channel.

export interface Fx {
  code: number;
  param: number;
}

// Codes a lane or table effect may use. 5, 8 and F are song-wide (`global`), B and D are the compiler's own jumps,
// and 6 (routines) isn't supported.
const LANE_CODES = new Set([0x0, 0x1, 0x2, 0x3, 0x4, 0x7, 0x9, 0xa, 0xc, 0xe]);

// The driver runs a table's effect from the second byte of its handler (do_table → do_effect.no_set_offset), which
// skips a one-byte tick check. Glide and delay start with a two-byte jump, so they'd run garbage; cut starts with
// the comparison against its tick, so it would fire on tick 0 instead.
export const TABLE_UNSAFE: Record<number, string> = {
  0x3: 'glide (3xx) breaks in tables: the driver runs table effects from their second byte',
  0x7: 'delay (7xx) breaks in tables: the driver runs table effects from their second byte',
  0xe: "cut (Exx) doesn't work in tables: it would ignore its tick and fire only on a row's first tick",
};

export function effectKey(fx: Effect): keyof Effect | undefined {
  const keys = Object.keys(fx) as (keyof Effect)[];
  return keys.length === 1 ? keys[0] : undefined;
}

/** Encodes a named effect, or returns an error message. */
export function encodeEffect(fx: Effect, kind: InstrumentKind, inTable = false): Fx | string {
  const enc = encode(fx, kind);
  if (inTable && typeof enc !== 'string' && TABLE_UNSAFE[enc.code]) return TABLE_UNSAFE[enc.code]!;
  return enc;
}

function encode(fx: Effect, kind: InstrumentKind): Fx | string {
  const keys = Object.keys(fx);
  if (keys.length !== 1) return `an effect needs exactly one key, not ${keys.length}: ${JSON.stringify(fx)}`;
  const nib = (p: [number, number]) => (p[0] << 4) | p[1];
  if (fx.arp) {
    if (fx.arp[0] === 0 && fx.arp[1] === 0) return 'arp [0, 0] does nothing; remove it';
    return { code: 0x0, param: nib(fx.arp) };
  }
  if (fx.slideUp !== undefined) return { code: 0x1, param: fx.slideUp };
  if (fx.slideDown !== undefined) return { code: 0x2, param: fx.slideDown };
  if (fx.glide !== undefined) return { code: 0x3, param: fx.glide };
  if (fx.vibrato) return { code: 0x4, param: nib(fx.vibrato) };
  if (fx.delay !== undefined) return { code: 0x7, param: fx.delay };
  if (fx.duty !== undefined) {
    if (kind !== 'duty') return `duty only works on pulse lanes and duty instruments`;
    return { code: 0x9, param: DUTY_NAMES.indexOf(fx.duty) << 6 };
  }
  if (fx.wave !== undefined) {
    if (kind !== 'wave') return `wave only works on the wave lane and wave instruments`;
    return { code: 0x9, param: fx.wave };
  }
  if (fx.volSlide) return { code: 0xa, param: nib(fx.volSlide) };
  if (fx.volume !== undefined) return { code: 0xc, param: fx.volume };
  if (fx.cut !== undefined) return { code: 0xe, param: fx.cut };
  if (fx.raw !== undefined) {
    const code = parseInt(fx.raw[0]!, 16);
    const param = parseInt(fx.raw.slice(1), 16);
    if (!LANE_CODES.has(code)) {
      return `raw ${fx.raw} isn't allowed: ${code.toString(16).toUpperCase()}xx is ${RESERVED[code]}`;
    }
    const named = decodeEffect(code, param, kind);
    if (named && !named.raw) return `write ${JSON.stringify(named)} instead of raw ${fx.raw}`;
    return { code, param };
  }
  return `unknown effect ${JSON.stringify(fx)}`;
}

/** The byte of the waves that 9xx on the wave channel copies 16 bytes from: swap(xx), so wave xx for xx up to 15,
 * and a read that straddles two waves above that, which imported songs use. */
export const waveReadStart = (param: number) => ((param << 4) | (param >> 4)) & 0xff;

const RESERVED: Record<number, string> = {
  0x5: 'song-wide; use masterVolume in global',
  0x6: "a routine call, which gbscore doesn't support",
  0x8: 'song-wide; use pan in global',
  0xb: 'a jump, which the compiler adds itself',
  0xd: 'a pattern break, which the compiler adds itself',
  0xf: 'song-wide; use tempo in global',
};

/** Names an effect from its code and parameter: null for "no effect", raw when no name fits. */
export function decodeEffect(code: number, param: number, kind: InstrumentKind): Effect | null {
  const hi = param >> 4;
  const lo = param & 15;
  const raw = () => ({ raw: (code.toString(16) + param.toString(16).padStart(2, '0')).toUpperCase() });
  switch (code) {
    case 0x0:
      return param === 0 ? null : { arp: [hi, lo] };
    case 0x1:
      return { slideUp: param };
    case 0x2:
      return { slideDown: param };
    case 0x3:
      return { glide: param };
    case 0x4:
      return { vibrato: [hi, lo] };
    case 0x7:
      return { delay: param };
    case 0x9:
      if (kind === 'duty' && (param & 0x3f) === 0) return { duty: DUTY_NAMES[param >> 6]! };
      if (kind === 'wave' && param <= 15) return { wave: param };
      return raw();
    case 0xa:
      return { volSlide: [hi, lo] };
    case 0xc:
      return hi === 0 ? { volume: lo } : raw();
    case 0xe:
      return { cut: param };
    default:
      return raw();
  }
}

export function describeEffect(fx: Effect): string {
  const key = effectKey(fx);
  if (!key) return JSON.stringify(fx);
  const value = fx[key];
  return `${key} ${Array.isArray(value) ? value.join(',') : String(value)}`;
}
