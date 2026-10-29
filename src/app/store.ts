import { create } from 'zustand';
import { readRecents, writeRecents, withRecent, type RecentFile } from './recent.ts';
import { compile, rangeErrors, rowTicks } from '../core/compile.ts';
import { cName, exportGbdk } from '../core/export.ts';
import { formatSong } from '../core/format.ts';
import { noteName } from '../core/notes.ts';
import type { SongError } from '../core/location.ts';
import { LANE_KIND, LANES, type LaneItem, type LaneName, type Song } from '../core/schema.ts';
import { TICK_RATE } from '../play/player.ts';
import { Engine, type EngineEvent } from './audio/engine.ts';
import type { Loop } from './audio/protocol.ts';
import { renderWav } from './audio/render.ts';
import * as edits from './edit.ts';
import * as effects from './effects.ts';
import * as instruments from './instruments.ts';
import * as arrangement from './arrange.ts';
import * as range from './length.ts';
import { carryView, editView, occurrenceOf, openView, type Opened } from './placements.ts';
import { expand, occurrenceAt } from '../core/patterns.ts';
import { position } from '../core/location.ts';
import {
  describeError,
  download,
  lastFolder,
  listSongs,
  pickFile,
  pickFolder,
  PROBE_FILE,
  readText,
  exists,
  reopen,
  SONG_SUFFIX,
  songTitle,
  writeText,
} from './files.ts';
import { SCALES, type Scale } from './scales.ts';
import { LONG_LINK, readShare, shareLink } from './share.ts';
import { check, load, noteIndex, type Playable } from './song.ts';

export interface View {
  rowWidth: number; // pixels per row
  scrollRow: number; // the row at the left edge, fractional
  expanded: LaneName;
  pitchTop: Record<LaneName, number>; // the note at the top of each lane when it's expanded
}

export interface OpenSong {
  name: string;
  /** The text last read from or written to disk. Kept apart from the song, which edits change. */
  baseline: string;
  song?: Song; // the song being edited, or the last version that parsed
  saved?: Song; // the version the baseline holds; any other song has unsaved edits
  broken: boolean; // the baseline isn't a valid song, so the last one that was is shown and can't be edited
  errors: SongError[];
  playable?: Playable; // the last version that compiled
  past: Song[]; // undo
  future: Song[]; // redo
  conflict?: boolean; // the file changed on disk while there were unsaved edits
}

/** What a note drawn in a lane gets: the instrument and length of the note last drawn or clicked there. */
export interface Pen {
  inst: number;
  len: number;
}

/** The folder check: the probe file the app wrote, and what it reads there now. */
export interface Probe {
  wrote: string;
  reads?: string;
  readAt?: number;
  error?: string;
}

export interface AppState {
  folder?: FileSystemDirectoryHandle; // none when a song was opened from a file on its own
  remembered?: FileSystemDirectoryHandle; // last visit's folder, waiting for a click to reopen it
  lostAccess?: boolean; // permission to the open folder lapsed; a click can ask for it again
  songs: string[];
  recents: RecentFile[];
  open?: OpenSong;
  view: View;
  selection: LaneItem[]; // notes in the expanded lane, or in the open pattern
  fxSelection: number[]; // or the rows of effects selected there apart from their notes; never both
  placement?: LaneItem; // a placed pattern selected in the expanded lane
  opened?: Opened; // the place a pattern plays that's the target of edits in the expanded lane, or none for its loose notes
  brush?: string; // the current pattern, which clicking the strip places
  pen: Record<LaneName, Pen>;
  startRow: number;
  loop?: Loop; // the rows dragged along the ruler, which play over and over while looping is on
  looping: boolean;
  entry: boolean; // the computer keyboard and MIDI enter notes
  playKeys: boolean; // the computer keyboard and MIDI play notes, without entering them, while the keys are held
  keysDown: number[]; // the notes whose keys, MIDI notes or keys on the roll's keyboard are held
  hear: boolean; // entered notes are heard
  panel: boolean; // the instrument panel is shown
  help: boolean; // the list of keys is shown
  ghosts: boolean; // the expanded lane shows the other tonal lanes' notes behind its own
  scales: Record<string, Scale>; // the scale the roll shades, by song name
  octave: number; // the note the computer keyboard's A plays
  mute: Record<LaneName, boolean>; // lanes left out of what plays, unless one is soloed
  solo: Record<LaneName, boolean>; // with any soloed, only these play
  playing: boolean;
  seekMs?: number;
  underruns: number;
  reloadedAt?: number;
  message?: { text: string; error: boolean };
  probe?: Probe;
}

export const useApp = create<AppState>(() => ({
  songs: [],
  recents: readRecents(),
  view: initialView(undefined),
  selection: [],
  fxSelection: [],
  pen: initialPen(undefined),
  startRow: 0,
  looping: false,
  entry: false,
  playKeys: localStorage.getItem('gbscore.playKeys') === 'on',
  keysDown: [],
  hear: localStorage.getItem('gbscore.hear') !== 'off',
  panel: localStorage.getItem('gbscore.panel') === 'on',
  help: false,
  ghosts: localStorage.getItem('gbscore.ghosts') !== 'off',
  scales: readScales(),
  octave: 24, // C5
  mute: { pulse1: false, pulse2: false, wave: false, noise: false },
  solo: { pulse1: false, pulse2: false, wave: false, noise: false },
  playing: false,
  underruns: 0,
}));

const get = useApp.getState;
const set = useApp.setState;

export function say(text: string, error = false) {
  set({ message: { text, error } });
}

export function initialView(song: Song | undefined): View {
  const pitchTop = {} as Record<LaneName, number>;
  let expanded: LaneName = 'pulse1';
  let most = 0;
  for (const lane of LANES) {
    const notes = (song && expand(song).song.lanes[lane].flatMap((n) => (n.note ? [n.note] : []))) ?? [];
    pitchTop[lane] = 47; // B6
    if (notes.length) pitchTop[lane] = Math.min(71, Math.max(...notes.map(noteIndex)) + 4);
    if (notes.length > most) [most, expanded] = [notes.length, lane];
  }
  return { rowWidth: 12, scrollRow: 0, expanded, pitchTop };
}

export function initialPen(song: Song | undefined): Record<LaneName, Pen> {
  const pen = {} as Record<LaneName, Pen>;
  for (const lane of LANES) {
    pen[lane] = { inst: song?.instruments[LANE_KIND[lane]][0]?.id ?? 1, len: song?.grid.rowsPerBeat ?? 4 };
  }
  return pen;
}

export const unsaved = (open: OpenSong | undefined) => !!open?.song && open.song !== open.saved;

/** Whether the open song has been edited since it was `before`, so replacing it would lose the edits. */
const editedSince = (before: OpenSong | undefined) => get().open !== before && unsaved(get().open);

/** The open song as read from a file's text. */
function opened(name: string, text: string, shown: Song | undefined): OpenSong {
  const loaded = load(text);
  prepare(loaded.playable);
  const song = loaded.song ?? shown;
  return { name, baseline: text, ...loaded, song, saved: song, broken: !loaded.song, past: [], future: [] };
}


// File operations run one at a time, so a poll can't interleave with opening a file or the folder check. Each one
// keeps the folder it started with, and drops its result if that's no longer the open folder.
const current = (dir: FileSystemDirectoryHandle) => get().folder === dir;

function lostAccess(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
}

