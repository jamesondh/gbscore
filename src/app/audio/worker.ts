import wasmUrl from '../../../emu/binjgb.wasm?url';
import romUrl from '../../../driver/player.gbc?url';
import symbolsUrl from '../../../driver/player.sym?url';
import { assemble, type DriverSong } from '../../core/driver.ts';
import { DcFilter } from '../../play/dc.ts';
import { Wasm } from '../../play/emulator.ts';
import { Playback, SONG_ADDRESS, type PlayerAssets, type Snapshot, type Tick } from '../../play/player.ts';
import type { Chunk, Flush, FromWorker, Loop, PlayPosition, Played, Prepare, ToWorker } from './protocol.ts';

// Runs the emulator for the app. Playing from a row means playing the song silently up to it, so the worker keeps
// saved states of the song's first pass every SNAPSHOT_ROWS rows, made in the background when a song is prepared
// and as it plays, and starts from the nearest one. Then it plays one tick of audio at a time, keeping the
// worklet's queue about AHEAD seconds ahead of what it has played. Looping, it saves the state at the loop's start
// row, found by a second Runner, and goes back to it after the loop's last row.

const AHEAD = 0.2;
const SNAPSHOT_ROWS = 64;
const SLICE_MS = 20; // silent running happens in slices this long, so other messages get handled between them

async function loadAssets(): Promise<PlayerAssets> {
  const get = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`couldn't load ${url}: ${r.status}`);
    return r;
  };
  const [wasm, rom, symbols] = await Promise.all([
    get(wasmUrl).then((r) => r.arrayBuffer()).then((b) => Wasm.load(b)),
    get(romUrl).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
    get(symbolsUrl).then((r) => r.text()),
  ]);
  return { wasm, rom, symbols };
}

const assets = loadAssets();
let worklet: MessagePort | undefined;
let session: Session | undefined;
let preparing: Runner | undefined;
let prepared: Prepare | undefined; // the song to keep snapshots of
let muted = [false, false, false, false]; // channels left out of the song playing, but not of a note being heard

const post = (m: FromWorker) => self.postMessage(m);
const flush = (id: number) => {
  const m: Flush = { type: 'flush', id };
  worklet?.postMessage(m);
};
const yieldToEvents = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Snapshots of one compiled song at one sample rate, by the timeline row they start. */
class Snapshots {
  readonly rows = new Map<number, Snapshot>();
  readonly song: Uint8Array;
  readonly sampleRate: number;

  constructor(song: DriverSong, sampleRate: number) {
    this.song = assemble(song, SONG_ADDRESS);
    this.sampleRate = sampleRate;
  }

  matches(song: DriverSong, sampleRate: number): boolean {
    const bytes = assemble(song, SONG_ADDRESS);
    return sampleRate === this.sampleRate && bytes.length === this.song.length && bytes.every((b, i) => b === this.song[i]);
  }

  /** The latest snapshot at or before a row. */
  before(row: number): [number, Snapshot] | undefined {
    let best: [number, Snapshot] | undefined;
    for (const entry of this.rows) if (entry[0] <= row && (!best || entry[0] > best[0])) best = entry;
    return best;
  }
}

let snapshots: Snapshots | undefined;

function snapshotsFor(song: DriverSong, sampleRate: number): Snapshots {
  if (!snapshots?.matches(song, sampleRate)) snapshots = new Snapshots(song, sampleRate);
  return snapshots;
}

/** A Playback that runs silently to a row, starting from the nearest snapshot and saving more as it goes. */
class Runner {
  readonly p: Playback;
  stopped = false;
  private started = 0; // rows started so far, in the order they play
  private readonly orderStarts: number[];
  private readonly snapshots: Snapshots;

  constructor(a: PlayerAssets, m: { song: DriverSong; orderStarts: number[]; sampleRate: number; once?: boolean }) {
    this.p = new Playback(a, m.song, { sampleRate: m.sampleRate });
    this.orderStarts = m.orderStarts;
    this.snapshots = m.once ? new Snapshots(m.song, m.sampleRate) : snapshotsFor(m.song, m.sampleRate);
  }

  row(p: { order: number; row: number }) {
    return this.orderStarts[p.order]! + p.row;
  }

  /** Runs until the next tick starts `row`. Returns false if stopped first. */
  async runTo(row: number): Promise<boolean> {
    const from = this.snapshots.before(row);
    if (from && from[0] > this.started) {
      this.p.restore(from[1]);
      this.started = from[0];
    }
    const p = this.p;
    const atRow = () => p.upcoming.tick === 0 && this.row(p.upcoming) === row;
    while (!atRow()) {
      const until = performance.now() + SLICE_MS;
      while (!atRow() && performance.now() < until) {
        if (p.upcoming.tick === 0 && this.started >= row + 1) throw new Error(`the song never reached row ${row}`);
        this.tick();
      }
      p.takeAudio(); // thrown away
      await yieldToEvents();
      if (this.stopped) return false;
    }
    return true;
  }

  /** Plays one tick, first saving a snapshot if this is the start of a row that gets one. Rows count as the first
   * pass while each plays in turn, so the timeline row is the number of rows started before it. */
  tick(): Tick {
    const up = this.p.upcoming;
    if (up.tick === 0) {
      const row = this.row(up);
      if (row === this.started && row % SNAPSHOT_ROWS === 0 && !this.snapshots.rows.has(row)) {
        this.snapshots.rows.set(row, this.p.snapshot());
      }
      this.started++;
    }
    return this.p.tick();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.p.delete();
  }
}

