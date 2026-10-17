import type { Chunk, Flush, FromWorklet, Played } from './protocol.ts';

// Plays the worker's chunks in order. It reports to the app when each chunk starts, so the playhead can follow what
// the speakers play, and to the worker how much it has played, so the worker knows when to send more.

// The AudioWorkletGlobalScope, which TypeScript's DOM types don't cover.
declare const currentTime: number;
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const REPORT_EVERY = 1024; // frames between reports to the worker, about 20 ms

class Output extends AudioWorkletProcessor {
  private worker: MessagePort | undefined;
  private queue: Chunk[] = [];
  private at = 0; // frames into queue[0]
  private oldest = 0; // chunks from plays before this are dropped
  private id = -1; // the play being output
  private played = 0;
  private unreported = 0;
  private underruns = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: 'port'; port: MessagePort }>) => {
      this.worker = e.data.port;
      this.worker.onmessage = (e: MessageEvent<Chunk | Flush>) => {
        const m = e.data;
        if (m.type === 'chunk') this.add(m);
        else {
          this.oldest = m.id;
          this.reset(-1);
        }
      };
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const [left, right] = outputs[0]!;
    if (!left || !right) return true;
    let i = 0;
    while (i < left.length && this.queue.length) {
      const c = this.queue[0]!;
      if (this.at === 0) this.send({ type: 'position', id: c.id, position: c.position, time: currentTime + i / sampleRate });
      const n = Math.min(left.length - i, c.left.length - this.at);
      left.set(c.left.subarray(this.at, this.at + n), i);
      right.set(c.right.subarray(this.at, this.at + n), i);
      i += n;
      this.at += n;
      if (this.at === c.left.length) {
        this.queue.shift();
        this.at = 0;
      }
    }
    left.fill(0, i);
    right.fill(0, i);
    if (this.id < 0) return true;
    if (i < left.length) this.send({ type: 'underrun', id: this.id, count: ++this.underruns });
    this.played += i;
    this.unreported += i;
    if (this.unreported >= REPORT_EVERY) {
      this.unreported = 0;
      const played: Played = { id: this.id, frames: this.played };
      this.worker?.postMessage(played);
    }
    return true;
  }

  private add(c: Chunk) {
    if (c.id < this.oldest || c.id < this.id) return;
    if (c.id > this.id) this.reset(c.id); // a new play
    this.queue.push(c);
  }

  private reset(id: number) {
    this.id = id;
    this.queue = [];
    this.at = 0;
    this.played = 0;
    this.unreported = 0;
    this.underruns = 0;
  }

  private send(m: FromWorklet) {
    this.port.postMessage(m);
  }
}

registerProcessor('gbscore-output', Output);
