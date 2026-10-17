import { readFileSync, writeFileSync } from 'node:fs';
import { compile, parseSong } from '../src/core/compile.ts';
import type { Row } from '../src/core/driver.ts';
import { encodeInstrument, type AnyInstrument } from '../src/core/instruments.ts';
import { DUTY_NAMES, WAVE_LEVELS, type InstrumentKind } from '../src/core/schema.ts';
import type { UgeCell, UgeInstrument, UgeSong } from '../src/core/uge.ts';
import { emptyCell, emptyInstrument, writeUge } from '../test/uge-writer.ts';

// Writes a song as a V7 .uge, the way test/fixtures/halt_bug.uge was made:
//   node scripts/song-to-uge.ts src/app/demo/halt_bug.gbscore.json test/fixtures/halt_bug.uge
// The patterns are the compiler's, one per channel per order; the instruments and waves are the song's.

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node scripts/song-to-uge.ts <song.gbscore.json> <out.uge>');
  process.exit(1);
}
const parsed = parseSong(JSON.parse(readFileSync(input, 'utf8')));
if (!parsed.song) throw new Error(parsed.errors.map((e) => e.message).join('\n'));
const song = parsed.song;
const result = compile(song);
if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('\n'));
const data = result.data;

const cells = (rows: Row[], cell: (r: Row) => UgeCell) =>
  Array.from({ length: 64 }, (_, i) => (rows[i] ? cell(rows[i]) : emptyCell()));

const TYPE: Record<InstrumentKind, number> = { duty: 0, wave: 1, noise: 2 };

function instrument(kind: InstrumentKind, slot: number): UgeInstrument {
  const u = emptyInstrument(TYPE[kind], slot);
  const inst = (song.instruments[kind] as AnyInstrument[]).find((i) => i.id === slot + 1);
  if (!inst) return u;
  const enc = encodeInstrument(kind, inst);
  if (typeof enc === 'string') throw new Error(`${kind} instrument ${inst.id}: ${enc}`);
  Object.assign(u, { name: inst.name ?? '', length: inst.length, lengthEnabled: inst.lengthEnabled });
  if (enc.table) {
    u.subpatternEnabled = true;
    // In a table the driver's instrument byte is the jump, which hUGETracker keeps in the volume column.
    u.subpattern = cells(enc.table, (r) => ({ ...emptyCell(), note: r.note, volume: r.inst, effectCode: r.code, effectParams: r.param }));
  }
  if ('envDir' in inst) {
    Object.assign(u, { initialVolume: inst.volume, volSweepDirection: inst.envDir === 'up' ? 0 : 1, volSweepAmount: inst.envPace });
  }
  if ('duty' in inst) {
    Object.assign(u, {
      duty: DUTY_NAMES.indexOf(inst.duty),
      sweepTime: inst.sweepTime,
      sweepIncDec: inst.sweepDir === 'down' ? 1 : 0,
      sweepShift: inst.sweepShift,
    });
  }
  if ('wave' in inst) Object.assign(u, { waveform: inst.wave, outputLevel: WAVE_LEVELS.indexOf(inst.level) });
  if ('bits' in inst) u.counterStep = inst.bits === 7 ? 1 : 0;
  return u;
}

const orders = data.orders[0]!.length;
const patterns = new Map<number, UgeCell[]>();
for (let o = 0; o < orders; o++) {
  for (let ch = 0; ch < 4; ch++) {
    const rows = data.patterns[data.orders[ch]![o]!]!;
    patterns.set(o * 4 + ch, cells(rows, (r) => ({ ...emptyCell(), note: r.note, instrument: r.inst, effectCode: r.code, effectParams: r.param })));
  }
}
const bank = (kind: InstrumentKind) => Array.from({ length: 15 }, (_, i) => instrument(kind, i));
const uge: UgeSong = {
  version: 7,
  name: song.title ?? '',
  artist: '',
  comment: song.comment ?? '',
  duty: bank('duty'),
  wave: bank('wave'),
  noise: bank('noise'),
  waves: Array.from({ length: 16 }, (_, i) => {
    const w = song.waves.find((w) => w.id === i);
    return Array.from({ length: 32 }, (_, j) => (w ? parseInt(w.data[j]!, 16) : 0));
  }),
  ticksPerRow: data.groove,
  patterns,
  // Each channel's orders, then the tracker's unplayed trailer entry.
  orderMatrix: [0, 1, 2, 3].map((ch) => [...Array.from({ length: orders }, (_, o) => o * 4 + ch), 0]),
  routines: Array.from({ length: 16 }, () => ''),
};
writeFileSync(output, writeUge(uge));
