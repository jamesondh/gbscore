import { expect, test, type Page } from '@playwright/test';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';
import { clampPitchTop, KEY_LEFT, laneBoxes, noteToY } from '../../src/app/roll/geometry.ts';

// Step 3 of pass 4 in a real browser: note entry from the computer keyboard and a MIDI keyboard, heard as it goes.
// The folder is the origin-private file system, and the MIDI keyboard a stand-in the test plays through
// window.midi.

const parsed = parseSong({
  version: 1,
  grid: { rowsPerBeat: 4, beatsPerBar: 4 },
  groove: [6, 6, 6, 6],
  length: 64,
  instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
  lanes: { pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }] },
});
if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
const NAME = 'tune.gbscore.json';

async function onDisk(page: Page): Promise<string> {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle(name)).getFile()).text();
  }, NAME);
}

test('enters notes from the keyboard and a MIDI keyboard', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.showDirectoryPicker = () => navigator.storage.getDirectory();
    const input = { onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
    w.midi = (data: number[]) => input.onmidimessage?.({ data: new Uint8Array(data) });
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      value: async () => ({ inputs: new Map([['keyboard', input]]), onstatechange: null }),
    });
  });
  await page.goto('/');
  await page.evaluate(
    async ([name, text]) => {
      const w = await (await (await navigator.storage.getDirectory()).getFileHandle(name!, { create: true })).createWritable();
      await w.write(text!);
      await w.close();
    },
    [NAME, formatSong(parsed.song)],
  );
  await page.getByRole('button', { name: 'halt_bug' }).click(); // the demo song is open
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();

  // Letters do nothing until note entry is on.
  await page.keyboard.press('KeyD');
  await expect(page.getByLabel('Unsaved edits')).toBeHidden();
  await page.keyboard.press('KeyM');
  await expect(page.getByRole('button', { name: 'Note length: 1 beat' })).toBeVisible();

  // Two beats' rest, then C and E a beat each, G a row long, and C an octave up.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('KeyA');
  await page.keyboard.press('KeyD');
  await page.keyboard.press('Digit1');
  await page.keyboard.press('KeyG');
  await page.keyboard.press('KeyX');
  await page.keyboard.press('KeyA');
  await expect(page.getByRole('button', { name: 'Note length: 1 row' })).toBeVisible();

  // Middle C on the MIDI keyboard is C5 here.
  await page.evaluate(() => (window as unknown as { midi: (d: number[]) => void }).midi([0x90, 60, 100]));
  await page.evaluate(() => (window as unknown as { midi: (d: number[]) => void }).midi([0x80, 60, 0]));

  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 18, "len": 1, "note": "C5", "inst": 1 }');
  const text = await onDisk(page);
  for (const note of [
    '{ "row": 8, "len": 4, "note": "C5", "inst": 1 }',
    '{ "row": 12, "len": 4, "note": "E5", "inst": 1 }',
    '{ "row": 16, "len": 1, "note": "G5", "inst": 1 }',
    '{ "row": 17, "len": 1, "note": "C6", "inst": 1 }',
  ]) {
    expect(text).toContain(note);
  }

  // Hearing the notes didn't report as playing, or fail.
  await expect(page.getByText(/started in|Couldn't play|audio gaps/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  // Hearing turns off, and is remembered.
  const hear = page.getByRole('button', { name: 'Hear notes' });
  await expect(hear).toHaveAttribute('aria-pressed', 'true');
  await hear.click();
  await expect(hear).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => localStorage.getItem('gbscore.hear'))).toBe('off');
});

