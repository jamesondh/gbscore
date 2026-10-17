import { z } from 'zod';

// The song file. Key order here is the key order `gbscore fmt` writes. Rules that span fields (overlaps, effect
// slots, ranges that depend on the groove) live in check.ts, not here.

const int = (min: number, max: number) => z.int().min(min).max(max);
const nibble = int(0, 15);
const byte = int(0, 255);
const pair = (description: string) => z.tuple([nibble, nibble]).describe(description);

export const DUTY_NAMES = ['12.5%', '25%', '50%', '75%'] as const;
export const WAVE_LEVELS = ['0%', '100%', '50%', '25%'] as const; // index is the NR32 level value
export const PAN_NAMES = ['off', 'R', 'L', 'LR'] as const; // index is (left << 1) | right

export const effectSchema = z
  .strictObject({
    arp: pair('0xy: arpeggio, cycling the note, +x and +y semitones each tick.'),
    slideUp: byte.describe('1xx: slide the pitch up by xx units per tick.'),
    slideDown: byte.describe('2xx: slide the pitch down by xx units per tick.'),
    glide: byte.describe("3xx: glide toward this row's note by xx units per tick (tone portamento)."),
    vibrato: pair('4xy: vibrato with speed x and depth y.'),
    duty: z.enum(DUTY_NAMES).describe('9xx on pulse lanes and duty tables: set the duty cycle.'),
    wave: nibble.describe('9xx on the wave lane and wave tables: switch to wave n.'),
    volSlide: pair('Axy: retrigger the note with its volume raised by x and lowered by y.'),
    volume: nibble.describe('C0v: set the volume (0–15) and restart the note. The wave channel has 4 levels.'),
    cut: byte.describe('Exx: cut the note at tick xx of this row.'),
    delay: byte.describe("7xx: start this row's note xx ticks late."),
    raw: z
      .string()
      .regex(/^[0-9A-F]{3}$/)
      .describe(
        'An effect as tracker hex, e.g. "9D0". Only for values the named effects can\'t express, such as duty ' +
          'bytes with length bits.',
      ),
  })
  .partial()
  .meta({ id: 'Effect', description: 'One effect: an object with exactly one key.' });

const tableRowSchema = z
  .strictObject({
    note: int(-36, 35).optional().describe('Semitones from the playing note. Omit to leave the pitch alone.'),
    jump: int(0, 30).optional().describe('After this row, continue at this table row instead of the next one.'),
    fx: effectSchema.optional(),
  })
  .meta({ id: 'TableRow', description: 'One tick of an instrument table.' });

const tableSchema = z
  .array(tableRowSchema)
  .min(1)
  .max(32)
  .describe(
    'Runs one row per tick from the start of each note. After row 31 it goes back to row 0, unless a row jumps. ' +
      'Missing rows at the end are empty.',
  );

const id = z.int().min(1).max(15).describe('The number notes use to pick this instrument (1–15).');
const name = z.string().optional().describe('A label for people; never changes the sound.');
const envDir = z.enum(['up', 'down']).default('down').describe('Envelope direction.');
const envPace = int(0, 7).default(0).describe('Envelope pace: ticks of 1/64 s per volume step. 0 holds the volume.');
const lengthEnabled = z.boolean().default(false).describe('Whether the note stops by itself after `length`.');

export const dutyInstrumentSchema = z.strictObject({
  id,
  name,
  duty: z.enum(DUTY_NAMES).describe('Duty cycle: the pulse width, from thin (12.5%) to hollow (50%).'),
  volume: nibble.describe('Starting volume, 0–15.'),
  envDir,
  envPace,
  sweepTime: int(0, 7).default(0).describe('Pitch sweep pace (pulse 1 only). 0 turns the sweep off.'),
  sweepDir: z.enum(['up', 'down']).default('down').describe('Pitch sweep direction.'),
  sweepShift: int(0, 7).default(0).describe('Pitch sweep step size: each step changes the period by period / 2^shift.'),
  length: int(0, 63).default(0).describe('Length counter: the note lasts (64 − length) / 256 s when enabled.'),
  lengthEnabled,
  table: tableSchema.optional(),
}).meta({ id: 'DutyInstrument' });

