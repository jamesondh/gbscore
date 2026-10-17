import { NOTE_COUNT, noteName } from '../core/notes.ts';
import { audition, enterNote, release as releaseNote, say, setEntry, setKeysDown, setPlayKeys, useApp } from './store.ts';

// Note entry (docs/editor/, "Note entry"): with it on, two rows of the computer keyboard play like a piano, as in
// Ableton, and so does a MIDI keyboard. Each note goes in at the flag, which then moves to its end. Notes pressed
// together, as a chord, go in at the same row, and the last wins, since a lane plays one note at a time.
// Play keys, with note entry off, plays the same keys without entering anything: each note sounds while its key is
// held, one at a time, as on a channel. Clicking the roll's keyboard plays a note the same way, either way. The
// roll's keyboard shows the notes whose keys are down.

/** The keys that play notes, by where they are on the keyboard (KeyboardEvent.code), in semitones above the
 * note A plays. */
export const PIANO: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
  Quote: 17,
};

// MIDI note 36 is C3 here: names follow hUGEDriver's, an octave above scientific pitch (src/core/notes.ts).
const MIDI_C3 = 36;
// Notes pressed within this long of the last, while it's still held, are a chord. Fast playing overlaps notes too,
// but not by this little.
const CHORD_MS = 40;

const held = new Map<string, number>(); // keys and MIDI notes down now, and the notes they play
let last: { id: string; row: number; at: number } | undefined; // the first note of the last chord, or the last note
let sounding: string | undefined; // the key Play keys is sounding

/** A key or MIDI note pressed: enters the note, or with Play keys or `play`, plays it until it's released. Key
 * repeat and a note already held do nothing. */
export function press(id: string, index: number, play = false) {
  if (held.has(id)) return;
  held.set(id, index);
  if (index < 0 || index >= NOTE_COUNT) {
    say(`That note is out of range: notes run from C3 to B8${index < 0 ? '' : `, and it's ${noteName(index)}`}.`, true);
    return;
  }
  showHeld();
  if (play || !useApp.getState().entry) {
    if (audition(index)) sounding = id; // else what was sounding still is
    return;
  }
  const now = performance.now();
  const chord = !!last && last.id !== id && held.has(last.id) && now - last.at < CHORD_MS;
  const row = chord ? last!.row : useApp.getState().startRow;
  if (enterNote(index, row, !chord) && !chord) last = { id, row, at: now };
}

export function release(id: string) {
  if (!held.delete(id)) return;
  showHeld();
  if (sounding === id) {
    releaseNote();
    sounding = undefined;
  }
}

/** Forgets what's held, as when the window loses focus and key-ups would go elsewhere, and stops what Play keys is
 * sounding. */
export function releaseAll() {
  held.clear();
  showHeld();
  last = undefined;
  if (sounding) releaseNote();
  sounding = undefined;
}

/** Shows the notes held on the roll's keyboard. */
function showHeld() {
  setKeysDown([...new Set(held.values())].filter((i) => i >= 0 && i < NOTE_COUNT));
}

let midi: Promise<void> | undefined;

/** Connects MIDI keyboards, the first time, if the browser can. */
function listenToMidi() {
  if (!midi && 'requestMIDIAccess' in navigator) midi = connectMidi();
}

/** At startup, with Play keys remembered on, connects MIDI keyboards if the browser already lets the app, so it
 * doesn't ask before anyone has touched anything. */
export async function resumeMidi() {
  if (!useApp.getState().playKeys) return;
  const status = await navigator.permissions?.query({ name: 'midi' as PermissionName }).catch(() => undefined);
  if (status?.state === 'granted') listenToMidi();
}

/** Turns note entry on or off. Turning it on connects MIDI keyboards. */
export function toggleEntry() {
  const on = !useApp.getState().entry;
  setEntry(on);
  releaseAll();
  if (on) listenToMidi();
}

/** Turns Play keys on or off. Turning it on connects MIDI keyboards. */
export function togglePlayKeys() {
  const on = !useApp.getState().playKeys;
  setPlayKeys(on);
  releaseAll();
  if (on) listenToMidi();
}

async function connectMidi() {
  try {
    const access = await navigator.requestMIDIAccess();
    const listen = () => access.inputs.forEach((input) => (input.onmidimessage = onMidi));
    listen();
    access.onstatechange = listen; // keyboards plugged in later
  } catch (e) {
    say(`MIDI keyboards won't work: ${e instanceof Error ? e.message : e}`, true);
  }
}

function onMidi(e: MIDIMessageEvent) {
  const [status = 0, note = 0, velocity = 0] = e.data ?? [];
  const type = status & 0xf0;
  const id = `midi:${note}`;
  if (type === 0x90 && velocity > 0) {
    const { entry, playKeys } = useApp.getState();
    if (entry || playKeys) press(id, note - MIDI_C3);
  } else if (type === 0x80 || type === 0x90) release(id);
}
