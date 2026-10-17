// binjgb, built to WebAssembly by emu/build.sh, behind the few calls the player needs. It takes the module's
// bytes rather than loading them, so the browser and Node share it.

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  alloc(size: number): number;
  emu_new(rom: number, romSize: number, frequency: number, frames: number): number;
  emu_delete(e: number): void;
  emu_ticks(e: number): number;
  emu_run_until(e: number, ticks: number): number;
  emu_read(e: number, addr: number): number;
  emu_write(e: number, addr: number, value: number): void;
  emu_mute(e: number, channel: number, muted: number): void;
  emu_audio(e: number): number;
  emu_audio_frames(e: number): number;
  emu_apu_log(e: number): number;
  emu_apu_log_count(e: number): number;
  emu_apu_log_reset(e: number): void;
  emu_state(): number;
  emu_state_size(): number;
  emu_save_state(e: number): number;
  emu_load_state(e: number): number;
}

/** Ticks of the emulator's clock per second. In double speed the CPU runs two cycles per tick. */
export const TICKS_PER_SECOND = 4194304;

export const EVENT_AUDIO_BUFFER_FULL = 0x2;

/** The module imports WASI's stdio and exit, which binjgb uses only for messages and failed asserts. Messages are
 * dropped, but fd_write has to report them written, or the C library retries forever. */
function wasiStubs(module: WebAssembly.Module, memory: () => WebAssembly.Memory): WebAssembly.Imports {
  const imports: Record<string, Record<string, (...args: number[]) => number>> = {};
  for (const i of WebAssembly.Module.imports(module)) {
    let f: (...args: number[]) => number = () => 0;
    if (i.name === 'fd_write') {
      f = (_fd, iovs, count, written) => {
        const view = new DataView(memory().buffer);
        let n = 0;
        for (let k = 0; k < count!; k++) n += view.getUint32(iovs! + k * 8 + 4, true);
        view.setUint32(written!, n, true);
        return 0;
      };
    } else if (i.name === 'proc_exit') {
      f = () => {
        throw new Error('the emulator exited');
      };
    }
    (imports[i.module] ??= {})[i.name] = f;
  }
  return imports;
}

export class Wasm {
  readonly exports: Exports;

  private constructor(exports: Exports) {
    this.exports = exports;
  }

  static async load(bytes: BufferSource): Promise<Wasm> {
    const module = await WebAssembly.compile(bytes);
    let exports: Exports | undefined;
    const instance = await WebAssembly.instantiate(module, wasiStubs(module, () => exports!.memory));
    exports = instance.exports as unknown as Exports;
    exports._initialize();
    return new Wasm(exports);
  }
}

export class Emulator {
  private readonly x: Exports;
  private readonly e: number;

  constructor(wasm: Wasm, rom: Uint8Array, sampleRate: number, audioFrames: number) {
    this.x = wasm.exports;
    const ptr = this.x.alloc(rom.length);
    new Uint8Array(this.x.memory.buffer, ptr, rom.length).set(rom);
    this.e = this.x.emu_new(ptr, rom.length, sampleRate, audioFrames); // takes ownership of the ROM
    if (!this.e) throw new Error("the emulator couldn't load the ROM");
  }

  get ticks(): number {
    return this.x.emu_ticks(this.e);
  }

  runUntil(ticks: number): number {
    return this.x.emu_run_until(this.e, ticks);
  }

  read(addr: number): number {
    return this.x.emu_read(this.e, addr);
  }

  /** Leaves a channel (0 to 3: pulse 1, pulse 2, wave, noise) out of the audio, or puts it back. It still runs and
   * its writes are still logged. Not part of a saved state. */
  mute(channel: number, muted: boolean): void {
    this.x.emu_mute(this.e, channel, muted ? 1 : 0);
  }

  /** Unsigned 8-bit stereo samples, interleaved, made since the buffer last filled. */
  audio(): Uint8Array {
    const frames = this.x.emu_audio_frames(this.e);
    return new Uint8Array(this.x.memory.buffer, this.x.emu_audio(this.e), frames * 2);
  }

  /** Sound-register writes since the last call, as [address, value] pairs. */
  takeApuLog(): [number, number][] {
    const n = this.x.emu_apu_log_count(this.e);
    const bytes = new Uint8Array(this.x.memory.buffer, this.x.emu_apu_log(this.e), n * 2);
    const writes: [number, number][] = [];
    for (let i = 0; i < n; i++) writes.push([0xff10 + bytes[i * 2]!, bytes[i * 2 + 1]!]); // binjgb counts from NR10
    this.x.emu_apu_log_reset(this.e);
    return writes;
  }

  /** The emulator's whole state, which loadState() puts back. Not the audio buffer or the APU log. */
  saveState(): Uint8Array {
    if (!this.x.emu_save_state(this.e)) throw new Error("the emulator couldn't save its state");
    return new Uint8Array(this.x.memory.buffer, this.x.emu_state(), this.x.emu_state_size()).slice();
  }

  loadState(state: Uint8Array): void {
    const at = this.x.emu_state(); // before taking memory.buffer, since this can grow memory the first time
    new Uint8Array(this.x.memory.buffer, at, state.length).set(state);
    if (!this.x.emu_load_state(this.e)) throw new Error("the emulator couldn't load a saved state");
  }

  delete(): void {
    this.x.emu_delete(this.e);
  }
}
