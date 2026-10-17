/* The part of binjgb's API that gbscore uses, exported from one WebAssembly module (see build.sh). */
#include <stdlib.h>
#include <string.h>

#include "emulator.h"

u8 emulator_read_mem(Emulator*, u16 addr); /* defined in emulator.c, not declared in its header */
void emulator_write_mem(Emulator*, u16 addr, u8 value);

#define EXPORT(name) __attribute__((export_name(#name)))

static EmulatorInit s_init;
static EmulatorConfig s_config;

EXPORT(alloc) void* alloc(size_t size) { return malloc(size); }

/* Takes ownership of `rom`, which must come from alloc(). Logs every write to the sound registers. */
EXPORT(emu_new) Emulator* emu_new(void* rom, size_t rom_size, int audio_frequency, int audio_frames) {
  s_init.rom.data = rom;
  s_init.rom.size = rom_size;
  s_init.audio_frequency = audio_frequency;
  s_init.audio_frames = audio_frames;
  s_init.random_seed = 0xcabba6e5;
  Emulator* e = emulator_new(&s_init);
  if (e) {
    s_config.log_apu_writes = TRUE;
    emulator_set_config(e, &s_config);
  }
  return e;
}

EXPORT(emu_delete) void emu_delete(Emulator* e) { emulator_delete(e); }
EXPORT(emu_ticks) double emu_ticks(Emulator* e) { return (double)emulator_get_ticks(e); }
EXPORT(emu_run_until) u32 emu_run_until(Emulator* e, double ticks) { return emulator_run_until(e, (Ticks)ticks); }
EXPORT(emu_read) u32 emu_read(Emulator* e, u32 addr) { return emulator_read_mem(e, addr); }
EXPORT(emu_write) void emu_write(Emulator* e, u32 addr, u32 value) { emulator_write_mem(e, addr, value); }

/* Leaves a channel (0 to 3) out of the audio, or puts it back. It still runs, and its writes are still logged; it
 * isn't part of a saved state. */
EXPORT(emu_mute) void emu_mute(Emulator* e, u32 channel, u32 muted) {
  EmulatorConfig config = emulator_get_config(e);
  config.disable_sound[channel] = muted ? TRUE : FALSE;
  emulator_set_config(e, &config);
}

/* Unsigned 8-bit stereo frames, interleaved, since the last run that filled the buffer. */
EXPORT(emu_audio) u8* emu_audio(Emulator* e) { return emulator_get_audio_buffer(e)->data; }
EXPORT(emu_audio_frames) u32 emu_audio_frames(Emulator* e) {
  return audio_buffer_get_frames(emulator_get_audio_buffer(e));
}

/* {addr, value} byte pairs, addr relative to $FF00. Holds up to MAX_APU_LOG_FRAME_WRITES. */
EXPORT(emu_apu_log) ApuWrite* emu_apu_log(Emulator* e) { return emulator_get_apu_log(e)->writes; }
EXPORT(emu_apu_log_count) u32 emu_apu_log_count(Emulator* e) { return emulator_get_apu_log(e)->write_count; }
EXPORT(emu_apu_log_reset) void emu_apu_log_reset(Emulator* e) { emulator_reset_apu_log(e); }

/* Save states, so a song can start from a row without playing up to it. One buffer, emu_state(), holds a state
 * of emu_state_size() bytes: emu_save_state() fills it from the emulator, emu_load_state() loads it into one. A
 * state is binjgb's, plus the resampler's phase, which binjgb keeps in the audio buffer; without it, audio after
 * a load differs slightly from the first time. The buffer's samples and the APU log aren't part of a state. */
typedef struct {
  u32 freq_counter;
  u32 divisor;
} Resampler;
static FileData s_state;
static u8* s_buffer;
static size_t s_size;
EXPORT(emu_state) u8* emu_state(void) {
  if (!s_buffer) {
    emulator_init_state_file_data(&s_state); /* binjgb's own part, at the start of the buffer */
    s_size = s_state.size + sizeof(Resampler);
    s_buffer = realloc(s_state.data, s_size);
    s_state.data = s_buffer;
  }
  return s_buffer;
}
EXPORT(emu_state_size) u32 emu_state_size(void) { return emu_state() ? s_size : 0; }
EXPORT(emu_save_state) u32 emu_save_state(Emulator* e) {
  if (!emu_state() || !SUCCESS(emulator_write_state(e, &s_state))) return 0;
  AudioBuffer* ab = emulator_get_audio_buffer(e);
  Resampler r = {ab->freq_counter, ab->divisor};
  memcpy(s_buffer + s_state.size, &r, sizeof r);
  return 1;
}
EXPORT(emu_load_state) u32 emu_load_state(Emulator* e) {
  if (!emu_state() || !SUCCESS(emulator_read_state(e, &s_state))) return 0;
  AudioBuffer* ab = emulator_get_audio_buffer(e);
  Resampler r;
  memcpy(&r, s_buffer + s_state.size, sizeof r);
  ab->freq_counter = r.freq_counter;
  ab->divisor = r.divisor;
  return 1;
}
