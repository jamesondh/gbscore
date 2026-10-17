// Note names follow hUGEDriver's own (C_3 is note 0, B_8 is note 71). That puts A5 at 440 Hz and C3 at 65.4 Hz,
// which is also how FL Studio names notes. In scientific pitch, where middle C is C4, every octave number here is
// one higher.

export const NOTE_COUNT = 72;
export const NO_NOTE = 90;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

export function noteName(index: number): string {
  return `${NAMES[index % 12]}${Math.floor(index / 12) + 3}`;
}

/** Returns the driver's note index, or an error message. */
export function parseNote(name: string): number | string {
  const m = /^([A-G][#b]?)(\d)$/.exec(name);
  if (!m) return `"${name}" isn't a note; write a name like C5 or F#4`;
  const [, pitch, octaveText] = m as unknown as [string, string, string];
  const sharp = FLATS[pitch];
  if (sharp) return `write ${sharp}${octaveText} instead of ${name}; notes use sharps`;
  const semitone = NAMES.indexOf(pitch);
  if (semitone < 0) return `"${name}" isn't a note; write a name like C5 or F#4`;
  const index = (Number(octaveText) - 3) * 12 + semitone;
  if (index < 0 || index >= NOTE_COUNT) return `${name} is out of range; notes run from C3 to B8`;
  return index;
}