/** Reports a failed file operation in the open folder, unless the folder has changed since. */
function failed(dir: FileSystemDirectoryHandle, what: string, e: unknown) {
  if (!current(dir)) return;
  if (lostAccess(e)) set({ lostAccess: true });
  say(`${what}: ${describeError(e)}`, true);
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => undefined);
  return run;
}

// ---- folders and songs

/** At startup, opens what was open last: a song from a file, as it was opened or last downloaded, or else the
 * folder from last time. With neither, opens the demo song, as if from a file. A share link in the address comes
 * before all of these. */
export async function restoreLast() {
  if (await openShared()) return;
  const file = rememberedFile();
  if (file) {
    try {
      show(opened(file.name, file.text, undefined));
    } catch (e) {
      say(`Couldn't reopen ${file.name}: ${describeError(e)}`, true);
    }
    return;
  }
  try {
    const last = await lastFolder();
    if (get().open) return; // a share link was pasted in meanwhile
    if (!last) return openDemo();
    if (last.granted) await useFolder(last.dir);
    else set({ remembered: last.dir });
  } catch (e) {
    say(`Couldn't reopen the last folder: ${describeError(e)}`, true);
  }
}

const DEMO = 'halt_bug.gbscore.json';
const demoText = async () => (await import('./demo/halt_bug.gbscore.json?raw')).default;

async function openDemo() {
  try {
    const text = await demoText();
    if (!get().open && !get().folder) show(opened(DEMO, text, undefined)); // unless a song was opened meanwhile
  } catch (e) {
    say(`Couldn't open the demo song: ${describeError(e)}`, true);
  }
}

/** Opens the demo song from the song menu, as if from a file. */
export async function chooseDemo() {
  const before = get().open;
  try {
    await openAsFile(DEMO, await demoText(), before, 'the demo song', false);
  } catch (e) {
    say(`Couldn't open the demo song: ${describeError(e)}`, true);
  }
}

/** Opens an empty song, as if from a file: four bars of 4/4 with an instrument for each lane, so a click draws a
 * note. */
export function newSong() {
  let song: Song = {
    version: 1,
    grid: { rowsPerBeat: 4, beatsPerBar: 4 },
    groove: [6, 6, 6, 6],
    length: 64,
    loop: 0,
    instruments: { duty: [], wave: [], noise: [] },
    waves: [],
    lanes: { pulse1: [], pulse2: [], wave: [], noise: [] },
    global: [],
  };
  for (const kind of ['duty', 'wave', 'noise'] as const) {
    const added = instruments.addInstrument(song, kind);
    if (typeof added !== 'string') song = added.song;
  }
  return openAsFile('untitled.gbscore.json', formatSong(song), get().open, 'a new song', false);
}

export async function chooseFolder() {
  try {
    const dir = await pickFolder();
    if (dir) await useFolder(dir);
  } catch (e) {
    say(`Couldn't open the folder: ${describeError(e)}`, true);
  }
}

export async function reopenRemembered() {
  const dir = get().remembered;
  if (!dir) return;
  try {
    if (await reopen(dir)) await useFolder(dir);
  } catch (e) {
    say(`Couldn't reopen ${dir.name}: ${describeError(e)}`, true);
  }
}

/** Switches to a folder once its songs can be listed. Reopening the same folder keeps the open song. The switch is
 * one queued operation, so when folders are picked in quick succession the last one wins. */
export async function useFolder(dir: FileSystemDirectoryHandle) {
  const before = get().open;
  const result = await serial(async () => {
    const songs = await listSongs(dir);
    const { folder, open } = get();
    const same = folder && (await folder.isSameEntry(dir).catch(() => false));
    if (same && open && songs.includes(open.name)) {
      set({ folder: dir, songs, remembered: undefined, lostAccess: false, message: undefined });
      return 'kept';
    }
    if (editedSince(before)) return 'edited';
    stop();
    set({ folder: dir, songs, remembered: undefined, lostAccess: false, open: undefined, probe: undefined, message: undefined });
    return 'switched';
  });
  if (result !== 'edited') localStorage.removeItem(FILE_KEY);
  if (result === 'kept') return poll();
  if (result === 'edited') return say(`Didn't open ${dir.name}: ${before?.name} was edited meanwhile. Save it first.`, true);
  const songs = get().songs;
  const last = localStorage.getItem(`gbscore.song.${dir.name}`);
  const first = songs.find((s) => s === last) ?? songs[0];
  if (first) await openIn(dir, first);
  else if (current(dir)) say(`${dir.name} has no .gbscore.json files.`);
}

export async function openSong(name: string) {
  const dir = get().folder;
  if (dir) await openIn(dir, name);
}

async function openIn(dir: FileSystemDirectoryHandle, name: string) {
  if (!current(dir)) return;
  stop();
  const before = get().open;
  await serial(async () => {
    try {
      const text = await readText(dir, name);
      if (!current(dir)) return;
      if (editedSince(before)) {
        say(`Didn't open ${name}: ${before?.name} was edited meanwhile. Save it first.`, true);
        return;
      }
      show(opened(name, text, undefined));
      localStorage.setItem(`gbscore.song.${dir.name}`, name);
    } catch (e) {
      failed(dir, `Couldn't open ${name}`, e);
    }
  });
}

/** Shows a song just opened, from the start. */
function show(open: OpenSong, more: Partial<AppState> = {}) {
  set({
    open,
    view: initialView(open.song),
    selection: [],
    fxSelection: [],
    placement: undefined,
    opened: undefined,
    brush: undefined,
    pen: initialPen(open.song),
    startRow: 0,
    loop: undefined,
    looping: false,
    reloadedAt: undefined,
    message: undefined,
    ...more,
  });
  sendLoop();
}

export async function chooseFile() {
  try {
    const file = await pickFile();
    if (file) await openFile(file);
  } catch (e) {
    say(`Couldn't open the file: ${describeError(e)}`, true);
  }
}

/** Opens a song from a file on its own, closing the folder if one was open. Saving downloads it, and changes to
 * the file aren't seen: the browser gives the app the file's contents, not the file. */
export async function openFile(file: File) {
  stop();
  const before = get().open;
  await serial(async () => {
    try {
      const text = await file.text();
      if (editedSince(before)) {
        say(`Didn't open ${file.name}: ${before?.name} was edited meanwhile. Save it first.`, true);
        return;
      }
      show(opened(file.name, text, undefined), { folder: undefined, songs: [], lostAccess: false, probe: undefined });
      rememberFile(file.name, text);
    } catch (e) {
      say(`Couldn't open ${file.name}: ${describeError(e)}`, true);
    }
  });
}

/** Opens the song in the address's share link, if it has one, as if from a file (docs/editor/, "Share links").
 * Takes the link out of the address once read, so reloading reopens the song as it was last downloaded, as for a
 * file. Returns whether the address had a link. */
export async function openShared(): Promise<boolean> {
  const before = get().open;
  const shared = await readShare(location.hash);
  if (!shared) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if ('error' in shared) {
    say(shared.error, true);
    return true;
  }
  await openAsFile(shared.name, shared.text, before, 'the shared song');
  return true;
}

/** Opens a song from its text as if from a file, closing the folder if one was open, unless the open song was
 * edited since it was `before`. */
async function openAsFile(name: string, text: string, before: OpenSong | undefined, what: string, recent = true) {
  stop();
  await serial(async () => {
    if (editedSince(before)) return say(`Didn't open ${what}: ${before?.name} was edited meanwhile. Save it first.`, true);
    show(opened(name, text, undefined), { folder: undefined, songs: [], lostAccess: false, probe: undefined });
    rememberFile(name, text, recent);
  });
}