test('plays notes from the keyboard and a MIDI keyboard while held, without entering them', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & { sent: string[] };
    w.showDirectoryPicker = () => navigator.storage.getDirectory();
    const input = { onmidimessage: null as null | ((e: { data: Uint8Array }) => void) };
    w.midi = (data: number[]) => input.onmidimessage?.({ data: new Uint8Array(data) });
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      value: async () => ({ inputs: new Map([['keyboard', input]]), onstatechange: null }),
    });
    // What the app asks the emulator for: a note heard, by its pitch in pulse 1 (0 is C3), or a stop.
    w.sent = [];
    const post = Worker.prototype.postMessage;
    type Sent = { type: string; once?: boolean; song?: { orders: number[][]; patterns: { note: number }[][] } };
    Worker.prototype.postMessage = function (this: Worker, m: Sent, ...rest: never[]) {
      if (m.type === 'play' && m.once) w.sent.push(`note ${m.song!.patterns[m.song!.orders[0]![0]!]![0]!.note}`);
      if (m.type === 'play' && !m.once) w.sent.push('song');
      if (m.type === 'stop') w.sent.push('stop');
      return post.call(this, m, ...rest);
    };
  });
  await page.goto('/');
  await page.evaluate(
    async ([name, text]) => {
      const w = await (await (await navigator.storage.getDirectory()).getFileHandle(name!, { create: true })).createWritable();
      await w.write(text!);
      await w.close();
    },
    [NAME, formatSong(parsed.song)],
  );
  await page.getByRole('button', { name: 'halt_bug' }).click(); // the demo song is open
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();
  const sent = () => page.evaluate(() => (window as unknown as { sent: string[] }).sent.splice(0));
  const midi = (data: number[]) => page.evaluate((d) => (window as unknown as { midi: (d: number[]) => void }).midi(d), data);

  // Letters do nothing until Play keys is on.
  await page.keyboard.press('KeyA');
  expect(await sent()).toEqual([]);

  // The roll's keyboard plays a key while it's held, Play keys or not, and dragging along it plays each key passed.
  // A key held is drawn in the colour of the instrument it plays.
  const canvas = (await page.locator('canvas').boundingBox())!;
  const box = laneBoxes(canvas.height, 'pulse1')[0]!;
  const pitchTop = clampPitchTop(box, 24 + 4); // the lane opens 4 notes above its highest
  const key = (note: number) => ({ x: KEY_LEFT + 8, y: noteToY(box, pitchTop, note) + 6 });
  const pixel = (at: { x: number; y: number }) =>
    page.evaluate(({ x, y }) => {
      const d = document.querySelector('canvas')!.getContext('2d')!.getImageData(x * devicePixelRatio, y * devicePixelRatio, 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    }, at);
  const colour = (note: number) => pixel(key(note));
  // The bar beside the keys the computer keyboard plays.
  const marked = async (note: number) => (await pixel({ x: KEY_LEFT - 3, y: key(note).y })) === '56,189,248';
  expect(await marked(24)).toBe(false);
  const WHITE = '212,212,216';
  expect(await colour(24)).toBe(WHITE);
  await page.mouse.move(canvas.x + key(24).x, canvas.y + key(24).y);
  await page.mouse.down();
  await expect.poll(sent).toEqual(['note 24']);
  await expect.poll(() => colour(24)).not.toBe(WHITE);
  await page.mouse.move(canvas.x + key(26).x, canvas.y + key(26).y);
  await expect.poll(sent).toEqual(['stop', 'note 26']);
  await expect.poll(() => colour(24)).toBe(WHITE);
  await page.mouse.up();
  await expect.poll(sent).toEqual(['stop']);
  await expect.poll(() => colour(26)).toBe(WHITE);
  await page.keyboard.press('Shift+KeyM');
  await expect(page.getByRole('button', { name: 'Play keys' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Note entry' })).toHaveAttribute('aria-pressed', 'false');
  // A plays C5, so the bar starts there.
  await expect.poll(() => marked(24)).toBe(true);
  expect(await marked(23)).toBe(false);

  // A note sounds until its key comes up, lit on the roll's keyboard: C5 is 24.
  await page.keyboard.down('KeyA');
  await expect.poll(sent).toEqual(['note 24']);
  await expect.poll(() => colour(24)).not.toBe(WHITE);
  await page.keyboard.up('KeyA');
  await expect.poll(sent).toEqual(['stop']);
  await expect.poll(() => colour(24)).toBe(WHITE);

  // One at a time: the newer key sounds, and letting go of the older one doesn't stop it.
  await page.keyboard.down('KeyA');
  await expect.poll(sent).toEqual(['note 24']);
  await page.keyboard.down('KeyD');
  await expect.poll(sent).toEqual(['note 28']);
  await page.keyboard.up('KeyA');
  await page.keyboard.up('KeyD');
  await expect.poll(sent).toEqual(['stop']);

  // Z and X move the octave.
  await page.keyboard.press('KeyX');
  await expect.poll(() => marked(24)).toBe(false);

  // The MIDI keyboard plays too: middle C is C5.
  await midi([0x90, 60, 100]);
  await expect.poll(sent).toEqual(['note 24']);
  await midi([0x80, 60, 0]);
  await expect.poll(sent).toEqual(['stop']);

  // Try plays the last note played.
  await page.keyboard.press('KeyI');
  await page.keyboard.down('KeyE'); // D#6
  await page.keyboard.up('KeyE');
  await expect.poll(sent).toEqual(['note 39', 'stop']);
  await page.getByRole('button', { name: 'Try', exact: true }).click();
  await expect.poll(sent).toEqual(['note 39']);

  // Nothing entered, and nothing reported as playing or failing.
  await expect(page.getByLabel('Unsaved edits')).toBeHidden();
  await expect(page.getByText(/started in|Couldn't play|Can't hear|audio gaps/)).toHaveCount(0);

  // Silent while the song plays.
  await page.keyboard.press('Space');
  await expect.poll(sent).toEqual(['song']);
  await page.keyboard.down('KeyA');
  await page.keyboard.up('KeyA');
  await page.keyboard.press('Space');
  await expect.poll(sent).toEqual(['stop']);

  // Remembered.
  expect(await page.evaluate(() => localStorage.getItem('gbscore.playKeys'))).toBe('on');
  await page.getByRole('button', { name: 'Play keys' }).click();
  expect(await page.evaluate(() => localStorage.getItem('gbscore.playKeys'))).toBe('off');
});
