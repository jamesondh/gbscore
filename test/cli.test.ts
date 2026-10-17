import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = new URL('../src/cli/main.ts', import.meta.url).pathname;
const run = (...args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

describe('gbscore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbscore-'));
  const song = join(dir, 'halt_bug.gbscore.json');

  it('imports, checks, formats and shows a song', () => {
    execFileSync('node', [cli, 'import', new URL('./fixtures/halt_bug.uge', import.meta.url).pathname, '-o', song]);
    expect(run('check', song).stdout).toContain('ok, 11649 bytes');
    expect(run('check', '--budget', '100', song).status).toBe(1);
    expect(run('check', '--budget', '100', song).stderr).toContain('over the 100-byte budget');
    expect(run('fmt', '--check', song).status).toBe(0);
    expect(run('show', song, '--bars', '1').stdout).toContain('wave    1.1 D4 i3 5  2.2 A4 i3 5');
    expect(run('show', song, '--bars', '1', '--rows').stdout).toContain('15  1.4.4     0:15       A5  01 ...  E6  02 ...  --- .. ...  --- .. E00');
    expect(run('import', new URL('./fixtures/halt_bug.uge', import.meta.url).pathname, '-o', song).stderr).toContain(
      'already exists; pass --force',
    );
  });

  it('exports GBDK C, and says when it is out of date', () => {
    const c = join(dir, 'halt_bug.c');
    expect(run('export', song, '--gbdk', c, '--check').status).toBe(1);
    expect(run('export', song, '--gbdk', c, '--bank', '2').stdout).toContain('halt_bug_uge, bank 2, 11649 bytes');
    expect(readFileSync(c, 'utf8')).toContain('const hUGESong_t halt_bug_uge = {6, 6, 6, 6, 26,');
    expect(run('export', song, '--gbdk', c, '--bank', '2', '--check').status).toBe(0);
    expect(run('export', song, '--gbdk', c, '--check').stderr).toContain('out of date');
  });

  it('renders a song to a WAV file', () => {
    const wav = join(dir, 'halt_bug.wav');
    const r = run('render', song, '-o', wav, '--seconds', '1');
    expect(r.stdout).toContain('halt_bug.wav: 1.0 s, 60 ticks at 60.24 Hz');
    expect(readFileSync(wav).subarray(0, 4).toString()).toBe('RIFF');
    expect(run('render', song, '-o', wav, '--loops', '0').status).toBe(2);
    expect(run('render', song, '-o', wav, '--seconds', 'Infinity').status).toBe(2);
  });

  it('reports errors with positions and exits non-zero', () => {
    const broken = JSON.parse(readFileSync(song, 'utf8'));
    broken.lanes.wave[1].row = 2;
    writeFileSync(song, JSON.stringify(broken));
    const r = run('check', song);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('1.1.3 (row 2), wave: overlaps the note at 1.1.1; shorten that one to 2 rows');
    expect(run('fmt', '--check', song).status).toBe(1);
  });
});
