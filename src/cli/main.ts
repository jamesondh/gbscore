import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { BANK_SIZE, compile, parseSong } from '../core/compile.ts';
import { cName, exportGbdk } from '../core/export.ts';
import { formatSong } from '../core/format.ts';
import { ImportError, importUge } from '../core/import.ts';
import { formatError, formatErrors } from '../core/location.ts';
import type { Song } from '../core/schema.ts';
import { parseBars, showNotes, showPatterns, showRows, summary } from '../core/show.ts';
import { UgeError } from '../core/uge.ts';
import { MAX_SECONDS, render, RenderTooLong, type Rendering } from '../play/render.ts';
import { encodeWav } from '../play/wav.ts';
import { loadAssets } from './assets.ts';

const USAGE = `usage:
  gbscore check <song.gbscore.json>... [--budget N]  validate and compile; errors give bar.beat.row and lane
                                                (--budget: fail if the song is over N bytes)
  gbscore render <song> -o <out.wav> [--loops N | --seconds N]
                                                play on the emulator and write a WAV (default: once through)
  gbscore show <song> [--bars 9-16] [--rows | --patterns]
                                                notes by bar and beat as they play, the compiled tracker
                                                rows, or each pattern and where it's placed
  gbscore fmt <song>... [--check]                rewrite in canonical form (--check: only report)
  gbscore import <file.uge> [-o <song>] [--force] [--patterns]
                                                import a hUGETracker V6/V7 song (--patterns: keep its
                                                patterns as patterns, instead of writing the notes out)
  gbscore export <song> --gbdk <out.c> [--bank N] [--name NAME] [--check]
                                                write GBDK C for the game (--check: only report if stale)`;

class Fail extends Error {}

function load(path: string): Song {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Fail(`${path}: can't read the file`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Fail(`${path}: not valid JSON: ${(e as Error).message}`);
  }
  const parsed = parseSong(json);
  if (parsed.errors) {
    const grid = (json as { grid?: { rowsPerBeat?: unknown; beatsPerBar?: unknown } }).grid;
    const usable =
      grid && typeof grid.rowsPerBeat === 'number' && typeof grid.beatsPerBar === 'number' && grid.rowsPerBeat > 0 && grid.beatsPerBar > 0
        ? { rowsPerBeat: grid.rowsPerBeat, beatsPerBar: grid.beatsPerBar }
        : undefined;
    throw new Fail(parsed.errors.map((e) => `${path}: ${formatError(usable, e)}`).join('\n'));
  }
  return parsed.song;
}

function check(paths: string[], budget?: number): number {
  let failed = 0;
  for (const path of paths) {
    try {
      const song = load(path);
      const result = compile(song, { budget });
      if (!result.ok) {
        failed++;
        for (const line of formatErrors(song.grid, result.errors)) console.error(`${path}: ${line}`);
      } else {
        const note = result.size > BANK_SIZE ? ` (over one ${BANK_SIZE}-byte bank)` : '';
        console.log(`${path}: ok, ${result.size} bytes${note}`);
      }
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      failed++;
      console.error(e.message);
    }
  }
  return failed ? 1 : 0;
}