/** Copies a link that opens the song as it is now, unsaved edits and all. The clipboard gets a promise of the
 * text, so Safari still counts the click that asked for it. */
export async function share() {
  const open = get().open;
  if (!open?.song || open.broken) return;
  const link = shareLink(location.origin + location.pathname, open.name, open.song);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': link.then((t) => new Blob([t], { type: 'text/plain' })) })]);
    const n = (await link).length;
    const long = n > LONG_LINK ? ', too long for some chat apps' : '';
    say(`Copied a link to ${songTitle(open.name)} (${n.toLocaleString('en')} characters${long}).`);
  } catch (e) {
    say(`Couldn't copy a share link: ${describeError(e)}`, true);
  }
}

// A song opened from a file can't be read again on the next visit, since the browser gave the app its contents and
// not the file, so the app keeps the contents. Opening a folder forgets them.
const FILE_KEY = 'gbscore.file';

function rememberFile(name: string, text: string, recent = true) {
  try {
    localStorage.setItem(FILE_KEY, JSON.stringify({ name, text }));
  } catch {
    // History must not take space needed by the last-song restore.
    writeRecents([]);
    try {
      localStorage.setItem(FILE_KEY, JSON.stringify({ name, text }));
    } catch {
      localStorage.removeItem(FILE_KEY); // forget the older song rather than reopen it
    }
  }
  if (recent) rememberRecent(name, text);
}

function rememberRecent(name: string, text: string) {
  const recents = withRecent(get().recents, { name, text });
  set({ recents });
  writeRecents(recents);
}

export function clearRecents() {
  set({ recents: [] });
  writeRecents([]);
}

/** Reopens the stored copy as a standalone song; saving downloads it. */
export async function openRecent(file: RecentFile) {
  await openAsFile(file.name, file.text, get().open, file.name);
}

function rememberedFile(): { name: string; text: string } | undefined {
  try {
    const file: unknown = JSON.parse(localStorage.getItem(FILE_KEY) ?? 'null');
    if (file && typeof file === 'object' && 'name' in file && 'text' in file) {
      if (typeof file.name === 'string' && typeof file.text === 'string') return { name: file.name, text: file.text };
    }
  } catch {
    // not JSON: forget it
  }
  localStorage.removeItem(FILE_KEY);
  return undefined;
}

/** Asks again for permission to the open folder, after it lapsed. Call from a click. */
export async function regainAccess() {
  const dir = get().folder;
  if (!dir) return;
  try {
    if ((await reopen(dir)) && current(dir)) {
      set({ lostAccess: false, message: undefined });
      await poll();
    }
  } catch (e) {
    failed(dir, `Couldn't get access to ${dir.name}`, e);
  }
}

// ---- changes from outside

let polls = 0;
let polling = false;

/** Reads the open song again, and reloads it if it changed on disk. Every few polls, lists the folder again. */
export async function poll() {
  const dir = get().folder;
  if (!dir || polling || get().lostAccess) return;
  polling = true;
  try {
    await serial(async () => {
      await reloadIfChanged(dir);
      if (get().probe) await readProbe(dir);
      if (++polls % 5 === 0) {
        const songs = await listSongs(dir);
        if (current(dir)) set({ songs });
      }
    });
  } catch (e) {
    failed(dir, `Couldn't read ${dir.name}`, e);
  } finally {
    polling = false;
  }
}

async function reloadIfChanged(dir: FileSystemDirectoryHandle) {
  const before = get().open;
  if (!before) return;
  let text: string;
  try {
    text = await readText(dir, before.name);
  } catch (e) {
    failed(dir, `Couldn't read ${before.name}`, e);
    return;
  }
  // Throw the read away if anything replaced the open song meanwhile: another file, a reload, or an edit.
  const now = get().open;
  if (now !== before || !current(dir)) return;
  if (text === now.baseline) {
    if (now.conflict) set({ open: { ...now, conflict: false } });
    return;
  }
  // With unsaved edits, ask which version to keep. Without, reload; undo can't go back past an outside change.
  if (unsaved(now)) {
    if (!now.conflict) set({ open: { ...now, conflict: true } });
    return;
  }
  const open = opened(now.name, text, now.song);
  set({ open: { ...open, playable: open.playable ?? now.playable }, selection: [], fxSelection: [], placement: undefined, reloadedAt: Date.now() });
}

// ---- the folder check

export async function startProbe() {
  const dir = get().folder;
  if (!dir) return;
  const wrote = `gbscore wrote this at ${new Date().toISOString()}`;
  await serial(async () => {
    try {
      await writeText(dir, PROBE_FILE, wrote + '\n');
      if (!current(dir)) return;
      set({ probe: { wrote } });
      await readProbe(dir);
    } catch (e) {
      if (!current(dir)) return;
      if (lostAccess(e)) set({ lostAccess: true });
      set({ probe: { wrote, error: `Couldn't write ${PROBE_FILE}: ${describeError(e)}` } });
    }
  });
}

async function readProbe(dir: FileSystemDirectoryHandle) {
  const probe = get().probe;
  if (!probe) return;
  try {
    const reads = (await readText(dir, PROBE_FILE)).trimEnd();
    if (current(dir) && get().probe?.wrote === probe.wrote) {
      set({ probe: { ...probe, reads, readAt: Date.now(), error: undefined } });
    }
  } catch (e) {
    if (current(dir) && get().probe?.wrote === probe.wrote) {
      if (lostAccess(e)) set({ lostAccess: true });
      set({ probe: { ...probe, error: `Couldn't read it: ${describeError(e)}` } });
    }
  }
}

export async function endProbe() {
  const dir = get().folder;
  set({ probe: undefined });
  if (!dir) return;
  await serial(async () => {
    try {
      await dir.removeEntry(PROBE_FILE);
    } catch (e) {
      failed(dir, `Couldn't remove ${PROBE_FILE}`, e);
    }
  });
}

// ---- playback

let audio: Engine | undefined;

/** The audio engine, made on first use: it starts a Worker. */
export function engine(): Engine {
  return (audio ??= new Engine((e: EngineEvent) => {
    if (e.type === 'started') set({ seekMs: e.seekMs });
    else if (e.type === 'underrun') set({ underruns: e.count });
    else {
      set({ playing: false });
      say(`Couldn't play: ${e.message}`, true);
    }
  }));
}

function prepare(p: Playable | undefined) {
  if (p) engine().prepare(p.data, p.orderStarts, p.length);
}

export function play() {
  const { open, startRow } = get();
  const p = open?.playable;
  if (!p) {
    say("The song doesn't compile, so it can't play. See the errors below.", true);
    return;
  }
  sendLoop();
  engine().play(p.data, p.orderStarts, Math.min(startRow, p.length - 1));
  set({ playing: true, underruns: 0, seekMs: undefined });
}

export function stop() {
  if (!get().playing) return;
  engine().stop();
  set({ playing: false });
}

/** Whether a lane is heard when the song plays: it's soloed, or nothing is and it isn't muted. Notes heard as
 * they're entered or clicked always are. */
export function audible(s: Pick<AppState, 'mute' | 'solo'>, lane: LaneName): boolean {
  return LANES.some((l) => s.solo[l]) ? s.solo[lane] : !s.mute[lane];
}

/** Mutes or unmutes a lane, or solos or unsolos it, at once if the song is playing. */
export function toggleLane(kind: 'mute' | 'solo', lane: LaneName) {
  set({ [kind]: { ...get()[kind], [lane]: !get()[kind][lane] } });
  engine().mute(LANES.map((l) => !audible(get(), l)));
}

