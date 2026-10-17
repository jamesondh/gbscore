import { readFileSync } from 'node:fs';
import { NO_NOTE } from '../src/core/notes.ts';
import { type DriverSong, type Instrument, type Row } from '../src/core/driver.ts';

// Decodes the C that uge2source writes back into driver data. This reads uge2source's output text, not the .uge,
// so it doesn't share code with our reader. gbscore export writes the same form, so it reads that too.

const NOTE_NAMES = ['C_', 'Cs', 'D_', 'Ds', 'E_', 'F_', 'Fs', 'G_', 'Gs', 'A_', 'As', 'B_'];

function cNote(token: string): number {
  if (token === '___') return NO_NOTE;
  if (/^\d+$/.test(token)) return Number(token);
  const i = NOTE_NAMES.indexOf(token.slice(0, 2));
  if (i < 0) throw new Error(`bad note ${token}`);
  return (Number(token[2]) - 3) * 12 + i;
}

function cRows(body: string): Row[] {
  return [...body.matchAll(/DN\(([^,]+),(\d+),0x([0-9A-F]{3})\)/g)].map((m) => {
    const fx = parseInt(m[3]!, 16);
    return { note: cNote(m[1]!), inst: Number(m[2]), code: fx >> 8, param: fx & 0xff };
  });
}

export function readReference(path: string): DriverSong {
  const c = readFileSync(path, 'utf8');
  const arrays = new Map<string, Row[]>();
  for (const m of c.matchAll(/static const unsigned char (\w+)\[\] = \{\n([\s\S]*?)\};/g)) {
    if (m[1] !== 'waves') arrays.set(m[1]!, cRows(m[2]!));
  }
  const patternIndex = new Map<string, number>();
  const patterns: Row[][] = [];
  const orders: number[][] = [];
  for (let ch = 1; ch <= 4; ch++) {
    const m = new RegExp(`order${ch}\\[\\] = \\{([^}]*)\\};`).exec(c);
    if (!m) throw new Error(`no order${ch}`);
    orders.push(
      m[1]!.split(',').map((name) => {
        let i = patternIndex.get(name);
        if (i === undefined) {
          i = patterns.length;
          patterns.push(arrays.get(name)!);
          patternIndex.set(name, i);
        }
        return i;
      }),
    );
  }

  const instruments = (type: string, pointerAt: number): Instrument[] => {
    const m = new RegExp(`hUGE${type}Instr_t \\w+\\[\\] = \\{\\n([\\s\\S]*?)\\n\\};`).exec(c);
    if (!m) return [];
    return [...m[1]!.matchAll(/\{([^}]*)\}/g)].map((line) => {
      const parts = line[1]!.split(',');
      const pointer = parts.splice(pointerAt, 1)[0]!;
      return { fields: parts.map(Number), table: pointer === '0' ? null : arrays.get(pointer)! };
    });
  };

  const wavesMatch = /static const unsigned char waves\[\] = \{\n([\s\S]*?)\};/.exec(c);
  const waves = wavesMatch
    ? wavesMatch[1]!
        .trim()
        .split('\n')
        .map((line) => line.split(',').filter((x) => x.trim() !== '').map(Number))
    : [];

  const header = /hUGESong_t \w+ = \{(\d+), (\d+), (\d+), (\d+), (\d+),/.exec(c);
  if (!header) throw new Error('no song header');
  const groove = header.slice(1, 5).map(Number);
  if (Number(header[5]) !== orders[0]!.length * 2) throw new Error('order_cnt disagrees with order1');

  return {
    groove,
    orders,
    patterns,
    duty: instruments('Duty', 3),
    wave: instruments('Wave', 3),
    noise: instruments('Noise', 1),
    waves,
  };
}