async function renderCommand(path: string, output: string, options: { loops?: number; seconds?: number }) {
  const song = load(path);
  const compiled = compile(song);
  if (!compiled.ok) {
    throw new Fail(formatErrors(song.grid, compiled.errors).map((line) => `${path}: ${line}`).join('\n'));
  }
  let result: Rendering;
  try {
    result = render(await loadAssets(), compiled.data, song, options);
  } catch (e) {
    if (e instanceof RenderTooLong) throw new Fail(`${path}: ${e.message}`);
    throw e;
  }
  writeFileSync(output, encodeWav(result.audio, result.sampleRate));
  const secs = result.audio.length / 2 / result.sampleRate;
  console.log(`${output}: ${secs.toFixed(1)} s, ${result.ticks.length} ticks at 60.24 Hz`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      bars: { type: 'string' },
      rows: { type: 'boolean' },
      patterns: { type: 'boolean' },
      check: { type: 'boolean' },
      output: { type: 'string', short: 'o' },
      force: { type: 'boolean' },
      loops: { type: 'string' },
      seconds: { type: 'string' },
      gbdk: { type: 'string' },
      bank: { type: 'string' },
      budget: { type: 'string' },
      name: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }
  const usage = (msg: string) => {
    console.error(`${msg}\n${USAGE}`);
    return 2;
  };

  switch (command) {
    case 'check': {
      if (!positionals.length) return usage('check needs a song');
      const budget = values.budget === undefined ? undefined : Number(values.budget);
      if (budget !== undefined && !(budget > 0)) return usage('--budget needs a number of bytes');
      return check(positionals, budget);
    }

    case 'render': {
      if (positionals.length !== 1) return usage('render takes one song');
      if (!values.output) return usage('render needs -o <out.wav>');
      if (values.loops !== undefined && values.seconds !== undefined) return usage('give --loops or --seconds, not both');
      const loops = values.loops === undefined ? undefined : Number(values.loops);
      const seconds = values.seconds === undefined ? undefined : Number(values.seconds);
      if (loops !== undefined && !(Number.isInteger(loops) && loops > 0)) return usage('--loops needs a whole number from 1');
      if (seconds !== undefined && !(seconds > 0 && seconds <= MAX_SECONDS)) {
        return usage(`--seconds needs a number above 0, up to ${MAX_SECONDS}`);
      }
      await renderCommand(positionals[0]!, values.output, { loops, seconds });
      return 0;
    }

    case 'show': {
      if (positionals.length !== 1) return usage('show takes one song');
      const song = load(positionals[0]!);
      const bars = values.bars ? parseBars(values.bars) : undefined;
      if (typeof bars === 'string') return usage(bars);
      const compiled = compile(song);
      console.log(summary(song, compiled));
      if (!compiled.ok) console.log(`doesn't compile (${compiled.errors.length} errors); run gbscore check`);
      if (values.rows && values.patterns) return usage('give --rows or --patterns, not both');
      console.log(values.rows ? showRows(song, compiled, bars) : values.patterns ? showPatterns(song) : showNotes(song, bars));
      return 0;
    }

    case 'fmt': {
      if (!positionals.length) return usage('fmt needs a song');
      let changed = 0;
      for (const path of positionals) {
        const text = formatSong(load(path));
        if (text === readFileSync(path, 'utf8')) continue;
        changed++;
        if (values.check) console.error(`${path}: not in canonical form; run gbscore fmt`);
        else {
          writeFileSync(path, text);
          console.log(`${path}: formatted`);
        }
      }
      return values.check && changed ? 1 : 0;
    }

    case 'import': {
      if (positionals.length !== 1) return usage('import takes one .uge file');
      const input = positionals[0]!;
      const output = values.output ?? input.replace(/\.uge$/i, '') + '.gbscore.json';
      if (existsSync(output) && !values.force) {
        throw new Fail(`${output} already exists; pass --force to replace it`);
      }
      let song: Song;
      try {
        song = importUge(readFileSync(input), { patterns: values.patterns }).song;
      } catch (e) {
        if (e instanceof ImportError) throw new Fail(e.problems.map((p) => `${input}: ${p}`).join('\n'));
        if (e instanceof UgeError) throw new Fail(`${input}: ${e.message}`);
        throw e;
      }
      writeFileSync(output, formatSong(song));
      const compiled = compile(song);
      console.log(`${output}: ${summary(song, compiled)}`);
      if (!compiled.ok) {
        console.error(`${output}: imported, but fix these before it plays:`);
        for (const line of formatErrors(song.grid, compiled.errors)) console.error(`${output}: ${line}`);
        return 1;
      }
      return 0;
    }

    case 'export': {
      if (positionals.length !== 1) return usage('export takes one song');
      const path = positionals[0]!;
      if (!values.gbdk) return usage('export needs --gbdk <out.c>');
      const bank = values.bank === undefined ? 255 : Number(values.bank);
      if (!(Number.isInteger(bank) && bank >= 1 && bank <= 255)) return usage('--bank needs a ROM bank from 1 to 255');
      const name = values.name ?? cName(path);
      if (typeof name !== 'string') return usage(name.error);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return usage(`--name ${name} isn't a C name`);
      const song = load(path);
      const compiled = compile(song);
      if (!compiled.ok) {
        throw new Fail(formatErrors(song.grid, compiled.errors).map((line) => `${path}: ${line}`).join('\n'));
      }
      const text = exportGbdk(compiled.data, { name, bank, source: basename(path) });
      const current = existsSync(values.gbdk) ? readFileSync(values.gbdk, 'utf8') : undefined;
      if (values.check) {
        if (current === text) return 0;
        console.error(`${values.gbdk}: ${current === undefined ? 'missing' : 'out of date'}; run gbscore export ${path} --gbdk ${values.gbdk}`);
        return 1;
      }
      if (current !== text) writeFileSync(values.gbdk, text);
      console.log(`${values.gbdk}: ${name}, bank ${bank === 255 ? 'chosen by bankpack' : bank}, ${compiled.size} bytes`);
      return 0;
    }

    default:
      return usage(`unknown command ${command}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Fail)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