export function togglePlay() {
  if (get().playing) stop();
  else play();
}

/** Loops the rows from `start` up to `end` and turns looping on, with the flag at the start. */
export function setLoop(start: number, end: number) {
  const { loop } = get();
  if (loop?.start === start && loop.end === end && get().looping) return;
  set({ loop: { start, end }, looping: true, startRow: start });
  sendLoop();
}

export function toggleLooping() {
  if (!get().loop) return;
  set({ looping: !get().looping });
  sendLoop();
}

/** Tells the engine the loop, kept to the song that would play. */
function sendLoop() {
  const { loop, looping, open } = get();
  const length = open?.playable?.length ?? 0;
  const end = Math.min(loop?.end ?? 0, length);
  engine().loop(looping && loop && loop.start < end ? { start: loop.start, end } : undefined);
}

export function setView(change: Partial<View>) {
  const { view } = get();
  const other = change.expanded !== view.expanded && change.expanded;
  set({ view: { ...view, ...change }, ...(other && { selection: [], fxSelection: [], placement: undefined, opened: undefined }) });
}

export function setStartRow(row: number) {
  const length = get().open?.song?.length ?? 1;
  set({ startRow: Math.max(0, Math.min(length - 1, Math.round(row))) });
}

// ---- editing

const HISTORY = 200;

/** The open song, if it can be edited. Says why not otherwise. */
function editable(): (OpenSong & { song: Song }) | undefined {
  const { open } = get();
  if (!open?.song) return undefined;
  if (open.broken) {
    say(`${open.name} on disk isn't a valid song, so it can't be edited until it's fixed. See the errors below.`, true);
    return undefined;
  }
  return open as OpenSong & { song: Song };
}

/** Replaces the song being edited, as one step of undo, and compiles it. The selected placement and effects go
 * unless `more` gives them. */
function commit(open: OpenSong, before: Song, after: Song, selection: LaneItem[], more: Partial<AppState> = {}) {
  const checked = check(after);
  prepare(checked.playable);
  set({
    open: {
      ...open,
      song: after,
      errors: checked.errors,
      playable: checked.playable ?? open.playable,
      past: [...open.past, before].slice(-HISTORY),
      future: [],
    },
    selection,
    fxSelection: [],
    pen: keptPens(get().pen, after, before),
    placement: undefined,
    ...more,
  });
}

/** The pens, each kept on an instrument the song has: one removed, or undone, gives way to the one before it. When
 * the grid changes from `before`'s, a note length picked from the toolbar's list stays the same choice: a beat
 * stays a beat. Any other length stays as many rows. */
function keptPens(pen: Record<LaneName, Pen>, song: Song, before: Song): Record<LaneName, Pen> {
  let kept = pen;
  const from = lengths(before.grid);
  const to = lengths(song.grid);
  for (const lane of LANES) {
    const list = song.instruments[LANE_KIND[lane]];
    const { inst: id, len } = pen[lane];
    const inst = !list.length || list.some((i) => i.id === id) ? id : (list.findLast((i) => i.id < id) ?? list[0]!).id;
    // The last of equal lengths is the one the picker names it by: a bar before a beat before a row.
    const choice = from.lastIndexOf(len);
    const length = song.grid === before.grid || choice < 0 ? len : to[choice]!;
    if (inst !== id || length !== len) kept = { ...kept, [lane]: { inst, len: length } };
  }
  return kept;
}

/** Makes an edit to the expanded lane, or says why it can't be made. A drag under way ends first, as its own
 * step of undo. The edit sees the lane without its placements, which go back after it. */
export function edit(change: (song: Song, lane: LaneName, selection: LaneItem[]) => edits.Result): boolean {
  endGesture();
  const open = editable();
  if (!open) return false;
  const { view, selection, opened } = get();
  const { song: bare, restore } = editView(open.song, view.expanded, opened);
  const r = change(bare, view.expanded, selection);
  const after = typeof r === 'string' ? r : restore(r.song);
  if (typeof r === 'string' || typeof after === 'string') {
    say(`Can't: ${after}.`, true);
    return false;
  }
  commit(open, open.song, after, r.selection, { fxSelection: r.effects ?? [] });
  return true;
}

/** Makes an edit outside the lanes' notes, such as to an instrument, keeping the selection. */
export function editSong(change: (song: Song) => Song | string): boolean {
  endGesture();
  const open = editable();
  if (!open) return false;
  // On the whole song, not the open pattern's view: an instrument a loose note uses is in use, pattern open or not.
  const r = change(open.song);
  if (typeof r === 'string') {
    say(`Can't: ${r}.`, true);
    return false;
  }
  if (get().opened) carryView(open.song, r, get().opened!);
  commit(open, open.song, r, get().selection, { placement: get().placement, fxSelection: get().fxSelection });
  return true;
}

/** Sets the song's length, and the row it loops back to if given, as one step of undo (docs/editor/, "Length and
 * loop"). Says what a shorter song cut past its new end, and if the loop went back to the start. */
export function setRange(length: number, loop?: number): boolean {
  endGesture();
  const open = editable();
  if (!open) return false;
  const r = range.setRange(open.song, length, loop);
  if (typeof r === 'string') {
    say(`Can't: ${r}.`, true);
    return false;
  }
  if (r.song === open.song) return true;
  const { opened, startRow, loop: played } = get();
  // With the lanes as they were, what's selected is still there, the open pattern's view too.
  const kept = r.song.lanes === open.song.lanes;
  if (kept && opened) carryView(open.song, r.song, opened);
  const gone = played && played.start >= r.song.length; // the rows dragged along the ruler are past the end
  commit(open, open.song, r.song, kept ? get().selection : [], {
    placement: kept ? get().placement : undefined,
    startRow: Math.min(startRow, r.song.length),
    ...(gone && { loop: undefined, looping: false }),
  });
  sendLoop();
  const cut = range.describeCut(r.cut);
  const said = [
    cut && `The song now ends at ${position(r.song.grid, r.song.length)}: ${cut}.`,
    r.loopReset && 'The loop was past the new end, so the song now loops back to the start.',
  ].filter(Boolean);
  if (said.length) say(`${said.join(' ')} Undo (Cmd-Z) brings ${cut ? 'them' : 'it'} back.`);
  return true;
}

/** What the song settings set: the song's title, artist and comment, its grid, and its groove. */
export interface SongInfo {
  title: string;
  artist: string;
  comment: string;
  grid: Song['grid'];
  groove: Song['groove'];
}

/** Why the song settings can't set a groove, if they can't: each step is 1 to 255 ticks, and a groove that isn't
 * uniform needs the loop on a multiple of 4, the compiler's rule (`rangeErrors`). */
export function grooveError(song: Song, groove: Song['groove']): string | undefined {
  if (!groove.every((n) => Number.isInteger(n) && n >= 1 && n <= 255)) return 'each groove step is 1 to 255 ticks';
  // Only what the new groove breaks: a song opened with its range already wrong says so in the error list.
  const before = new Set(rangeErrors(song).map((e) => e.message));
  const why = rangeErrors({ ...song, groove }).find((e) => !before.has(e.message));
  return why && `${why.message}. Move the loop on the ruler first`;
}

/** Sets the song's title, artist, comment, grid and groove together, as one step of undo (docs/editor/, "Song
 * settings"). Blank text leaves its key out of the file. A groove the compiler would reject is refused. */
