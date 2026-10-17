import type { DriverSong } from '../../core/driver.ts';
import type { FromWorker, FromWorklet, Loop, PlayPosition, ToWorker } from './protocol.ts';
import workletUrl from './worklet.ts?worker&url';

export type EngineEvent =
  | { type: 'started'; seekMs: number }
  | { type: 'error'; message: string }
  | { type: 'underrun'; count: number };

/** Plays compiled songs through the emulator worker and the output worklet. */
export class Engine {
  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private ready: Promise<void> | undefined;
  private id = 0;
  private playing = false;
  private looping: Loop | undefined;
  private hearing: { id: number; ms: number } | undefined; // a note being heard, and how long it sounds
  private positions: { time: number; position: PlayPosition }[] = [];
  private readonly onEvent: (e: EngineEvent) => void;

  constructor(onEvent: (e: EngineEvent) => void) {
    this.onEvent = onEvent;
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.id !== this.id) return;
      if (m.type === 'error') this.playing = false;
      const h = this.hearing;
      if (h?.id !== m.id || m.type === 'error') this.onEvent(m);
      else {
        // Stop once the note has sounded, before the song loops; the output's latency comes on top.
        const latency = (this.ctx!.baseLatency + (this.ctx!.outputLatency || 0)) * 1000;
        setTimeout(() => this.id === h.id && this.stop(), h.ms + latency + 100);
      }
    };
  }

  /** Tells the worker which song will play next, so it can get ready to start it from any row. */
  prepare(song: DriverSong, orderStarts: number[], length: number) {
    const ctx = this.context(); // stays suspended until play(); this is only for its sample rate
    this.toWorker({ type: 'prepare', song, orderStarts, length, sampleRate: ctx.sampleRate });
  }

  /** Call from a click or key press: browsers only start audio in response to one. */
  play(song: DriverSong, orderStarts: number[], startRow: number) {
    this.start(song, orderStarts, startRow, false);
  }

  /** Loops songs played over these rows, or not, now and from now on, but not notes heard. */
  loop(loop: Loop | undefined) {
    this.looping = loop;
    if (this.playing) this.toWorker({ type: 'loop', id: this.id, loop });
  }

  /** Plays a short song from its start for `ms`, as when hearing a note being entered. It isn't reported as
   * playing, and stops what was. */
  hear(song: DriverSong, orderStarts: number[], ms: number) {
    this.hearing = { id: this.start(song, orderStarts, 0, true), ms };
  }

  /** Stops a note being heard, at once, but not a song playing. */
  release() {
    if (this.hearing) this.stop();
  }

  private start(song: DriverSong, orderStarts: number[], startRow: number, once: boolean): number {
    void this.context().resume();
    const id = ++this.id;
    this.playing = !once;
    this.hearing = undefined;
    this.positions = [];
    this.setUp().then(
      () => {
        if (id === this.id) {
          // The loop as it is now: a change since play() went to no play at all.
          const loop = once ? undefined : this.looping;
          const sampleRate = this.ctx!.sampleRate;
          this.toWorker({ type: 'play', id, song, orderStarts, startRow, sampleRate, loop, once });
        }
      },
      (e: unknown) => {
        this.ready = undefined;
        if (id !== this.id) return;
        this.playing = false;
        this.onEvent({ type: 'error', message: `audio didn't start: ${e instanceof Error ? e.message : e}` });
      },
    );
    return id;
  }

  /** Leaves out the channels marked true (pulse 1, pulse 2, wave, noise) from songs played, now and from now on,
   * but not from notes heard. */
  mute(muted: boolean[]) {
    this.toWorker({ type: 'mute', muted });
  }

  stop() {
    const id = ++this.id;
    this.playing = false;
    this.hearing = undefined;
    this.positions = [];
    this.toWorker({ type: 'stop', id }); // the worker tells the worklet to drop what's queued
  }

  /** What the speakers are playing now, if anything. */
  now(): PlayPosition | undefined {
    if (!this.playing || !this.ctx) return undefined;
    const { contextTime } = this.ctx.getOutputTimestamp();
    const t = contextTime || this.ctx.currentTime - this.ctx.outputLatency;
    const p = this.positions;
    let i = 0;
    while (i + 1 < p.length && p[i + 1]!.time <= t) i++;
    p.splice(0, i);
    return p[0] && p[0].time <= t ? p[0].position : undefined;
  }

  private context(): AudioContext {
    return (this.ctx ??= new AudioContext({ latencyHint: 'interactive' }));
  }

  private setUp(): Promise<void> {
    return (this.ready ??= (async () => {
      const ctx = this.ctx!;
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'gbscore-output', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(ctx.destination);
      node.port.onmessage = (e: MessageEvent<FromWorklet>) => {
        const m = e.data;
        if (m.id !== this.id) return;
        if (m.type === 'position') {
          this.positions.push({ time: m.time, position: m.position });
          if (this.positions.length > 600) this.positions.shift(); // when nothing is drawing, as in a hidden tab
        } else if (this.hearing?.id !== m.id) this.onEvent(m);
      };
      const channel = new MessageChannel();
      this.toWorker({ type: 'port', port: channel.port1 }, [channel.port1]);
      node.port.postMessage({ type: 'port', port: channel.port2 }, [channel.port2]);
      this.node = node;
    })());
  }

  private toWorker(m: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }
}