export const waveInstrumentSchema = z.strictObject({
  id,
  name,
  wave: nibble.describe('Which wave to play.'),
  level: z.enum(WAVE_LEVELS).describe('Output level.'),
  length: byte.default(0).describe('Length counter: the note lasts (256 − length) / 256 s when enabled.'),
  lengthEnabled,
  table: tableSchema.optional(),
}).meta({ id: 'WaveInstrument' });

export const noiseInstrumentSchema = z.strictObject({
  id,
  name,
  volume: nibble.describe('Starting volume, 0–15.'),
  envDir,
  envPace,
  bits: z.literal([15, 7]).default(15).describe('Noise mode: 15-bit (hiss) or 7-bit (buzzy, more tonal).'),
  length: int(0, 63).default(0).describe('Length counter: the note lasts (64 − length) / 256 s when enabled.'),
  lengthEnabled,
  table: tableSchema.optional(),
}).meta({ id: 'NoiseInstrument' });

const itemFields = {
  row: z.int().min(0).describe('Row on the song timeline, counting from 0.'),
  len: z
    .int()
    .min(1)
    .optional()
    .describe('Notes: rows the note lasts; it is cut when they end. Placements: rows it plays, cutting its last repeat short.'),
  note: z.string().optional().describe('Note name, C3 to B8 (A5 is 440 Hz). Omit for an effect without a note.'),
  inst: id
    .optional()
    .describe("Instrument number. Every note needs inst, or legato. On a placement, the instrument its pattern's notes play with."),
  legato: z
    .literal(true)
    .optional()
    .describe(
      "Change pitch without restarting the note: no new attack, and the previous note's instrument, envelope and " +
        'table carry on. Pulse and noise lanes only; on noise it also returns to 15-bit mode.',
    ),
  fx: effectSchema.optional().describe("An effect on this row. Notes can't use cut; use cutTick."),
  cutTick: byte
    .optional()
    .describe("End the note at this tick of its last row, instead of when the row after it starts."),
};

const patternItemSchema = z
  .strictObject({
    ...itemFields,
    row: z.int().min(0).describe("Row in the pattern, counting from 0 at the pattern's start."),
  })
  .meta({ id: 'PatternItem', description: 'A note or an effect in a pattern, as in a lane.' });

const laneItemSchema = z
  .strictObject({
    ...itemFields,
    pattern: z.string().optional().describe('Places the pattern with this id here. A placement has no fields but row, transpose, repeat, inst and len.'),
    transpose: int(-71, 71).optional().describe("Placements only: semitones added to the pattern's notes."),
    repeat: z.int().min(1).optional().describe('Placements only: how many times the pattern plays, back to back. 1 if left out.'),
  })
  .meta({
    id: 'LaneItem',
    description:
      'A note (row, len, note, inst or legato), an effect without a note (row, fx), or a placed pattern (row, pattern, ' +
      'transpose, repeat, inst, len).',
  });

export const patternSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^\S(?:.{0,30}\S)?$/)
      .describe('The name placements use: 1 to 32 characters, no spaces at either end, unique in the song.'),
    kind: z.enum(['duty', 'wave', 'noise']).describe('The instruments its notes use. A duty pattern goes on either pulse lane.'),
    length: z.int().min(1).describe('Length in rows. Every item starts before it and every note ends by it.'),
    items: z.array(patternItemSchema).default([]).describe('Notes and effects, as in a lane, with rows from the pattern start.'),
  })
  .meta({ id: 'Pattern', description: 'A run of notes for one lane, placed on the timeline by lane items with `pattern`.' });

const lanesSchema = z.strictObject({
  pulse1: z.array(laneItemSchema).default([]).describe('Pulse channel 1, with duty instruments. The only one with pitch sweep.'),
  pulse2: z.array(laneItemSchema).default([]).describe('Pulse channel 2, with duty instruments.'),
  wave: z.array(laneItemSchema).default([]).describe('The wave channel, with wave instruments.'),
  noise: z.array(laneItemSchema).default([]).describe('The noise channel, with noise instruments. Higher notes are higher-pitched noise.'),
}).describe('One lane per Game Boy sound channel. Items sort by row.');