export function setInfo(info: SongInfo): boolean {
  const song = editable()?.song;
  if (!song) return false;
  const { rowsPerBeat, beatsPerBar } = info.grid;
  if (![rowsPerBeat, beatsPerBar].every((n) => Number.isInteger(n) && n >= 1 && n <= 64)) {
    say("Can't: rows per beat and beats per bar are whole numbers from 1 to 64.", true);
    return false;
  }
  const sameGroove = info.groove.every((n, i) => n === song.groove[i]);
  const why = sameGroove ? undefined : grooveError(song, info.groove);
  if (why) {
    say(`Can't: ${why}.`, true);
    return false;
  }
  const text = (s: string) => s.trim() || undefined;
  const sameGrid = rowsPerBeat === song.grid.rowsPerBeat && beatsPerBar === song.grid.beatsPerBar;
  const next = { title: text(info.title), artist: text(info.artist), comment: text(info.comment) };
  const sameText = next.title === song.title && next.artist === song.artist && next.comment === song.comment;
  if (sameGrid && sameGroove && sameText) return true;
  return editSong((s) => ({
    ...s,
    ...next,
    grid: sameGrid ? s.grid : { rowsPerBeat, beatsPerBar },
    groove: sameGroove ? s.groove : [...info.groove],
  }));
}

// A gesture, such as a drag, changes the song as it goes and becomes one step of undo when it ends. Each change
// starts again from the song as it was, so a drag can go back to where it began.
let gesture:
  | { name: string; base: Song; selection: LaneItem[]; fxSelection: number[]; placement: AppState['placement']; shown: Song }
  | undefined;

export function startGesture(): boolean {
  endGesture();
  const open = editable();
  const { selection, fxSelection, placement } = get();
  gesture = open && { name: open.name, base: open.song, selection, fxSelection, placement, shown: open.song };
  return !!gesture;
}

/** Changes the song as part of the gesture under way. Returns false if there's none, as when the song was
 * replaced meanwhile. */
export function gestureTo(change: (song: Song, lane: LaneName, selection: LaneItem[]) => edits.Result | undefined): boolean {
  const open = get().open;
  if (!gesture || !open || open.name !== gesture.name || open.song !== gesture.shown) {
    gesture = undefined; // the song was replaced meanwhile, as by a reload
    return false;
  }
  const lane = get().view.expanded;
  const { song: bare, restore } = editView(gesture.base, lane, get().opened);
  const r = change(bare, lane, gesture.selection);
  const song = typeof r === 'string' ? r : r ? restore(r.song) : gesture.base;
  if (typeof song === 'string') {
    say(`Can't: ${song}.`, true); // and the gesture stays where it last could be
    return true;
  }
  const edited = typeof r === 'object' ? r : undefined;
  gesture.shown = song;
  set({
    open: { ...open, song },
    selection: edited?.selection ?? gesture.selection,
    fxSelection: edited ? (edited.effects ?? []) : gesture.fxSelection,
  });
  return true;
}

/** A gesture's change outside the lanes' notes, such as dragging an instrument's slider, keeping the selection. */
export function songGestureTo(change: (song: Song) => Song): boolean {
  const open = get().open;
  if (!gesture || !open || open.name !== gesture.name || open.song !== gesture.shown) {
    gesture = undefined;
    return false;
  }
  const song = change(gesture.base);
  if (get().opened) carryView(gesture.base, song, get().opened!);
  gesture.shown = song;
  set({ open: { ...open, song } });
  return true;
}

export function endGesture() {
  const g = gesture;
  gesture = undefined;
  const open = get().open;
  if (!g || !open?.song || open.song !== g.shown || g.shown === g.base) return;
  commit(open, g.base, open.song, get().selection, { placement: get().placement, fxSelection: get().fxSelection });
}

/** Ends the gesture under way with the song as it was before it, as when a second finger turns a drag into a
 * pinch. Not a step of undo. */
export function cancelGesture() {
  const g = gesture;
  gesture = undefined;
  const open = get().open;
  if (!g || !open || open.name !== g.name || open.song !== g.shown) return;
  set({ open: { ...open, song: g.base }, selection: g.selection, fxSelection: g.fxSelection, placement: g.placement });
}

export function undo() {
  endGesture();
  const open = editable();
  const before = open?.past.at(-1);
  if (!open || !before) return;
  restore({ ...open, past: open.past.slice(0, -1), future: [...open.future, open.song] }, before);
}

export function redo() {
  endGesture();
  const open = editable();
  const after = open?.future.at(-1);
  if (!open || !after) return;
  restore({ ...open, past: [...open.past, open.song], future: open.future.slice(0, -1) }, after);
}

function restore(open: OpenSong, song: Song) {
  const checked = check(song);
  prepare(checked.playable);
  set({
    open: { ...open, song, errors: checked.errors, playable: checked.playable ?? open.playable },
    selection: [],
    fxSelection: [],
    placement: undefined,
    pen: keptPens(get().pen, song, open.song!),
  });
}

export function select(selection: LaneItem[]) {
  set({ selection, fxSelection: [], placement: undefined });
}

/** Selects effects apart from their notes, by row, which clears the notes selected. */
export function selectEffects(rows: number[]) {
  set({ fxSelection: [...new Set(rows)].sort((a, b) => a - b), selection: [], placement: undefined });
}

/** The song as the roll shows it: with a pattern open, its notes are the lane's notes there (placements.ts). */
export function shown(s: AppState = get()): Song | undefined {
  const song = s.open?.song;
  return song && s.opened ? (openView(song, s.opened) ?? song) : song;
}

/** What edits to the expanded lane see: the open pattern's items, or the lane without its placements. */
function editing(): Song | undefined {
  const { open, view, opened } = get();
  return open?.song && editView(open.song, view.expanded, opened).song;
}

export function selectAll() {
  const song = editing();
  if (song) set({ selection: song.lanes[get().view.expanded].filter(edits.isNote), fxSelection: [], placement: undefined });
}

export function setPen(lane: LaneName, pen: Partial<Pen>) {
  const all = get().pen;
  set({ pen: { ...all, [lane]: { ...all[lane], ...pen } } });
}

// What was copied last: notes with their effects, or effects apart from their notes. Paste puts back whichever.
let clipboard: { notes: edits.Clip } | { effects: effects.EffectClip } | undefined;

export function copySelection(): boolean {
  const { view, selection, fxSelection } = get();
  const song = editing();
  if (!song) return false;
  if (fxSelection.length) {
    const clip = effects.copyEffects(song, view.expanded, fxSelection);
    if (clip) clipboard = { effects: clip };
    return !!clip;
  }
  const clip = edits.copy(song, view.expanded, selection);
  if (clip) clipboard = { notes: clip };
  return !!clip;
}

export function cutSelection() {
  if (copySelection()) deleteSelection();
}

/** Pastes at the start flag, and moves the flag to the end of what was pasted, so pastes follow one another. */
export function paste() {
  const clip = clipboard;
  if (!clip) return say('Nothing to paste: copy some notes or effects first.', true);
  const at = get().startRow;
  const span = 'notes' in clip ? clip.notes.span : clip.effects.span;
  const pasted = edit((song, lane) =>
    'notes' in clip ? edits.paste(song, lane, clip.notes, at) : effects.pasteEffects(song, lane, clip.effects, at),
  );
  if (pasted) setStartRow(at + span);
}

export function duplicateSelection() {
  edit((song, lane, selection) => edits.duplicate(song, lane, selection));
}

export function deleteSelection() {
  const { selection, fxSelection } = get();
  if (fxSelection.length) edit((song, lane) => effects.removeEffects(song, lane, fxSelection));
  else if (selection.length) edit((song, lane, selection) => edits.remove(song, lane, selection));
}

