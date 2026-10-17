import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rowTicks } from '../src/core/compile.ts';
import { formatSong } from '../src/core/format.ts';
import { importUge } from '../src/core/import.ts';
import type { Edit } from '../src/app/edit.ts';
import { TICK_RATE } from '../src/play/player.ts';

// The app's file rules (docs/editor/, "Web app"), with folders faked in memory and the audio engine mocked out.

const heard = vi.hoisted(() => [] as number[]); // how long each note heard sounds, in ms
const heardData = vi.hoisted(() => [] as unknown[]); // what was compiled for each
const muted = vi.hoisted(() => [] as boolean[][]); // each set of channels muted
const released = vi.hoisted(() => [] as number[]); // for each stop of a note being heard, how many had been heard
const loops = vi.hoisted(() => [] as unknown[]); // each loop the engine was given
vi.mock('../src/app/audio/engine.ts', () => ({
  Engine: class {
    prepare() {}
    play() {}
    hear(song: unknown, _orderStarts: unknown, ms: number) {
      heard.push(ms);
      heardData.push(song);
      return heard.length;
    }
    release() {
      released.push(heard.length);
    }
    stop() {}
    now() {}
    mute(m: boolean[]) {
      muted.push(m);
    }
    loop(l: unknown) {
      loops.push(l);
    }
  },
}));
const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
} as Storage;

const { useApp, useFolder, openSong, openFile, setPen, poll, regainAccess, startProbe, edit, save, undo, redo, unsaved, keepMine, loadTheirs, startGesture, gestureTo, endGesture, songGestureTo, addInstrument, removeInstrument, giveSelection, tryInstrument, hearNote } =
  await import('../src/app/store.ts');
const store = await import('../src/app/store.ts');
const { expand } = await import('../src/core/patterns.ts');
const { updateInstrument } = await import('../src/app/instruments.ts');
const edits = await import('../src/app/edit.ts');
const effects = await import('../src/app/effects.ts');
const arrangeOps = await import('../src/app/arrange.ts');
const entry = await import('../src/app/entry.ts');

// HALT Bug's .uge with duty instruments 1–4 only and no notes on 2, so the instrument tests have one to remove and
// room to add more.
const haltBug = (() => {
  const s = importUge(readFileSync(new URL('./fixtures/halt_bug.uge', import.meta.url))).song;
  s.instruments.duty = s.instruments.duty.filter((i) => i.id <= 4);
  for (const lane of ['pulse1', 'pulse2'] as const) s.lanes[lane] = s.lanes[lane].filter((i) => !i.inst || (i.inst !== 2 && i.inst <= 4));
  return formatSong(s);
})();

/** Enough of FileSystemDirectoryHandle for the store. Writes wait for `gate`; `denied` makes everything fail as when
 * permission lapses. */
class FakeDir {
  readonly kind = 'directory';
  readonly name: string;
  readonly files: Map<string, string>;
  gate: Promise<void> = Promise.resolve(); // writes wait for it
  reading: Promise<void> = Promise.resolve(); // reads wait for it
  comparing: Promise<void> = Promise.resolve(); // comparing another folder with this one waits for it
  asking: Promise<void> = Promise.resolve(); // a permission request waits for it
  denied = false;

  constructor(name: string, files: Record<string, string>) {
    this.name = name;
    this.files = new Map(Object.entries(files));
  }

  private check() {
    if (this.denied) throw new DOMException('denied', 'NotAllowedError');
  }

