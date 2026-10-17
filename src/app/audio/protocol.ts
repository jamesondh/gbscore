import type { DriverSong } from '../../core/driver.ts';

// Messages between the app, the emulator worker and the output worklet. Each play has a number, `id`, counting up;
// Stop takes a number too, so anything from an older play can be recognised and dropped. The worker sends the
// worklet both the audio and the flushes, on one port, so a flush can't overtake the audio it belongs before.

/** A place in the song as heard: the timeline row, the tick within it, and how many ticks the row lasts. */
export interface PlayPosition {
  row: number;
  tick: number;
  rowTicks: number;
}

/** Timeline rows the editor plays over and over, from `start` up to `end`. Not the song's own loop point. */
export interface Loop {
  start: number;
  end: number;
}

/** A song the app expects to play, so the worker can make its snapshots in advance. */
export interface Prepare {
  type: 'prepare';
  song: DriverSong;
  orderStarts: number[];
  length: number;
  sampleRate: number;
}

export type ToWorker =
  | { type: 'port'; port: MessagePort } // to the worklet
  | Prepare
  | {
      type: 'play';
      id: number;
      song: DriverSong;
      orderStarts: number[];
      startRow: number;
      sampleRate: number;
      loop?: Loop;
      once?: boolean; // a note being entered: no snapshots, so the song's own aren't replaced
    }
  | { type: 'stop'; id: number }
  | { type: 'loop'; id: number; loop: Loop | undefined } // for the play `id`, from now on
  | { type: 'mute'; muted: boolean[] }; // channels left out of what plays, now and from now on

export type FromWorker =
  | { type: 'started'; id: number; seekMs: number } // the song reached the start row and audio is flowing
  | { type: 'error'; id: number; message: string };

/** From the worker to the worklet: drop everything queued from plays before `id`. */
export interface Flush {
  type: 'flush';
  id: number;
}

/** From the worker to the worklet: one tick of audio. */
export interface Chunk {
  type: 'chunk';
  id: number;
  left: Float32Array;
  right: Float32Array;
  position: PlayPosition;
}

/** From the worklet to the worker: frames of this play the worklet has output so far. */
export interface Played {
  id: number;
  frames: number;
}

export type FromWorklet =
  | { type: 'position'; id: number; position: PlayPosition; time: number } // time in the AudioContext's clock
  | { type: 'underrun'; id: number; count: number };