/** Moves the selected notes, or the selected effects by rows: effects have no pitch. */
export function moveSelection(rows: number, semitones: number) {
  const { selection, fxSelection } = get();
  if (fxSelection.length) {
    if (rows) edit((song, lane) => effects.moveEffects(song, lane, fxSelection, rows));
  } else if (selection.length) edit((song, lane, selection) => edits.move(song, lane, selection, rows, semitones));
}

// ---- patterns (docs/patterns/, "The editor")

/** Makes what plays at a row of the expanded lane the target of edits (docs/patterns/, "Editing notes"): the place
 * a pattern plays there, or the loose notes. Changing it clears the selection. A repeat cut short can't be the
 * target; that's said, and false returned. */
export function targetRow(row: number): boolean {
  const { open, view, opened } = get();
  const song = open?.song;
  if (!song) return false;
  const occ = occurrenceAt(expand(song).occurrences, view.expanded, row);
  if (occ && occ.length < occ.pattern.length) {
    say(`This repeat of pattern ${occ.pattern.id} is cut short; edit it where it plays whole.`, true);
    return false;
  }
  const next = occ && { lane: occ.lane, start: occ.start, id: occ.pattern.id };
  const same = next ? opened?.lane === next.lane && opened.start === next.start && opened.id === next.id : !opened;
  if (!same) set({ opened: next, selection: [], fxSelection: [], placement: undefined });
  else if (get().placement) set({ placement: undefined });
  return true;
}

/** Makes the loose notes the target of edits again. */
export function clearTarget() {
  if (get().opened) set({ opened: undefined, selection: [], fxSelection: [] });
}

export function selectPlacement(placement: LaneItem | undefined) {
  set({ placement, selection: [], fxSelection: [], ...(placement && { brush: placement.pattern }) });
}

/** Picks the current pattern, the one clicking the strip places. */
export function setBrush(brush: string) {
  set({ brush });
}

// A pattern open in a song that no longer has it, after an undo, a reload or a deletion, closes.
useApp.subscribe((s) => {
  if (s.opened && s.open?.song && !occurrenceOf(s.open.song, s.opened)) set({ opened: undefined, selection: [], fxSelection: [] });
});

type Arrange = (song: Song, lane: LaneName, placement: LaneItem | undefined) => arrangement.Arranged;

/** Makes an edit to the expanded lane's placements or the song's patterns, as one step of undo, or says why it
 * can't be made. A pattern open for editing closes first. */
export function arrange(change: Arrange): boolean {
  endGesture();
  const open = editable();
  if (!open) return false;
  const { view, selection } = get();
  // A placement selected in a song since replaced, as by a reload, isn't one any more.
  const placement = get().placement && open.song.lanes[view.expanded].includes(get().placement!) ? get().placement : undefined;
  const r = change(open.song, view.expanded, placement);
  if (typeof r === 'string') {
    say(`Can't: ${r}.`, true);
    return false;
  }
  // The placement it leaves selected is the current pattern's, as selecting it would make it.
  const brush = r.placement?.pattern ?? get().brush;
  if (r.song !== open.song) commit(open, open.song, r.song, r.selection ?? (r.placement ? [] : selection), { placement: r.placement, opened: undefined, brush });
  else set({ placement: r.placement, brush });
  return true;
}

/** An arrangement change as part of the gesture under way, as dragging a placement. One that can't be made leaves
 * the gesture where it last could be. */
export function arrangeGestureTo(change: (song: Song, lane: LaneName) => arrangement.Arranged): boolean {
  const open = get().open;
  if (!gesture || !open || open.name !== gesture.name || open.song !== gesture.shown) {
    gesture = undefined;
    return false;
  }
  const r = change(gesture.base, get().view.expanded);
  if (typeof r === 'string') return true;
  gesture.shown = r.song;
  set({ open: { ...open, song: r.song }, placement: r.placement });
  return true;
}

const withPlacement = (change: (song: Song, lane: LaneName, item: LaneItem) => arrangement.Arranged): Arrange => (song, lane, item) =>
  item ? change(song, lane, item) : 'select a placed pattern first';

export const removePlacement = () => arrange(withPlacement(arrangement.removePlacement));
export const duplicatePlacement = () => arrange(withPlacement(arrangement.duplicatePlacement));
export const unpackPlacement = () => arrange(withPlacement(arrangement.unpack));
export const makeUnique = () => arrange(withPlacement(arrangement.makeUnique));
export const movePlacement = (rows: number) =>
  arrange(withPlacement((song, lane, item) => arrangement.movePlacement(song, lane, item, rows, false)));
export const setPlacement = (change: arrangement.PlacementChange) =>
  arrange(withPlacement((song, lane, item) => arrangement.setPlacement(song, lane, item, change)));
export const transposePlacement = (by: number) =>
  arrange(withPlacement((song, lane, item) => arrangement.setPlacement(song, lane, item, { transpose: (item.transpose ?? 0) + by })));
/** Renames a pattern, keeping it open or selected if it was. */
export function renamePattern(from: string, to: string): boolean {
  const opened = get().opened;
  const ok = arrange((song, lane, item) => {
    const r = arrangement.renamePattern(song, from, to);
    if (typeof r === 'string' || !item) return r;
    return { ...r, placement: r.song.lanes[lane].find((i) => i.row === item.row && i.pattern !== undefined) };
  });
  // The open pattern's notes are new objects under the new name, so the selection goes.
  if (ok && opened) set({ opened: opened.id === from ? { ...opened, id: to } : opened, selection: [], fxSelection: [] });
  if (ok && get().brush === from) set({ brush: to });
  return ok;
}

/** Makes a pattern of the beats the selected notes span, and places it there. */
export function makePattern() {
  const opened = get().opened;
  if (opened) return say(`Can't: those notes are in pattern ${opened.id} already.`, true);
  arrange((song, lane) => arrangement.makePattern(song, lane, get().selection));
}

/** Places the current pattern at a row of the expanded lane, and selects it. */
export function placeAt(row: number) {
  const id = get().brush;
  if (!id || !get().open?.song?.patterns?.some((p) => p.id === id && p.kind === LANE_KIND[get().view.expanded])) {
    return say(`Make a pattern (Cmd-G), or pick one in the Pattern menu, to place it here.`, true);
  }
  arrange((song, lane) => arrangement.placePattern(song, lane, id, row));
}

// ---- note entry

export function setEntry(entry: boolean) {
  set({ entry });
}

export function setPlayKeys(playKeys: boolean) {
  localStorage.setItem('gbscore.playKeys', playKeys ? 'on' : 'off');
  set({ playKeys });
}

export function setKeysDown(keysDown: number[]) {
  set({ keysDown });
}

export function setHear(hear: boolean) {
  localStorage.setItem('gbscore.hear', hear ? 'on' : 'off');
  set({ hear });
}

export function setHelp(help: boolean) {
  set({ help });
}

export function setGhosts(ghosts: boolean) {
  localStorage.setItem('gbscore.ghosts', ghosts ? 'on' : 'off');
  set({ ghosts });
}

/** The scales remembered for songs, leaving out any this version of the app doesn't know. */
function readScales(): Record<string, Scale> {
  try {
    const all: unknown = JSON.parse(localStorage.getItem('gbscore.scales') ?? '{}');
    if (!all || typeof all !== 'object') return {};
    return Object.fromEntries(
      Object.entries(all as Record<string, Scale>).filter(
        ([, s]) => Object.hasOwn(SCALES, s?.kind) && Number.isInteger(s.root) && s.root >= 0 && s.root < 12,
      ),
    );
  } catch {
    return {};
  }
}