/** A loop, with its start row's state once found, and the Runner finding it. */
type Looping = Loop & { snapshot?: Snapshot; finder?: Runner };

class Session {
  private runner: Runner | undefined;
  private loop: Looping | undefined;
  private stopped = false;
  private produced = 0; // frames sent to the worklet
  private played = 0; // frames the worklet has output
  private last: PlayPosition | undefined; // the tick whose sound the next chunk holds
  private readonly left: DcFilter;
  private readonly right: DcFilter;
  private readonly m: Extract<ToWorker, { type: 'play' }>;

  constructor(m: Extract<ToWorker, { type: 'play' }>) {
    this.m = m;
    this.left = new DcFilter(m.sampleRate);
    this.right = new DcFilter(m.sampleRate);
  }

  get id() {
    return this.m.id;
  }

  async start() {
    const { m } = this;
    try {
      const began = performance.now();
      const a = await assets;
      if (this.stopped) return;
      const r = (this.runner = new Runner(a, m));
      if (!m.once) r.p.mute(muted);
      if (!m.once) this.setLoop(m.loop);
      if (!(await r.runTo(m.startRow))) return;
      // A tick's writes land at the end of the audio taken with it, so its sound is in the chunk after. Play the
      // start row's first tick here and keep only what follows.
      this.last = this.position(r.tick());
      r.p.takeAudio();
      post({ type: 'started', id: m.id, seekMs: Math.round(performance.now() - began) });
      this.fill();
    } catch (e) {
      post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
      this.stop();
    }
  }

  onPlayed(frames: number) {
    this.played = frames;
    this.fill();
  }

  /** Takes effect after the audio already queued, about AHEAD seconds on. */
  mute() {
    if (!this.m.once) this.runner?.p.mute(muted);
  }

  /** Loops from the next time the loop's last row ends, once its start row's state is found. */
  setLoop(loop: Loop | undefined) {
    if (loop && this.loop?.start === loop.start) {
      this.loop.end = loop.end; // the same start row, found or being found, as while dragging the loop's end
      return;
    }
    this.loop?.finder?.stop();
    const l: Looping | undefined = (this.loop = loop && { ...loop });
    if (!l || this.stopped) return;
    void (async () => {
      const a = await assets;
      if (this.loop !== l || this.stopped) return;
      const r = (l.finder = new Runner(a, this.m));
      try {
        if (await r.runTo(l.start)) l.snapshot = r.p.snapshot();
      } catch {
        // a row the song never reaches: it plays on without looping
      } finally {
        r.stop();
      }
    })();
  }

  stop() {
    this.stopped = true;
    this.runner?.stop();
    this.runner = undefined;
    this.loop?.finder?.stop();
  }

  private fill() {
    const r = this.runner;
    if (!r || !worklet || this.stopped || !this.last) return;
    while (this.produced - this.played < AHEAD * this.m.sampleRate) {
      let tick = r.tick();
      const audio = r.p.takeAudio();
      const l = this.loop;
      if (l?.snapshot && tick.tick === 0 && this.last.row === l.end - 1) {
        // The tick after the loop's last row: keep its audio, which holds the last row's last tick, and go back
        // to the start row and play its first tick as start() does.
        r.p.restore(l.snapshot);
        tick = r.tick();
        r.p.takeAudio();
      }
      const n = audio.length / 2;
      const left = new Float32Array(n);
      const right = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        left[i] = this.left.next(audio[i * 2]!);
        right[i] = this.right.next(audio[i * 2 + 1]!);
      }
      const chunk: Chunk = { type: 'chunk', id: this.m.id, left, right, position: this.last };
      worklet.postMessage(chunk, [left.buffer, right.buffer]);
      this.produced += n;
      this.last = this.position(tick);
    }
  }

  private position(t: Tick): PlayPosition {
    return { row: this.runner!.row(t), tick: t.tick, rowTicks: t.rowTicks };
  }
}

/** Makes snapshots of the prepared song's first pass in the background, while nothing's playing. */
async function prepare() {
  const m = prepared;
  if (!m || session || preparing) return;
  try {
    const a = await assets;
    if (prepared !== m || session || preparing) return;
    const r = (preparing = new Runner(a, m));
    const last = m.length - 1;
    const done = await r.runTo(last - (last % SNAPSHOT_ROWS));
    r.stop();
    if (done && prepared === m) prepared = undefined;
  } catch {
    prepared = undefined; // a song that can't play has no snapshots to make; playing it reports why
  } finally {
    if (preparing?.stopped) preparing = undefined;
  }
}

function stopPreparing() {
  preparing?.stop();
  preparing = undefined;
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'port') {
    worklet = m.port;
    worklet.onmessage = (e: MessageEvent<Played>) => {
      if (e.data.id === session?.id) session.onPlayed(e.data.frames);
    };
  } else if (m.type === 'prepare') {
    stopPreparing();
    prepared = m;
    void prepare();
  } else if (m.type === 'mute') {
    muted = m.muted;
    session?.mute();
  } else if (m.type === 'loop') {
    if (m.id === session?.id) session.setLoop(m.loop);
  } else if (m.type === 'play') {
    stopPreparing();
    session?.stop();
    flush(m.id);
    session = new Session(m);
    void session.start();
  } else {
    flush(m.id);
    session?.stop();
    session = undefined;
    void prepare(); // carry on where it left off: the snapshots made so far are kept
  }
};
