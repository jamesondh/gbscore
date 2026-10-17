import { assemble, type DriverSong } from '../core/driver.ts';
import { Emulator, EVENT_AUDIO_BUFFER_FULL, TICKS_PER_SECOND, type Wasm } from './emulator.ts';

// Plays compiled songs on driver/player.gbc: the pinned driver, called from a timer at the game's tick rate.

export interface PlayerAssets {
  wasm: Wasm;
  rom: Uint8Array; // driver/player.gbc
  symbols: string; // driver/player.sym
}

/** Where player.asm expects the song. */
export const SONG_ADDRESS = 0x1000;
export const SONG_SPACE = 0x7000;

const TIMA = 0xff05; // counts up once every 512 clocks, from $78 to $FF, then the tick starts
const TAC = 0xff07;
const TAC_START = 0x04;

/** The timer runs at 8192 Hz in double speed and overflows every 256 − $78 = 136 counts. */
export const TICK_LENGTH = (TICKS_PER_SECOND * 136) / 8192;
export const TICK_RATE = TICKS_PER_SECOND / TICK_LENGTH; // 60.24 Hz

export interface Position {
  order: number;
  row: number; // within the order's pattern
  tick: number; // within the row
}

export interface Tick extends Position {
  /** Sound-register writes the driver made on this tick, as [address, value]. */
  writes: [number, number][];
  /** The wave loaded into wave RAM after this tick (100 = none yet), since wave RAM writes aren't logged. */
  wave: number;
  /** The ticks this row lasts, as the driver has it after this tick: its groove step, or the tempo set on it. */
  rowTicks: number;
  /** Seconds from power-on to the end of the tick, within a few hundred clocks. */
  time: number;
}

/** The player's state between two ticks, for starting again from there: see Playback.restore(). */
export interface Snapshot {
  state: Uint8Array;
  ticks: number;
}

export function parseSymbols(text: string): Map<string, number> {
  const symbols = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{2}):([0-9a-f]{4}) (\S+)$/i.exec(line.trim());
    if (m) symbols.set(m[3]!, parseInt(m[2]!, 16));
  }
  return symbols;
}

export class Playback {
  readonly sampleRate: number;
  /** Writes made while the player started up, before the first tick. */
  readonly startWrites: [number, number][];
  private readonly emu: Emulator;
  private readonly at: (name: string) => number;
  private ticks = 0;
  private lastTick = 0; // the clock when the last tick finished
  private next: Position;
  private chunks: Uint8Array[] = [];
  private taken = 0; // frames of the emulator's current audio buffer already copied into chunks

  constructor(assets: PlayerAssets, song: DriverSong, options: { sampleRate?: number } = {}) {
    const bytes = assemble(song, SONG_ADDRESS);
    if (bytes.length > SONG_SPACE) throw new Error(`the song is ${bytes.length} bytes; the player has room for ${SONG_SPACE}`);
    const rom = assets.rom.slice();
    rom.set(bytes, SONG_ADDRESS);
    const symbols = parseSymbols(assets.symbols);
    this.at = (name) => {
      const addr = symbols.get(name);
      if (addr === undefined) throw new Error(`player.sym has no ${name}`);
      return addr;
    };
    this.sampleRate = options.sampleRate ?? 44100;
    this.emu = new Emulator(assets.wasm, rom, this.sampleRate, 4096);
    // The player turns the screen off, loads the song and then starts the timer, whose first tick comes a whole
    // period later. Its writes until then are the start-up's.
    while (!(this.emu.read(TAC) & TAC_START)) {
      if (this.emu.ticks > TICKS_PER_SECOND) throw new Error("the player ROM didn't start its timer");
      this.run(this.emu.ticks + 256);
    }
    this.startWrites = this.emu.takeApuLog();
    this.next = this.position();
  }

  /** Where the next tick will play. */
  get upcoming(): Position {
    return this.next;
  }

  /** Runs the driver for one tick and returns what it played. */
  tick(): Tick {
    const played = this.next;
    const counter = this.at('wTicks');
    const want = (this.ticks + 1) & 0xff;
    // Ticks start exactly TICK_LENGTH apart, so skip ahead by most of that, then step until this one has ended.
    // lastTick is when the last tick ended, after it ran for some time d, so the skip lands d − 4,096 clocks
    // from this tick's start: before it, or inside it when d is longer, but never past its end.
    if (this.ticks > 0) this.run(this.lastTick + TICK_LENGTH - 4096);
    while (this.emu.read(counter) !== want) this.run(this.emu.ticks + 256);
    this.lastTick = this.emu.ticks;
    this.ticks++;
    this.next = this.position();
    return {
      ...played,
      writes: this.emu.takeApuLog(),
      wave: this.emu.read(this.at('current_wave')),
      rowTicks: this.emu.read(this.at('ticks_per_row') + (played.row & 3)), // the driver's own lookup
      time: this.lastTick / TICKS_PER_SECOND,
    };
  }

  /** Leaves the channels marked true (pulse 1, pulse 2, wave, noise) out of the audio from now on. They still play,
   * so the writes, and what unmuting brings back, are the same. Stays across restore(). */
  mute(muted: readonly boolean[]): void {
    muted.forEach((m, channel) => this.emu.mute(channel, m));
  }

  /** The state now, between ticks. Only good for a Playback of the same song at the same sample rate. */
  snapshot(): Snapshot {
    return { state: this.emu.saveState(), ticks: this.ticks };
  }

  /** Goes back, or forward, to a snapshot's state. */
  restore(s: Snapshot): void {
    this.emu.loadState(s.state);
    this.ticks = s.ticks;
    this.lastTick = this.emu.ticks;
    this.emu.takeApuLog();
    // A run that stops at once lets binjgb restart its audio buffer if the state says it was full; then skip
    // whatever the buffer holds.
    this.emu.runUntil(this.emu.ticks);
    this.chunks = [];
    this.taken = this.emu.audio().length / 2;
    this.next = this.position();
  }

  /** Runs on until just before the next tick, so the audio covers the whole of the last one: until the timer's
   * last count before it overflows, at most 512 clocks before the tick starts. Returns any sound-register writes
   * made meanwhile, which should be none. */
  finish(): [number, number][] {
    while (this.emu.read(TIMA) !== 0xff) this.run(this.emu.ticks + 256);
    return this.emu.takeApuLog();
  }

  /** The audio made since the last call, as unsigned 8-bit stereo samples, interleaved. */
  takeAudio(): Uint8Array {
    this.copyAudio(false);
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    return out;
  }

  delete(): void {
    this.emu.delete();
  }

  private position(): Position {
    return {
      order: this.emu.read(this.at('current_order')) >> 1, // the driver keeps it doubled, as an offset into words
      row: this.emu.read(this.at('row')),
      tick: this.emu.read(this.at('tick')),
    };
  }

  /** binjgb stops early when its audio buffer fills, and starts the buffer again on the next run. */
  private run(until: number) {
    while (this.emu.ticks < until) {
      if (this.emu.runUntil(until) & EVENT_AUDIO_BUFFER_FULL) this.copyAudio(true);
    }
  }

  private copyAudio(full: boolean) {
    const audio = this.emu.audio();
    if (audio.length > this.taken * 2) this.chunks.push(audio.slice(this.taken * 2));
    this.taken = full ? 0 : audio.length / 2;
  }
}