/** Sets the scale the roll shades for the open song, or none. */
export function setScale(scale: Scale | undefined) {
  const name = get().open?.name;
  if (!name) return;
  const { [name]: _, ...rest } = get().scales;
  const scales = scale ? { ...rest, [name]: scale } : rest;
  localStorage.setItem('gbscore.scales', JSON.stringify(scales));
  set({ scales });
}

/** Moves the computer keyboard an octave, keeping its notes in range. */
export function shiftOctave(octaves: number) {
  set({ octave: Math.max(0, Math.min(60, get().octave + octaves * 12)) });
}

/** Note lengths for the number keys, from a row to a bar. */
export function lengths(grid: Song['grid']): number[] {
  const beat = grid.rowsPerBeat;
  return [1, Math.max(1, Math.floor(beat / 2)), beat, beat * 2, beat * grid.beatsPerBar];
}

/** Enters a note in the expanded lane at a row, with the pen's instrument and length, and hears it. Unless it's
 * part of a chord, the flag moves to its end, so notes entered one after another follow each other. */
export function enterNote(index: number, at: number, advance: boolean): boolean {
  const { open, view, pen } = get();
  const length = open?.song?.length ?? 0;
  if (at >= length) {
    say(`The flag is at the end of the song: move it back to enter more, or right-click the ruler to make the song longer.`, true);
    return false;
  }
  const p = pen[view.expanded];
  const len = Math.min(p.len, length - at);
  const note: LaneItem = { row: at, len, note: noteName(index), inst: p.inst };
  if (!edit((song, lane) => edits.draw(song, lane, note))) return false;
  if (advance) {
    // The flag can go just past the last row here, and nowhere else, so the next note doesn't replace this one.
    set({ startRow: at + len });
    if (at + len >= length) say(`That's the end of the song: it's ${length} rows long. Right-click the ruler to make it longer.`);
  }
  hearNote(view.expanded, get().selection[0] ?? note); // as placed, with an effect it took from its row
  return true;
}

/** Moves the flag by steps of the note length. */
export function stepFlag(steps: number) {
  const { startRow, view, pen } = get();
  setStartRow(startRow + steps * pen[view.expanded].len);
}

/** Plays a note on its own, through the emulator, unless hearing is off or the song is playing: then edits are
 * heard the next time it plays. */
export function hearNote(lane: LaneName, note: LaneItem) {
  const { hear, playing } = get();
  if (hear && !playing) sound(lane, note);
}

/** Plays a note on its own, through the emulator, with the song's instruments as they are now. A note in the song
 * (`inSong`) is heard with the effects inside it and the ticks its rows have in the song; what came before it,
 * such as pan or a glide's starting pitch, isn't there. Returns whether it plays. */
function sound(lane: LaneName, note: LaneItem, inSong = true): boolean {
  const song = shown();
  if (!song) return false;
  const empty = { pulse1: [], pulse2: [], wave: [], noise: [] };
  const len = note.len ?? 1;
  const ticks = inSong ? rowTicks(song, effects.tempos(song)) : [];
  const rows = Array.from({ length: len }, (_, r) => ticks[note.row + r]?.[0] ?? song.groove[r % 4]!);
  const inner = inSong
    ? song.lanes[lane].filter((i) => !edits.isNote(i) && i.row > note.row && i.row < note.row + len && i.fx?.cut === undefined)
    : [];
  // Silence after the note, so the song doesn't loop back to it before the engine stops it.
  const solo: Song = {
    ...song,
    patterns: undefined,
    length: len + 64,
    loop: 0,
    global: inSong ? rows.map((tempo, row) => ({ row, tempo })) : [],
    lanes: { ...empty, [lane]: [note, ...inner].map((i) => ({ ...i, row: i.row - note.row })) },
  };
  const c = compile(solo);
  if (!c.ok) {
    say(`Can't hear the note: ${c.errors[0]!.message}.`, true);
    return false;
  }
  const total = rows.reduce((a, b) => a + b, 0);
  engine().hear(c.data, c.layout.orderStarts, (total / TICK_RATE) * 1000);
  return true;
}

// The longest a key held with Play keys sounds.
const HOLD_SECONDS = 30;
let lastPlayed = 'C5'; // the last note played with Play keys, for Try
let holding = false; // a note played with Play keys sounds until its key is let go

/** Plays the last note played with an instrument of the expanded lane until release(), or for HOLD_SECONDS. */
function hold(inst: number): boolean {
  const song = get().open?.song;
  if (!song) return false;
  let len = 0;
  for (let ticks = 0; ticks < HOLD_SECONDS * TICK_RATE; len++) ticks += song.groove[len % 4]!;
  if (!sound(get().view.expanded, { row: 0, len, note: lastPlayed, inst }, false)) return false; // what was held still is
  return (holding = true);
}

/** Plays a note with the instrument new notes in the expanded lane get, as Play keys does while a key is held:
 * until release(), or for HOLD_SECONDS. Nothing plays while the song does. Returns whether it plays. */
export function audition(index: number): boolean {
  const { open, view, pen, playing } = get();
  if (!open?.song || playing) return false;
  lastPlayed = noteName(index);
  return hold(pen[view.expanded].inst);
}

/** Stops the note audition() played, and the instrument it's heard with after a change, but not the song. */
export function release() {
  if (holding) engine().release();
  holding = false;
}

// ---- instruments

export function setPanel(panel: boolean) {
  localStorage.setItem('gbscore.panel', panel ? 'on' : 'off');
  set({ panel });
}

/** Plays a note with an instrument of the expanded lane: with a Play keys note held, that note, still held; else
 * the first selected note, or the last note played with Play keys (C5 until one is) for two beats. `always`
 * plays it even with hearing off, and stops the song if it's playing, as for a click on Try. */
export function tryInstrument(id: number, always: boolean) {
  const { open, view, selection, hear, playing } = get();
  const song = open?.song;
  if (!song || (!always && (!hear || playing))) return;
  stop();
  if (holding) {
    hold(id);
    return;
  }
  const picked = selection.find(edits.isNote);
  if (!picked) {
    sound(view.expanded, { row: 0, len: song.grid.rowsPerBeat * 2, note: lastPlayed, inst: id }, false);
    return;
  }
  const { legato: _, ...note } = picked;
  sound(view.expanded, { ...note, inst: id });
}

/** Adds an instrument, or a copy of one, to the expanded lane's kind, and picks it for new notes. */
export function addInstrument(copyOf?: number) {
  const lane = get().view.expanded;
  const kind = LANE_KIND[lane];
  let id = 0;
  const added = editSong((song) => {
    const r = copyOf === undefined ? instruments.addInstrument(song, kind) : instruments.duplicateInstrument(song, kind, copyOf);
    if (typeof r === 'string') return r;
    id = r.id;
    return r.song;
  });
  if (added) setPen(lane, { inst: id });
}

/** Removes an instrument of the expanded lane's kind, if no note uses it. Pens on it move to the one before. */
export function removeInstrument(id: number) {
  const kind = LANE_KIND[get().view.expanded];
  editSong((song) => instruments.removeInstrument(song, kind, id));
}

/** Gives the selected notes an instrument. */
export function giveSelection(id: number) {
  edit((song, lane, selection) => instruments.setNoteInstrument(song, lane, selection, id));
}