const globalItemSchema = z
  .strictObject({
    row: z.int().min(0).describe('Row on the song timeline, counting from 0.'),
    tempo: int(1, 255)
      .optional()
      .describe('Fxx: every row from here takes this many ticks, so the groove becomes uniform.'),
    pan: z
      .tuple([z.enum(PAN_NAMES), z.enum(PAN_NAMES), z.enum(PAN_NAMES), z.enum(PAN_NAMES)])
      .optional()
      .describe('8xx: which speakers pulse1, pulse2, wave and noise play on.'),
    masterVolume: z
      .tuple([int(0, 7), int(0, 7)])
      .optional()
      .describe('5xx: left and right master volume, 0–7.'),
  })
  .meta({ id: 'GlobalItem', description: 'A song-wide effect: row plus exactly one of tempo, pan or masterVolume.' });

export const songSchema = z
  .strictObject({
    $schema: z.string().optional().describe('Optional path or URL of gbscore.schema.json, for editors.'),
    version: z.literal(1).describe('The file format version.'),
    title: z.string().optional().describe('The song title.'),
    artist: z.string().optional().describe('Who wrote it.'),
    comment: z.string().optional().describe('Notes for people.'),
    grid: z
      .strictObject({
        rowsPerBeat: int(1, 64).describe('Rows per beat; 4 makes a row a sixteenth note.'),
        beatsPerBar: int(1, 64).describe('Beats per bar.'),
      })
      .describe('For display only. Never changes the sound.'),
    groove: z
      .tuple([int(1, 255), int(1, 255), int(1, 255), int(1, 255)])
      .describe('Ticks per row, cycling every 4 rows. The game ticks at 60.24 Hz.'),
    length: z.int().min(1).describe('Song length in rows.'),
    loop: z.int().min(0).default(0).describe('The row the song loops back to after its last row.'),
    instruments: z
      .strictObject({
        duty: z.array(dutyInstrumentSchema).default([]),
        wave: z.array(waveInstrumentSchema).default([]),
        noise: z.array(noiseInstrumentSchema).default([]),
      })
      .describe('Pulse lanes use duty instruments; the wave and noise lanes use their own.'),
    waves: z
      .array(
        z.strictObject({
          id: nibble.describe('The number wave instruments and the wave effect use (0–15).'),
          name,
          data: z
            .string()
            .regex(/^[0-9A-F]{32}$/)
            .describe('32 samples, one hex digit (0–F) each.'),
        }),
      )
      .default([])
      .describe('Wave shapes for the wave channel.'),
    patterns: z
      .array(patternSchema)
      .optional()
      .describe('Reusable runs of notes. A lane item with `pattern` plays one at its row.'),
    lanes: lanesSchema,
    global: z.array(globalItemSchema).default([]).describe('Song-wide effects. The compiler puts each on a lane with a free effect slot.'),
  })
  .describe('A gbscore song.');

export type Song = z.output<typeof songSchema>;
export type SongInput = z.input<typeof songSchema>;
export type Effect = z.output<typeof effectSchema>;
export type LaneItem = z.output<typeof laneItemSchema>;
export type PatternItem = z.output<typeof patternItemSchema>;
export type Pattern = z.output<typeof patternSchema>;
export type GlobalItem = z.output<typeof globalItemSchema>;
export type TableRow = z.output<typeof tableRowSchema>;
export type DutyInstrument = z.output<typeof dutyInstrumentSchema>;
export type WaveInstrument = z.output<typeof waveInstrumentSchema>;
export type NoiseInstrument = z.output<typeof noiseInstrumentSchema>;

export const LANES = ['pulse1', 'pulse2', 'wave', 'noise'] as const;
export type LaneName = (typeof LANES)[number];
export type InstrumentKind = 'duty' | 'wave' | 'noise';
export const LANE_KIND: Record<LaneName, InstrumentKind> = {
  pulse1: 'duty',
  pulse2: 'duty',
  wave: 'wave',
  noise: 'noise',
};