  async *entries() {
    this.check();
    for (const name of this.files.keys()) yield [name, { kind: 'file' }] as const;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    this.check();
    if (!this.files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError');
    return {
      getFile: async () => ({
        text: async () => {
          await this.reading;
          return this.files.get(name)!;
        },
      }),
      createWritable: async () => {
        let text = '';
        return {
          write: async (t: string) => void (text += t),
          close: async () => {
            await this.gate;
            this.files.set(name, text);
          },
          abort: async () => {},
        };
      },
    };
  }

  async removeEntry(name: string) {
    this.files.delete(name);
  }

  async isSameEntry(other: FakeDir) {
    await other.comparing;
    return other.name === this.name;
  }

  async requestPermission() {
    await this.asking;
    this.denied = false;
    return 'granted';
  }
}

const asHandle = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;

describe('mute and solo', () => {
  it('plays the soloed lanes if any are, and otherwise the ones not muted', () => {
    const off = { pulse1: false, pulse2: false, wave: false, noise: false };
    useApp.setState({ mute: off, solo: off });
    muted.length = 0;
    store.toggleLane('mute', 'wave');
    store.toggleLane('solo', 'pulse2');
    store.toggleLane('solo', 'wave'); // soloed wins over muted
    store.toggleLane('solo', 'pulse2');
    store.toggleLane('solo', 'wave');
    expect(muted).toEqual([
      [false, false, true, false],
      [true, false, true, true],
      [true, false, false, true],
      [true, true, false, true],
      [false, false, true, false], // the mute is still there after the solos go
    ]);
  });
});

describe('looping', () => {
  it('loops the rows set, with the flag at their start, kept to the song, until turned off', () => {
    useApp.setState({ open: { playable: { length: 32 } } as never, loop: undefined, looping: false });
    loops.length = 0;
    store.toggleLooping(); // nothing to loop yet
    expect(useApp.getState().looping).toBe(false);
    store.setLoop(8, 16);
    expect(useApp.getState()).toMatchObject({ loop: { start: 8, end: 16 }, looping: true, startRow: 8 });
    store.toggleLooping();
    store.setLoop(24, 40); // past the end of the song
    store.toggleLooping();
    expect(useApp.getState().looping).toBe(false);
    expect(loops).toEqual([{ start: 8, end: 16 }, undefined, { start: 24, end: 32 }, undefined]);
  });
});

describe('the open folder', () => {
  beforeEach(() => {
    useApp.setState({ folder: undefined, open: undefined, probe: undefined, songs: [], lostAccess: false, message: undefined });
  });

  it("doesn't take a folder check's results from a folder it has left", async () => {
    const a = new FakeDir('a', { 'halt_bug.gbscore.json': haltBug });
    const b = new FakeDir('b', { 'other.gbscore.json': haltBug });
    await useFolder(asHandle(a));
    let release!: () => void;
    a.gate = new Promise((r) => (release = r));
    const probing = startProbe();
    const switching = useFolder(asHandle(b));
    release();
    await Promise.all([probing, switching]);
    const s = useApp.getState();
    expect(s.folder).toBe(asHandle(b));
    expect(s.probe).toBeUndefined();
    expect(s.open?.name).toBe('other.gbscore.json');
  });

  it('keeps the open song when permission lapses, and carries on once it is back', async () => {
    const a = new FakeDir('a', { 'halt_bug.gbscore.json': haltBug });
    await useFolder(asHandle(a));
    const open = useApp.getState().open;
    expect(open?.playable).toBeDefined();
    a.denied = true;
    await poll();
    expect(useApp.getState().lostAccess).toBe(true);
    expect(useApp.getState().open).toBe(open);
    await poll(); // no more attempts until access is back
    a.files.set('halt_bug.gbscore.json', haltBug.replace('Math chiptune in D minor.', 'x'));
    await regainAccess();
    await poll();
    expect(useApp.getState().lostAccess).toBe(false);
    expect(useApp.getState().open?.baseline).toContain('"comment": "x"');
  });

  it('closes the folder when a song is opened from a file on its own', async () => {
    const a = new FakeDir('a', { 'halt_bug.gbscore.json': haltBug });
    await useFolder(asHandle(a));
    await openFile(new File([haltBug], 'tune.gbscore.json'));
    const s = useApp.getState();
    expect(s.folder).toBeUndefined();
    expect(s.songs).toEqual([]);
    expect(s.open?.name).toBe('tune.gbscore.json');
    expect(s.open?.song).toBeDefined();
    a.files.set('halt_bug.gbscore.json', '{}');
    await poll(); // there's no folder to read
    expect(useApp.getState().open).toBe(s.open);
  });

  it('keeps the open song when the same folder is opened again', async () => {
    await useFolder(asHandle(new FakeDir('a', { 'halt_bug.gbscore.json': haltBug, 'b.gbscore.json': haltBug })));
    const open = useApp.getState().open;
    const again = new FakeDir('a', { 'halt_bug.gbscore.json': haltBug, 'b.gbscore.json': haltBug });
    await useFolder(asHandle(again));
    expect(useApp.getState().folder).toBe(asHandle(again));
    expect(useApp.getState().open).toBe(open);
  });

  it('ends on the folder picked last, when folders are picked in quick succession', async () => {
    await useFolder(asHandle(new FakeDir('a', { 'halt_bug.gbscore.json': haltBug })));
    const b = new FakeDir('b', { 'b.gbscore.json': haltBug });
    let release!: () => void;
    b.comparing = new Promise((r) => (release = r));
    const c = new FakeDir('c', { 'c.gbscore.json': haltBug });
    const picks = [useFolder(asHandle(b)), useFolder(asHandle(c))];
    await new Promise((r) => setTimeout(r, 0)); // c gets as far as it can while b is held up
    release();
    await Promise.all(picks);
    expect(useApp.getState().folder).toBe(asHandle(c));
    expect(useApp.getState().open?.name).toBe('c.gbscore.json');
  });

  it("doesn't let regaining access to a folder it has left clear the open folder's warning", async () => {
    const b = new FakeDir('b', { 'halt_bug.gbscore.json': haltBug });
    await useFolder(asHandle(b));
    b.denied = true;
    await poll();
    let release!: () => void;
    b.asking = new Promise((r) => (release = r));
    const regaining = regainAccess();
    await useFolder(asHandle(new FakeDir('c', { 'halt_bug.gbscore.json': haltBug })));
    useApp.setState({ lostAccess: true }); // as if c's permission had lapsed too
    release();
    await regaining;
    expect(useApp.getState().lostAccess).toBe(true);
  });

  it("leaves everything as it was when a folder can't be listed", async () => {
    const a = new FakeDir('a', { 'halt_bug.gbscore.json': haltBug });
    await useFolder(asHandle(a));
    const before = useApp.getState();
    const broken = new FakeDir('broken', {});
    broken.denied = true;
    await expect(useFolder(asHandle(broken))).rejects.toThrow();
    expect(useApp.getState().folder).toBe(before.folder);
    expect(useApp.getState().open).toBe(before.open);
  });
});

describe('editing and saving', () => {
  const NAME = 'halt_bug.gbscore.json';
  const note = { row: 2, len: 2, note: 'C5', inst: 1 };
  const drawNote = (row = 2) => edit((song, lane) => edits.draw(song, lane, { ...note, row }));
  const changed = haltBug.replace('Math chiptune in D minor.', 'edited elsewhere');
  let dir: FakeDir;

  beforeEach(async () => {
    useApp.setState({ folder: undefined, open: undefined, probe: undefined, songs: [], lostAccess: false, message: undefined });
    dir = new FakeDir('a', { [NAME]: haltBug });
    await useFolder(asHandle(dir));
    useApp.setState({ view: { ...useApp.getState().view, expanded: 'pulse1' } });
  });

  it('saves the canonical form, and is unsaved again only after another edit', async () => {
    expect(drawNote()).toBe(true);
    expect(unsaved(useApp.getState().open)).toBe(true);
    await save();
    const saved = dir.files.get(NAME)!;
    expect(saved).not.toBe(haltBug);
    expect(saved).toBe(formatSong(useApp.getState().open!.song!));
    expect(unsaved(useApp.getState().open)).toBe(false);
    await poll();
    expect(useApp.getState().open?.conflict).toBeFalsy(); // its own save isn't a change from outside
  });

  it('keeps edits made while it saves unsaved', async () => {
    drawNote();
    let release!: () => void;
    dir.gate = new Promise((r) => (release = r));
    const saving = save();
    await new Promise((r) => setTimeout(r, 0));
    drawNote(8);
    release();
    await saving;
    const open = useApp.getState().open!;
    expect(unsaved(open)).toBe(true);
    expect(dir.files.get(NAME)).toBe(open.baseline);
    expect(open.baseline).not.toContain('"row": 8, "len": 2, "note": "C5"');
  });

  it("doesn't overwrite a file that changed on disk: it writes a mine copy", async () => {
    drawNote();
    dir.files.set(NAME, changed);
    await save();
    expect(dir.files.get(NAME)).toBe(changed);
    const copies = [...dir.files.keys()].filter((n) => /^halt_bug\.mine-\d{8}-\d{6}\.gbscore\.json$/.test(n));
    expect(copies).toHaveLength(1);
    expect(dir.files.get(copies[0]!)).toBe(formatSong(useApp.getState().open!.song!));
    expect(useApp.getState().message?.text).toMatch(/changed on disk, so it wasn't overwritten/);
  });

  it('asks which version to keep when the file changes with unsaved edits; keeping mine saves theirs as a copy', async () => {
    drawNote();
    const mine = useApp.getState().open!.song;
    dir.files.set(NAME, changed);
    await poll();
    expect(useApp.getState().open?.conflict).toBe(true);
    expect(useApp.getState().open?.song).toBe(mine);
    await keepMine();
    const copy = [...dir.files.keys()].find((n) => n.includes('.theirs-'))!;
    expect(dir.files.get(copy)).toBe(changed);
    expect(useApp.getState().open?.conflict).toBe(false);
    await save(); // the file now holds what was kept as theirs, so the save goes ahead
    expect(dir.files.get(NAME)).toBe(formatSong(mine!));
  });

  it("loading theirs saves mine as a copy, and undo can't bring mine back over it", async () => {
    drawNote();
    const mine = formatSong(useApp.getState().open!.song!);
    dir.files.set(NAME, changed);
    await poll();
    await loadTheirs();
    const open = useApp.getState().open!;
    expect(open.baseline).toBe(changed);
    expect(unsaved(open)).toBe(false);
    expect(open.past).toEqual([]);
    expect(dir.files.get([...dir.files.keys()].find((n) => n.includes('.mine-'))!)).toBe(mine);
  });

  it('reloads without asking when there are no unsaved edits, and clears undo', async () => {
    drawNote();
    undo();
    expect(unsaved(useApp.getState().open)).toBe(false); // back to the version on disk
    dir.files.set(NAME, changed);
    await poll();
    const open = useApp.getState().open!;
    expect(open.conflict).toBeFalsy();
    expect(open.baseline).toBe(changed);
    expect(open.past).toEqual([]);
    expect(open.future).toEqual([]);
  });

  it('undoes and redoes, and a new edit clears redo', () => {
    const start = useApp.getState().open!.song;
    drawNote();
    const after = useApp.getState().open!.song;
    undo();
    expect(useApp.getState().open!.song).toBe(start);
    redo();
    expect(useApp.getState().open!.song).toBe(after);
    undo();
    drawNote(8);
    expect(useApp.getState().open!.future).toEqual([]);
  });

  it('makes a drag one step of undo, and drops it if the song is reloaded meanwhile', async () => {
    const start = useApp.getState().open!.song!;
    const notes = start.lanes.pulse1.filter(edits.isNote).slice(0, 1);
    expect(startGesture()).toBe(true);
    for (const by of [1, 2, 3]) gestureTo((song, lane) => edits.move(song, lane, notes, by, 0) as Edit);
    endGesture();
    expect(useApp.getState().open!.past).toEqual([start]);
    undo();

    startGesture();
    gestureTo((song, lane) => edits.move(song, lane, notes, 0, 1) as Edit);
    gestureTo(() => undefined); // dragged back to where it started
    const reloaded = { ...useApp.getState().open!.saved! };
    useApp.setState({ open: { ...useApp.getState().open!, song: reloaded, saved: reloaded } }); // as a reload does
    gestureTo((song, lane) => edits.move(song, lane, notes, 0, 2) as Edit);
    endGesture();
    expect(useApp.getState().open!.past).toEqual([]);
  });

  it("doesn't overwrite the file with a save that waited behind loading theirs", async () => {
    drawNote();
    dir.files.set(NAME, changed);
    await poll();
    await Promise.all([loadTheirs(), save()]);
    expect(dir.files.get(NAME)).toBe(changed);
    expect([...dir.files.keys()].filter((n) => n.includes('.mine-'))).toHaveLength(1); // from loading theirs
  });

  it('saves twice in a row when the second waits for the first', async () => {
    drawNote();
    let release!: () => void;
    dir.gate = new Promise((r) => (release = r));
    const first = save();
    await new Promise((r) => setTimeout(r, 0));
    drawNote(8);
    const second = save();
    release();
    await Promise.all([first, second]);
    const open = useApp.getState().open!;
    expect(unsaved(open)).toBe(false);
    expect(dir.files.get(NAME)).toBe(formatSong(open.song!));
    expect([...dir.files.keys()].filter((n) => n.includes('.mine-'))).toEqual([]);
  });

  it('never writes a copy over another', async () => {
    for (const n of [1, 2]) {
      drawNote(n * 8);
      dir.files.set(NAME, changed.replace('edited elsewhere', `edit ${n}`));
      await poll();
      await keepMine();
      await save();
    }
    const copies = [...dir.files.keys()].filter((n) => n.includes('.theirs-')).map((n) => dir.files.get(n));
    expect(copies.sort()).toEqual([1, 2].map((n) => changed.replace('edited elsewhere', `edit ${n}`)));
  });

  it('stays unsaved after keeping mine, even when every edit is undone', async () => {
    drawNote();
    dir.files.set(NAME, changed);
    await poll();
    await keepMine();
    undo();
    expect(useApp.getState().open?.past).toEqual([]);
    expect(unsaved(useApp.getState().open)).toBe(true);
  });

  it("doesn't open another song over edits made while it was being read", async () => {
    dir.files.set('other.gbscore.json', haltBug);
    let release!: () => void;
    dir.reading = new Promise((r) => (release = r));
    const opening = openSong('other.gbscore.json');
    await new Promise((r) => setTimeout(r, 0));
    drawNote();
    release();
    await opening;
    expect(useApp.getState().open?.name).toBe(NAME);
    expect(unsaved(useApp.getState().open)).toBe(true);
    expect(useApp.getState().message?.text).toMatch(/was edited meanwhile/);
  });

  it('gives back the selection when a drag returns to where it started', () => {
    const notes = useApp.getState().open!.song!.lanes.pulse1.filter(edits.isNote).slice(0, 1);
    useApp.setState({ selection: notes });
    startGesture();
    gestureTo((song, lane) => edits.move(song, lane, notes, 1, 0) as Edit);
    gestureTo(() => undefined);
    endGesture();
    expect(useApp.getState().selection).toEqual(notes);
    expect(useApp.getState().selection[0]).toBe(notes[0]);
  });

  it('ends a drag as its own step of undo when a key edits during it', () => {
    const start = useApp.getState().open!.song!;
    const notes = start.lanes.pulse1.filter(edits.isNote).slice(0, 1);
    startGesture();
    gestureTo((song, lane) => edits.move(song, lane, notes, 1, 0) as Edit);
    expect(edit((song, lane, selection) => edits.move(song, lane, selection, 0, 1))).toBe(true);
    endGesture(); // the pointer comes up
    undo();
    undo();
    expect(useApp.getState().open!.song).toBe(start);
  });

  it("won't edit a song whose file isn't valid", async () => {
    dir.files.set(NAME, '{"version": 1');
    await poll();
    expect(useApp.getState().open?.broken).toBe(true);
    expect(drawNote()).toBe(false);
    expect(useApp.getState().message?.text).toMatch(/can't be edited/);
  });
});

describe('note entry', () => {
  const C5 = 24;
  const lane = () => useApp.getState().open!.song!.lanes.pulse1.filter(edits.isNote);
  let now = 0;

  beforeEach(async () => {
    useApp.setState({ folder: undefined, open: undefined, songs: [], message: undefined, hear: true, playing: false, entry: true });
    await useFolder(asHandle(new FakeDir('a', { 'halt_bug.gbscore.json': haltBug })));
    const view = useApp.getState().view;
    useApp.setState({ view: { ...view, expanded: 'pulse1' }, startRow: 0 });
    const open = useApp.getState().open!;
    useApp.setState({ open: { ...open, song: { ...open.song!, lanes: { ...open.song!.lanes, pulse1: [] } } } });
    setPen('pulse1', { len: 4 });
    entry.releaseAll();
    heard.length = 0;
    heardData.length = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  const tap = (id: string, index: number, ms = 200) => {
    entry.press(id, index);
    now += ms;
    entry.release(id);
  };

  it('puts notes one after another from the flag, and hears each', () => {
    tap('KeyA', C5);
    tap('KeyD', C5 + 4);
    expect(lane().map((n) => [n.row, n.len, n.note])).toEqual([
      [0, 4, 'C5'],
      [4, 4, 'E5'],
    ]);
    expect(useApp.getState().startRow).toBe(8);
    expect(heard).toHaveLength(2);
    expect(heard[0]).toBeGreaterThan(0);
  });

  it('puts a chord at one row, the last note winning, and moves the flag once', () => {
    entry.press('KeyA', C5);
    now += 10;
    entry.press('KeyD', C5 + 4);
    entry.release('KeyA');
    entry.release('KeyD');
    expect(lane().map((n) => [n.row, n.note])).toEqual([[0, 'E5']]);
    expect(useApp.getState().startRow).toBe(4);
  });

  it('follows on from a note still held when the next comes later, as in fast playing', () => {
    entry.press('KeyA', C5);
    now += 120;
    entry.press('KeyS', C5 + 2);
    entry.release('KeyA');
    entry.release('KeyS');
    expect(lane().map((n) => n.row)).toEqual([0, 4]);
  });

  it("doesn't make a chord with a note that was let go, though an earlier one is still held", () => {
    entry.press('KeyA', C5);
    now += 100;
    entry.press('KeyS', C5 + 2);
    now += 10;
    entry.release('KeyS');
    now += 10;
    entry.press('KeyD', C5 + 4);
    expect(lane().map((n) => [n.row, n.note])).toEqual([
      [0, 'C5'],
      [4, 'D5'],
      [8, 'E5'],
    ]);
  });

  it('follows on when the same key is pressed again quickly', () => {
    tap('KeyA', C5, 10);
    tap('KeyA', C5, 10);
    expect(lane().map((n) => n.row)).toEqual([0, 4]);
  });

  it('ignores a key already held, as key repeat sends', () => {
    entry.press('KeyA', C5);
    entry.press('KeyA', C5);
    expect(lane()).toHaveLength(1);
  });

  // Docs, "Hearing a note": the ticks its rows have in the song, through its whole length, and the effects in it.
  it('hears a note with the tempo of each of its rows and the effects inside it', () => {
    const open = useApp.getState().open!;
    const note = { row: 4, len: 4, note: 'C5', inst: 1 };
    const song = {
      ...open.song!,
      global: [{ row: 0, tempo: 6 }, { row: 6, tempo: 3 }],
      lanes: { ...open.song!.lanes, pulse1: [note, { row: 5, fx: { vibrato: [4, 2] as [number, number] } }] },
    };
    useApp.setState({ open: { ...open, song } });
    hearNote('pulse1', note);
    expect(useApp.getState().message).toBeUndefined();
    expect(heard).toEqual([((6 + 6 + 3 + 3) / TICK_RATE) * 1000]);
  });

  // A note entered on a row with an effect took the effect, but was heard without it.
  it('hears an entered note with the effect it took from its row', () => {
    const open = useApp.getState().open!;
    const song = { ...open.song!, lanes: { ...open.song!.lanes, pulse1: [{ row: 0, fx: { volume: 0 } }] } };
    useApp.setState({ open: { ...open, song } });
    tap('KeyA', C5);
    const placed = lane()[0]!;
    expect(placed.fx).toEqual({ volume: 0 });
    hearNote('pulse1', placed);
    hearNote('pulse1', { ...placed, fx: undefined });
    expect(heardData).toHaveLength(3);
    expect(heardData[0]).toEqual(heardData[1]);
    expect(heardData[0]).not.toEqual(heardData[2]);
  });

  it("isn't heard with hearing off or while the song plays", () => {
    useApp.setState({ hear: false });
    tap('KeyA', C5);
    useApp.setState({ hear: true, playing: true });
    tap('KeyS', C5);
    expect(lane()).toHaveLength(2);
    expect(heard).toEqual([]);
  });

  it('shortens the last note to fit the song, and says where the song ends', () => {
    const length = useApp.getState().open!.song!.length;
    useApp.setState({ startRow: length - 2 });
    tap('KeyA', C5);
    expect(lane().at(-1)).toMatchObject({ row: length - 2, len: 2 });
    expect(useApp.getState().message?.text).toMatch(/end of the song/);
    tap('KeyD', C5 + 4); // doesn't replace it
    expect(lane().at(-1)).toMatchObject({ row: length - 2, len: 2, note: 'C5' });
    expect(useApp.getState().message?.text).toMatch(/move it back/);
  });

  it('says a note out of range is, and enters nothing', () => {
    tap('midi:20', 20 - 36);
    expect(lane()).toEqual([]);
    expect(useApp.getState().message?.text).toMatch(/out of range/);
  });
});

describe("the song's length and loop", () => {
  const song = () => useApp.getState().open!.song!;

  beforeEach(async () => {
    useApp.setState({ folder: undefined, open: undefined, songs: [], message: undefined, loop: undefined, looping: false });
    await useFolder(asHandle(new FakeDir('a', { 'halt_bug.gbscore.json': haltBug })));
    useApp.setState({ view: { ...useApp.getState().view, expanded: 'pulse1' } });
  });

  it('cuts past a shorter end as one step of undo, says what went, and keeps the flag and selection in the song', () => {
    const before = song();
    const last = before.lanes.pulse1.filter(edits.isNote).at(-1)!;
    const end = last.row; // the last note starts here, so it goes
    store.select([last]);
    useApp.setState({ startRow: before.length - 1, loop: { start: end + 4, end: end + 8 }, looping: true });
    expect(store.setRange(end)).toBe(true);
    expect(song().length).toBe(end);
    expect(song().lanes.pulse1).not.toContain(last);
    expect(useApp.getState()).toMatchObject({ selection: [], startRow: end, loop: undefined, looping: false });
    expect(useApp.getState().message).toMatchObject({ error: false, text: expect.stringMatching(/^The song now ends at .*cut.*Undo/) });
    undo();
    expect(song()).toBe(before);
  });

  it('keeps the selection when nothing is cut, and says why it refuses a loop past the end', () => {
    const first = song().lanes.pulse1.find(edits.isNote)!;
    store.select([first]);
    expect(store.setRange(song().length + 64)).toBe(true);
    expect(useApp.getState().selection).toEqual([first]);
    expect(store.setRange(song().length, song().length)).toBe(false);
    expect(useApp.getState().message).toMatchObject({ error: true, text: expect.stringMatching(/^Can't: loop .* must be less than length/) });
  });
});

describe("the song's settings", () => {
  const song = () => useApp.getState().open!.song!;
  const info = (more: Partial<import('../src/app/store.ts').SongInfo> = {}) => ({
    title: song().title ?? '',
    artist: song().artist ?? '',
    comment: song().comment ?? '',
    grid: song().grid,
    groove: song().groove,
    ...more,
  });

  beforeEach(async () => {
    useApp.setState({ folder: undefined, open: undefined, songs: [], message: undefined });
    await useFolder(asHandle(new FakeDir('a', { 'halt_bug.gbscore.json': haltBug })));
  });

  it('sets the text and grid as one step of undo, leaving blank text out of the file', () => {
    const before = song();
    expect(store.setInfo(info({ title: ' Home ', artist: '', comment: 'a\nb', grid: { rowsPerBeat: 3, beatsPerBar: 3 } }))).toBe(true);
    expect(song()).toMatchObject({ title: 'Home', comment: 'a\nb', grid: { rowsPerBeat: 3, beatsPerBar: 3 } });
    expect(JSON.parse(formatSong(song()))).not.toHaveProperty('artist');
    expect(useApp.getState().open!.errors).toEqual([]);
    undo();
    expect(song()).toBe(before);
  });

  it("makes no step of undo when nothing changed, and refuses a grid the schema doesn't allow", () => {
    const before = song();
    expect(store.setInfo(info())).toBe(true);
    expect(useApp.getState().open!.past).toEqual([]);
    expect(store.setInfo(info({ grid: { rowsPerBeat: 0, beatsPerBar: 4 } }))).toBe(false);
    expect(store.setInfo(info({ grid: { rowsPerBeat: 4, beatsPerBar: 65 } }))).toBe(false);
    expect(useApp.getState().message).toMatchObject({ error: true, text: expect.stringMatching(/^Can't: rows per beat/) });
    expect(song()).toBe(before);
  });

  it('sets the groove as one step of undo, and the song plays at it', () => {
    const before = song();
    expect(before.groove).toEqual([6, 6, 6, 6]);
    expect(store.setInfo(info({ groove: [6, 6, 6, 8] }))).toBe(true);
    expect(song().groove).toEqual([6, 6, 6, 8]);
    expect(rowTicks(song(), new Map())[3]).toEqual([8]);
    expect(useApp.getState().open!.errors).toEqual([]);
    undo();
    expect(song()).toBe(before);
  });

  it("refuses a groove the loop row can't keep in phase, or a step out of range, saying why", () => {
    store.setInfo(info({ groove: [6, 6, 6, 6] }));
    expect(store.setRange(song().length, 6)).toBe(true);
    const before = song();
    expect(store.setInfo(info({ groove: [5, 5, 5, 7] }))).toBe(false);
    expect(useApp.getState().message).toMatchObject({
      error: true,
      text: "Can't: loop (6) must be a multiple of 4 when the groove isn't uniform, so the groove keeps its phase. Move the loop on the ruler first.",
    });
    expect(store.setInfo(info({ groove: [7, 7, 7, 7] }))).toBe(true); // uniform: any loop
    expect(store.setInfo(info({ groove: [7, 7, 7, 0] }))).toBe(false);
    expect(store.setInfo(info({ groove: [7, 7, 256, 7] }))).toBe(false);
    expect(useApp.getState().message?.text).toMatch(/^Can't: each groove step is 1 to 255 ticks/);
    expect(song().groove).toEqual([7, 7, 7, 7]);
    expect(song().loop).toBe(before.loop);
  });

  it("keeps the pens' note lengths on the same choice when the grid changes, and on undo", () => {
    expect(song().grid).toEqual({ rowsPerBeat: 4, beatsPerBar: 4 });
    setPen('pulse1', { len: 4 }); // a beat
    setPen('pulse2', { len: 16 }); // a bar
    setPen('wave', { len: 5 }); // not a choice on either grid
    store.setInfo(info({ grid: { rowsPerBeat: 6, beatsPerBar: 3 } }));
    expect(useApp.getState().pen).toMatchObject({ pulse1: { len: 6 }, pulse2: { len: 18 }, wave: { len: 5 }, noise: { len: 6 } });
    undo();
    expect(useApp.getState().pen).toMatchObject({ pulse1: { len: 4 }, pulse2: { len: 16 }, wave: { len: 5 } });
  });
});

describe('play keys', () => {
  const C5 = 24;
  const notes = () => useApp.getState().open!.song!.lanes.pulse1;
  // The note each heard song plays in pulse 1, as the driver numbers it (0 is C3).
  const pitches = () =>
    (heardData as { orders: number[][]; patterns: { note: number }[][] }[]).map((s) => s.patterns[s.orders[0]![0]!]![0]!.note);

  beforeEach(async () => {
    useApp.setState({ folder: undefined, open: undefined, songs: [], message: undefined, hear: false, playing: false });
    useApp.setState({ entry: false, playKeys: true, selection: [] });
    await useFolder(asHandle(new FakeDir('a', { 'halt_bug.gbscore.json': haltBug })));
    useApp.setState({ view: { ...useApp.getState().view, expanded: 'pulse1' } });
    entry.releaseAll();
    heard.length = 0;
    heardData.length = 0;
    released.length = 0;
  });

  it('plays a note until its key is let go, even with hearing off, and enters nothing', () => {
    const before = notes();
    entry.press('KeyA', C5);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeGreaterThanOrEqual(30_000);
    expect(pitches()).toEqual([C5]);
    expect(released).toEqual([]);
    entry.release('KeyA');
    expect(released).toEqual([1]);
    expect(notes()).toBe(before);
  });

  it('plays one note at a time: the newest, which letting go of an older key leaves sounding', () => {
    entry.press('KeyA', C5);
    entry.press('KeyD', C5 + 4);
    entry.release('KeyA');
    expect(released).toEqual([]);
    entry.release('KeyD');
    expect(released).toEqual([2]);
    expect(pitches()).toEqual([C5, C5 + 4]);
  });

  it('stops what it plays when the window loses focus', () => {
    entry.press('KeyA', C5);
    entry.releaseAll();
    expect(released).toEqual([1]);
  });

  it("is silent while the song plays", () => {
    useApp.setState({ playing: true });
    entry.press('KeyA', C5);
    entry.release('KeyA');
    expect(heard).toEqual([]);
  });

  // An instrument change heard while a key was held took over the note, and key-up didn't stop it.
  it('hears a change with the note held, still held, and stops it when the key is let go', () => {
    useApp.setState({ hear: true });
    entry.press('KeyE', C5 + 3);
    tryInstrument(useApp.getState().pen.pulse1.inst, false); // as 150 ms after a change
    expect(heard).toHaveLength(2);
    expect(heard[1]).toBeGreaterThanOrEqual(30_000);
    expect(pitches()).toEqual([C5 + 3, C5 + 3]);
    entry.release('KeyE');
    expect(released).toEqual([2]);
  });

  // A key whose note couldn't play forgot the note still sounding, so nothing could stop it.
  it('still stops a held note after another key fails to play', () => {
    entry.press('KeyA', C5);
    setPen('pulse1', { inst: 15 }); // not defined, so the next note doesn't compile
    entry.press('KeyD', C5 + 4);
    expect(heard).toHaveLength(1);
    expect(useApp.getState().message?.text).toMatch(/Can't hear/);
    entry.release('KeyD');
    expect(released).toEqual([]);
    entry.release('KeyA');
    expect(released).toEqual([1]);
  });

  it("shows the notes whose keys are down on the roll's keyboard", () => {
    entry.press('KeyA', C5);
    entry.press('midi:64', C5 + 4);
    entry.press('KeyP', 99); // out of range
    expect(useApp.getState().keysDown).toEqual([C5, C5 + 4]);
    entry.release('KeyA');
    expect(useApp.getState().keysDown).toEqual([C5 + 4]);
    entry.releaseAll();
    expect(useApp.getState().keysDown).toEqual([]);
  });

  it("plays a key clicked on the roll's keyboard while it's held, without entering it, even with note entry on", () => {
    useApp.setState({ entry: true, hear: true });
    const before = notes();
    entry.press('pointer', C5, true);
    expect(pitches()).toEqual([C5]);
    expect(heard[0]).toBeGreaterThanOrEqual(30_000);
    entry.release('pointer');
    expect(released).toEqual([1]);
    expect(notes()).toBe(before);
  });

  it('gives Try the last note played', () => {
    entry.press('KeyE', C5 + 15);
    entry.release('KeyE');
    tryInstrument(useApp.getState().pen.pulse1.inst, true);
    expect(pitches()).toEqual([C5 + 15, C5 + 15]);
  });
});

describe('instruments', () => {
  const duty = () => useApp.getState().open!.song!.instruments.duty;

  beforeEach(async () => {
    useApp.setState({ folder: undefined, open: undefined, songs: [], message: undefined, hear: true, playing: false, selection: [] });
    await useFolder(asHandle(new FakeDir('a', { 'halt_bug.gbscore.json': haltBug })));
    useApp.setState({ view: { ...useApp.getState().view, expanded: 'pulse1' } });
    heard.length = 0;
  });

  it('makes a slider drag one step of undo, compiled when it ends', () => {
    const before = useApp.getState().open!;
    expect(startGesture()).toBe(true);
    for (const volume of [3, 7, 11]) songGestureTo((song) => updateInstrument(song, 'duty', 1, { volume }));
    expect(useApp.getState().open!.playable).toBe(before.playable); // not compiled mid-drag
    endGesture();
    expect(duty()[0]!.volume).toBe(11);
    expect(useApp.getState().open!.playable).not.toBe(before.playable);
    undo();
    expect(useApp.getState().open!.song).toBe(before.song);
  });

  it('adds an instrument and picks it for new notes; removes it and picks the one before', () => {
    addInstrument();
    expect(duty().map((i) => i.id)).toEqual([1, 2, 3, 4, 5]);
    expect(useApp.getState().pen.pulse1.inst).toBe(5);
    removeInstrument(5);
    expect(duty().map((i) => i.id)).toEqual([1, 2, 3, 4]);
    expect(useApp.getState().pen.pulse1.inst).toBe(4);
  });

  it('keeps both pulse lanes on instruments the song has, after a removal or an undo', () => {
    setPen('pulse2', { inst: 2 });
    setPen('pulse1', { inst: 2 });
    removeInstrument(2);
    expect([useApp.getState().pen.pulse1.inst, useApp.getState().pen.pulse2.inst]).toEqual([1, 1]);
    addInstrument();
    expect(useApp.getState().pen.pulse1.inst).toBe(2);
    undo();
    expect(useApp.getState().pen.pulse1.inst).toBe(1);
  });

  it('says a gesture has ended, as when another edit ended it, so a held control can make its own step', () => {
    startGesture();
    expect(songGestureTo((song) => updateInstrument(song, 'duty', 1, { volume: 3 }))).toBe(true);
    edit((song, lane) => edits.draw(song, lane, { row: 0, len: 1, note: 'C5', inst: 1 }));
    expect(songGestureTo((song) => updateInstrument(song, 'duty', 1, { volume: 5 }))).toBe(false);
  });

  it("won't remove an instrument notes use, and says so", () => {
    const before = useApp.getState().open!.song;
    removeInstrument(3);
    expect(useApp.getState().open!.song).toBe(before);
    expect(useApp.getState().message).toMatchObject({ error: true, text: expect.stringMatching(/36 notes use it/) });
  });

  it('gives the selected notes an instrument, keeping them selected', () => {
    const notes = useApp.getState().open!.song!.lanes.pulse1.filter(edits.isNote).slice(0, 2);
    useApp.setState({ selection: notes });
    giveSelection(3);
    const selection = useApp.getState().selection;
    expect(selection.map((n) => n.inst)).toEqual([3, 3]);
    expect(useApp.getState().open!.song!.lanes.pulse1).toContain(selection[0]);
  });

  it('makes the selected notes legato as one step, and normal again with the instrument each was playing with', () => {
    const before = useApp.getState().open!.song!;
    const notes = before.lanes.pulse1.filter(edits.isNote);
    useApp.setState({ selection: notes.slice(1, 3) });
    store.toggleLegato();
    let selection = useApp.getState().selection;
    expect(selection.map((n) => [n.legato, n.inst])).toEqual([[true, undefined], [true, undefined]]);
    expect(useApp.getState().open!.song!.lanes.pulse1).toContain(selection[1]);
    expect(useApp.getState().open!.errors).toEqual([]);
    expect(useApp.getState().message?.text).toMatch(/^2 notes now legato: .* play the song to hear it\.$/);

    store.toggleLegato();
    selection = useApp.getState().selection;
    expect(selection.map((n) => [n.legato, n.inst])).toEqual([[undefined, notes[0]!.inst], [undefined, notes[0]!.inst]]);
    undo();
    undo();
    expect(useApp.getState().open!.song).toBe(before);
  });

  it('makes a mixed selection all legato, and refuses legato on the wave lane', () => {
    const notes = useApp.getState().open!.song!.lanes.pulse1.filter(edits.isNote);
    useApp.setState({ selection: notes.slice(1, 2) });
    store.toggleLegato();
    const [legato] = useApp.getState().selection;
    useApp.setState({ selection: [legato!, notes[2]!] });
    store.toggleLegato();
    expect(useApp.getState().selection.map((n) => n.legato)).toEqual([true, true]);

    useApp.setState({ view: { ...useApp.getState().view, expanded: 'wave' } });
    const before = useApp.getState().open!.song;
    useApp.setState({ selection: [] }); // the lane is refused whatever's selected
    store.toggleLegato();
    expect(useApp.getState().open!.song).toBe(before);
    expect(useApp.getState().message).toMatchObject({ error: true, text: expect.stringMatching(/^Can't: notes on the wave lane/) });
  });

  it('plays an instrument on Try even with hearing off, and after a change only with it on', () => {
    useApp.setState({ hear: false });
    tryInstrument(1, false);
    expect(heard).toEqual([]);
    tryInstrument(1, true);
    expect(heard).toHaveLength(1);
  });
});

describe('patterns', () => {
  const NAME = 'riffs.gbscore.json';
  const riff = { id: 'riff', kind: 'duty', length: 8, items: [{ row: 0, len: 4, note: 'C5', inst: 1 }, { row: 4, len: 4, note: 'E5', inst: 1 }] };
  const text = formatSong(
    JSON.parse(
      JSON.stringify({
        version: 1,
        grid: { rowsPerBeat: 4, beatsPerBar: 4 },
        groove: [6, 6, 6, 6],
        length: 64,
        instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }, { id: 2, duty: '25%', volume: 15 }] },
        patterns: [riff],
        lanes: { pulse1: [{ row: 0, len: 4, note: 'G5', inst: 2 }, { row: 16, pattern: 'riff', repeat: 2 }] },
      }),
    ),
  );
  const pulse1 = () => useApp.getState().open!.song!.lanes.pulse1;
  let dir: FakeDir;

  beforeEach(async () => {
    useApp.setState({ folder: undefined, open: undefined, songs: [], message: undefined, selection: [] });
    dir = new FakeDir('p', { [NAME]: text });
    await useFolder(asHandle(dir));
    useApp.setState({ view: { ...useApp.getState().view, expanded: 'pulse1' } });
  });

  it('opens and plays a song with patterns', () => {
    const open = useApp.getState().open!;
    expect(open.errors).toEqual([]);
    expect(open.playable).toBeDefined();
  });

  it('edits notes around placements, keeping them, and saves them', async () => {
    expect(edit((song, lane) => edits.draw(song, lane, { row: 40, len: 4, note: 'A5', inst: 1 }))).toBe(true);
    expect(pulse1().map((i) => i.pattern ?? i.note)).toEqual(['G5', 'riff', 'A5']);
    await save();
    expect(JSON.parse(dir.files.get(NAME)!).lanes.pulse1[1]).toEqual({ row: 16, pattern: 'riff', repeat: 2 });
  });

  it('gives a note made normal again the instrument it was playing with as heard, from a pattern before it', () => {
    edit((song, lane) => edits.draw(song, lane, { row: 40, len: 4, note: 'A5', inst: 2 }));
    useApp.setState({ selection: pulse1().filter((i) => i.row === 40) });
    store.toggleLegato();
    store.toggleLegato();
    expect(pulse1().find((i) => i.row === 40)).toEqual({ row: 40, len: 4, note: 'A5', inst: 1 }); // the riff's E5
  });

  it("toggles legato on a note of an open pattern whose place transposes it and gives it an instrument", () => {
    const open = useApp.getState().open!;
    const song = { ...open.song!, lanes: { ...open.song!.lanes, pulse1: [pulse1()[0]!, { ...pulse1()[1]!, transpose: 2, inst: 2 }] } };
    useApp.setState({ open: { ...open, song, saved: song } });
    store.targetRow(26); // the second repeat, rows 24 to 31
    const riff = () => useApp.getState().open!.song!.patterns![0]!.items;
    useApp.setState({ selection: store.shown()!.lanes.pulse1.filter((i) => i.row === 28) }); // E5, heard as F#5
    store.toggleLegato();
    expect(riff()[1]).toEqual({ row: 4, len: 4, note: 'E5', legato: true });
    expect(store.shown()!.lanes.pulse1).toContain(useApp.getState().selection[0]);
    store.toggleLegato();
    expect(riff()[1]).toEqual({ row: 4, len: 4, note: 'E5', inst: 2 }); // the place's instrument, as heard
    expect(useApp.getState().open!.errors).toEqual([]);
  });

  it("refuses to put a note in a placement's rows, or run one into them", () => {
    const before = useApp.getState().open!.song;
    expect(edit((song, lane) => edits.draw(song, lane, { row: 26, len: 2, note: 'A5', inst: 1 }))).toBe(false);
    expect(useApp.getState().message?.text).toBe("Can't: pattern riff plays there (from 2.1.1), and loose notes can't go in it.");
    expect(edit((song, lane) => edits.draw(song, lane, { row: 12, len: 8, note: 'A5', inst: 1 }))).toBe(false);
    expect(useApp.getState().message?.text).toBe("Can't: the note would run into pattern riff, which plays from 2.1.1.");
    expect(useApp.getState().open!.song).toBe(before);
  });

  it("refuses an effect where a pattern's note ends, since its cut needs the slot; clearing one is fine", () => {
    const setFx = (fx: object | undefined) => edit((song, lane, sel) => effects.setEffect(song, lane, 32, fx as never, sel));
    expect(setFx({ volume: 4 })).toBe(false);
    expect(useApp.getState().message?.text).toBe("Can't: E5 in pattern riff ends at 3.1.1, and its cut needs that row's effect slot.");
    expect(setFx(undefined)).toBe(true);
  });

  it('targets a place a pattern plays, and an edit there changes every place, as one step of undo', () => {
    store.targetRow(26); // in the second repeat
    expect(useApp.getState().opened).toEqual({ lane: 'pulse1', start: 24, id: 'riff' });
    expect(edit((song, lane) => edits.draw(song, lane, { row: 26, len: 2, note: 'G5', inst: 1 }))).toBe(true);
    const song = useApp.getState().open!.song!;
    expect(song.patterns![0]!.items.map((i) => `${i.note}@${i.row}`)).toEqual(['C5@0', 'G5@2', 'E5@4']);
    expect(song.lanes).toBe(useApp.getState().open!.past[0]!.lanes);
    expect(expand(song).song.lanes.pulse1.filter((i) => i.note === 'G5').map((i) => i.row)).toEqual([0, 18, 26]);
    // The selection is the note the roll draws there.
    expect(store.shown()!.lanes.pulse1).toContain(useApp.getState().selection[0]);
    undo();
    expect(useApp.getState().open!.song!.patterns![0]!.items).toHaveLength(2);
    expect(useApp.getState().opened).toBeDefined();
  });

  it('refuses an edit outside the target, and drops the target when it goes', () => {
    store.targetRow(16);
    expect(edit((song, lane) => edits.draw(song, lane, { row: 40, len: 2, note: 'A5', inst: 1 }))).toBe(false);
    expect(useApp.getState().message?.text).toBe("Can't: notes in pattern riff stay between 2.1.1 and 2.3.1, where this place plays it.");
    // A reload without the placement closes it.
    const open = useApp.getState().open!;
    const song = { ...open.song!, lanes: { ...open.song!.lanes, pulse1: [pulse1()[0]!] } };
    useApp.setState({ open: { ...open, song, saved: song } });
    expect(useApp.getState().opened).toBeUndefined();
  });

  it('drags a placement as one step of undo, stopping where it last fit', () => {
    const item = pulse1()[1]!;
    store.selectPlacement(item);
    startGesture();
    store.arrangeGestureTo((song, lane) => arrangeOps.movePlacement(song, lane, item, 8, false));
    store.arrangeGestureTo((song, lane) => arrangeOps.movePlacement(song, lane, item, -16, false)); // onto G5: refused
    endGesture();
    expect(pulse1().map((i) => i.row)).toEqual([0, 24]);
    expect(useApp.getState().placement).toBe(pulse1()[1]);
    expect(useApp.getState().open!.past).toHaveLength(1);
  });

  it("checks an instrument edit against the whole song with a place as the target, keeping its selection", () => {
    store.targetRow(16);
    store.selectAll();
    const selected = useApp.getState().selection;
    expect(selected).toHaveLength(2);
    removeInstrument(2); // the loose G5 outside the pattern uses it
    expect(useApp.getState().message?.text).toMatch(/^Can't: 1 note uses it/);
    store.editSong((song) => updateInstrument(song, 'duty', 1, { volume: 3 }));
    expect(useApp.getState().selection).toBe(selected);
    expect(store.shown()!.lanes.pulse1).toContain(selected[0]);
  });

  it("won't arrange a placement selected in a song that's since been replaced, as by a reload", () => {
    store.selectPlacement(pulse1()[1]);
    const open = useApp.getState().open!;
    const song = structuredClone(open.song!);
    useApp.setState({ open: { ...open, song, saved: song } });
    expect(store.movePlacement(16)).toBe(false);
    expect(useApp.getState().message?.text).toBe("Can't: select a placed pattern first.");
    expect(pulse1().map((i) => i.row)).toEqual([0, 16]);
  });

  it('renames the target pattern and keeps it the target', () => {
    store.targetRow(16);
    store.selectAll();
    expect(store.renamePattern('riff', 'lead')).toBe(true);
    expect(useApp.getState().opened).toEqual({ lane: 'pulse1', start: 16, id: 'lead' });
    expect(useApp.getState().selection).toEqual([]);
    expect(pulse1()[1]!.pattern).toBe('lead');
  });

  it('makes a pattern of the selected notes and selects its placement', () => {
    useApp.setState({ selection: [pulse1()[0]!] });
    store.makePattern();
    expect(pulse1()).toEqual([{ row: 0, pattern: 'p2' }, { row: 16, pattern: 'riff', repeat: 2 }]);
    expect(useApp.getState().placement).toBe(pulse1()[0]);
  });

  it("won't target a repeat cut short, and drops the target when a len cuts it short", () => {
    store.selectPlacement(pulse1()[1]);
    expect(store.setPlacement({ len: 12 })).toBe(true);
    expect(store.targetRow(26)).toBe(false);
    expect(useApp.getState().message?.text).toBe('This repeat of pattern riff is cut short; edit it where it plays whole.');
    expect(store.targetRow(18)).toBe(true);
    expect(useApp.getState().opened).toEqual({ lane: 'pulse1', start: 16, id: 'riff' });
    store.selectPlacement(pulse1()[1]);
    expect(store.setPlacement({ repeat: 1, len: 4 })).toBe(true);
    expect(useApp.getState().opened).toBeUndefined();
  });

  it('places the current pattern: the one last selected or made', () => {
    store.placeAt(40);
    expect(useApp.getState().message?.text).toMatch(/^Make a pattern/);
    store.selectPlacement(pulse1()[1]);
    expect(useApp.getState().brush).toBe('riff');
    store.placeAt(40);
    expect(pulse1().map((i) => i.pattern ?? i.note)).toEqual(['G5', 'riff', 'riff']);
    expect(useApp.getState().placement).toBe(pulse1()[2]);
    useApp.setState({ selection: [pulse1()[0]!] });
    store.makePattern();
    expect(useApp.getState().brush).toBe('p2');
    // It follows its pattern's renames, and a placement made unique.
    store.renamePattern('p2', 'intro');
    expect(useApp.getState().brush).toBe('intro');
    store.selectPlacement(pulse1()[1]);
    store.makeUnique();
    expect(useApp.getState().brush).toBe('riff-2');
  });

  it('stops a drag where it last could be when it would go into a placement', () => {
    const [g5] = pulse1();
    startGesture();
    gestureTo((song, lane) => edits.move(song, lane, [g5!], 4, 0) as Edit);
    gestureTo((song, lane) => edits.move(song, lane, [g5!], 14, 0) as Edit);
    endGesture();
    expect(pulse1().map((i) => i.row)).toEqual([4, 16]);
  });
});