/** Makes the selected notes legato, or when every one already is, normal again (docs/editor/, "Legato"). A note
 * made normal gets the instrument it was playing with, from the note before it as the song plays, or the pen's. */
export function toggleLegato() {
  const { open, view, pen } = get();
  if (!open?.song) return;
  const lane = view.expanded;
  const kind = instruments.instrumentsOf(open.song, LANE_KIND[lane]);
  const heard = expand(open.song).song.lanes[lane];
  const instFor = (note: LaneItem) => {
    const before = heard.filter((i) => i.inst !== undefined && i.note !== undefined && i.row < note.row);
    const playing = before.reduce<LaneItem | undefined>((a, b) => (a && a.row > b.row ? a : b), undefined)?.inst;
    return [playing, pen[lane].inst].find((id) => kind.some((i) => i.id === id));
  };
  let said = '';
  const made = edit((song, lane, selection) => {
    const r = instruments.toggleLegato(song, lane, selection, instFor);
    if (typeof r === 'string') return r;
    const n = r.changed === 1 ? '1 note' : `${r.changed} notes`;
    said = r.on
      ? `${n} now legato: each changes pitch without a new attack, carrying on the note before it. Hearing one on ` +
        `its own can't include that note; play the song to hear it.${lane === 'noise' ? ' On noise, legato also returns the channel to 15-bit mode.' : ''}`
      : `${n} no longer legato, each with an instrument again: the one it was playing with, or the pen's if none was.`;
    return r;
  });
  if (made && said) say(said);
}

// ---- saving

/** Writes a copy of a song next to it, as `tune.mine-20261014-150322.gbscore.json`, with `-2` and so on after
 * the time if that's taken: a copy never replaces a file. Returns the copy's name. */
async function writeCopy(dir: FileSystemDirectoryHandle, name: string, whose: 'mine' | 'theirs', text: string) {
  const at = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-` +
    `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  for (let n = 1; ; n++) {
    const copy = `${name.slice(0, -SONG_SUFFIX.length)}.${whose}-${stamp}${n > 1 ? `-${n}` : ''}${SONG_SUFFIX}`;
    if (await exists(dir, copy)) continue;
    await writeText(dir, copy, text);
    return copy;
  }
}

/** Writes the song in its canonical form, unless the file changed on disk since it was loaded or saved: then it
 * writes it next to the file as a `mine` copy. It saves the song as it is when its turn in the queue comes, against
 * the baseline then, so a reload, a choice between versions or another save that ran first is taken into account.
 * Edits made while it saves stay unsaved. */
export async function save() {
  const dir = get().folder;
  const name = get().open?.name;
  if (!dir) return saveAsDownload();
  if (!name) return;
  await serial(async () => {
    const open = get().open;
    if (!current(dir) || open?.name !== name || !open.song || open.broken || !unsaved(open)) return;
    const song = open.song;
    const text = formatSong(song);
    try {
      const disk = await readText(dir, open.name);
      if (disk !== open.baseline) {
        const copy = await writeCopy(dir, open.name, 'mine', text);
        if (current(dir)) say(`${open.name} changed on disk, so it wasn't overwritten. Your version is in ${copy}.`, true);
        return;
      }
      await writeText(dir, open.name, text);
      const now = get().open;
      if (current(dir) && now?.name === open.name) {
        set({ open: { ...now, baseline: text, saved: song, conflict: false }, message: undefined });
      }
    } catch (e) {
      failed(dir, `Couldn't save ${open.name}`, e);
    }
  });
}

/** Without a folder, saving downloads the song in its canonical form, and the next visit reopens that version. The
 * edits stay unsaved: the app can't tell whether the download finished, or was cancelled. */
function saveAsDownload() {
  const open = get().open;
  if (!open?.song || open.broken) return;
  const text = formatSong(open.song);
  download(open.name, text);
  rememberFile(open.name, text);
  say(`Downloaded ${open.name}.`);
}

/** The song as it is, if it compiles, for exporting; or undefined, having said why not. */
function exportable(): { open: OpenSong & { song: Song }; playable: Playable; title: string } | undefined {
  const open = get().open;
  if (!open?.song) return undefined;
  // Without errors, the song as it is compiled, so the playable is this version's.
  if (open.errors.length || !open.playable) {
    say("The song doesn't compile, so it can't be exported. See the errors below.", true);
    return undefined;
  }
  return { open: open as OpenSong & { song: Song }, playable: open.playable, title: songTitle(open.name) };
}

/** Downloads the song played once through, as `gbscore render` writes it. */
export async function exportWav() {
  const e = exportable();
  if (!e) return;
  const file = `${e.title}.wav`;
  say(`Rendering ${file}…`);
  try {
    const { wav, seconds } = await renderWav({ song: e.playable.data, timeline: e.open.song });
    download(file, wav as Uint8Array<ArrayBuffer>, 'audio/wav');
    say(`Downloaded ${file} (${seconds.toFixed(1)} s).`);
  } catch (err) {
    say(`Couldn't render ${file}: ${err instanceof Error ? err.message : err}`, true);
  }
}

/** Downloads the song as GBDK C, as `gbscore export --gbdk` writes it with no options: the song named after the
 * file, in the bank bankpack chooses. */
export function exportC() {
  const e = exportable();
  if (!e) return;
  const name = cName(e.title);
  if (typeof name !== 'string') {
    say(`${e.title} isn't a C name, so the song can't be exported. Rename the file to letters, digits and _.`, true);
    return;
  }
  download(`${e.title}.c`, exportGbdk(e.playable.data, { name, bank: 255, source: e.open.name }), 'text/x-c');
  say(`Downloaded ${e.title}.c: ${name}, ${e.playable.size} bytes, in the bank bankpack chooses.`);
}

/** After the file changed on disk with unsaved edits: keeps these edits, and writes the file's version next to it
 * as a `theirs` copy. The next save replaces the file. */
export async function keepMine() {
  const dir = get().folder;
  const start = get().open;
  if (!dir || !start) return;
  await serial(async () => {
    try {
      const theirs = await readText(dir, start.name);
      const copy = await writeCopy(dir, start.name, 'theirs', theirs);
      const now = get().open;
      if (!current(dir) || now?.name !== start.name) return;
      // No version of the song matches the file now, so even undoing every edit leaves it unsaved.
      set({ open: { ...now, baseline: theirs, saved: undefined, conflict: false } });
      say(`Kept your version, unsaved. The one on disk is in ${copy}.`);
    } catch (e) {
      failed(dir, `Couldn't keep your version`, e);
    }
  });
}

/** After the file changed on disk with unsaved edits: loads the file's version, and writes these edits next to it
 * as a `mine` copy. */
export async function loadTheirs() {
  const dir = get().folder;
  const start = get().open;
  if (!dir || !start?.song) return;
  await serial(async () => {
    const mine = get().open;
    if (!current(dir) || mine?.name !== start.name || !mine.song) return;
    try {
      const copy = await writeCopy(dir, mine.name, 'mine', formatSong(mine.song));
      const theirs = await readText(dir, mine.name);
      const now = get().open;
      if (!current(dir) || now?.name !== mine.name || now.song !== mine.song) return; // edited meanwhile: ask again
      const open = opened(now.name, theirs, now.song);
      set({ open: { ...open, playable: open.playable ?? now.playable }, selection: [], fxSelection: [], placement: undefined, reloadedAt: Date.now() });
      say(`Loaded the version on disk. Yours is in ${copy}.`);
    } catch (e) {
      failed(dir, `Couldn't load the version on disk`, e);
    }
  });
}
