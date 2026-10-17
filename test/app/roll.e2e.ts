import { expect, test, type Page } from '@playwright/test';
import { parseSong } from '../../src/core/compile.ts';
import { formatSong } from '../../src/core/format.ts';
import { position } from '../../src/core/location.ts';
import { clampPitchTop, GUTTER, laneBoxes, noteToY, stripTop } from '../../src/app/roll/geometry.ts';

// Ideas from FL Studio's piano roll, in a real browser. The folder is the origin-private file system.

const parsed = parseSong({
  version: 1,
  grid: { rowsPerBeat: 4, beatsPerBar: 4 },
  groove: [6, 6, 6, 6],
  length: 64,
  instruments: { duty: [{ id: 1, duty: '50%', volume: 15 }] },
  lanes: {
    pulse1: [{ row: 0, len: 4, note: 'C5', inst: 1 }],
    pulse2: [{ row: 8, len: 4, note: 'E5', inst: 1 }],
  },
});
if (parsed.errors) throw new Error(JSON.stringify(parsed.errors));
const NAME = 'tune.gbscore.json';
const tune = formatSong(parsed.song);
const ROW = 12; // pixels, the roll's starting zoom
const C5 = 24;
const E5 = 28;

/** Opens a folder holding the song, and returns where a row and note are on the canvas in the expanded lane. */
async function open(page: Page, song = tune, highest = C5) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showDirectoryPicker = () => navigator.storage.getDirectory();
  });
  await page.goto('/');
  await page.evaluate(
    async ([name, text]) => {
      const w = await (await (await navigator.storage.getDirectory()).getFileHandle(name!, { create: true })).createWritable();
      await w.write(text!);
      await w.close();
    },
    [NAME, song],
  );
  await page.getByRole('button', { name: 'halt_bug' }).click(); // the demo song is open
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();
  const canvas = (await page.locator('canvas').boundingBox())!;
  const box = laneBoxes(canvas.height, 'pulse1')[0]!;
  const pitchTop = clampPitchTop(box, highest + 4); // the lane opens 4 notes above its highest
  return (row: number, note: number) => ({
    x: canvas.x + GUTTER + row * ROW,
    y: canvas.y + noteToY(box, pitchTop, note) + 6,
  });
}

async function onDisk(page: Page) {
  return page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle(name)).getFile()).text();
  }, NAME);
}

/** Where a row is on pulse 1's strip of placed patterns. The bar for a selected placement moves the roll down, so
 * it's measured each time. */
async function clip(page: Page, row: number) {
  const now = (await page.locator('canvas').boundingBox())!;
  return { x: now.x + GUTTER + row * ROW, y: now.y + laneBoxes(now.height, 'pulse1')[0]!.top + 8 };
}

/** A song with notes in pulse 1 only. */
function song(notes: { row: number; len: number; note: string }[]) {
  const p = parseSong({ ...parsed.song, lanes: { pulse1: notes.map((n) => ({ ...n, inst: 1 })) } });
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  return formatSong(p.song);
}

/** The colour the canvas shows at a point on the page. */
function pixel(page: Page, p: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const c = document.querySelector('canvas')!;
    const r = c.getBoundingClientRect();
    const d = devicePixelRatio;
    return [...c.getContext('2d')!.getImageData(Math.round((x - r.left) * d), Math.round((y - r.top) * d), 1, 1).data];
  }, p);
}

/** Picks an item from the toolbar's View menu, or from one of its submenus. */
async function view(page: Page, item: string, inSubmenu?: string) {
  await page.getByRole('button', { name: 'View' }).click();
  if (!inSubmenu) return page.getByRole('menuitemcheckbox', { name: item }).click();
  await page.getByRole('menuitem', { name: item }).click();
  await page.getByRole('menuitemradio', { name: inSubmenu, exact: true }).click();
}

test('shows the other lanes as ghost notes, and hides them', async ({ page }) => {
  const at = await open(page);
  const empty = await pixel(page, at(40.5, E5));
  // Pulse 2's E5 shows behind pulse 1, where pulse 1 has nothing.
  await expect.poll(() => pixel(page, at(10.5, E5))).not.toEqual(empty);
  await view(page, 'Ghost notes');
  await expect.poll(() => pixel(page, at(10.5, E5))).toEqual(empty);
  // Clicking where a ghost was draws a note in pulse 1, as on empty space.
  await view(page, 'Ghost notes');
  await page.mouse.click(at(10.5, E5).x, at(10.5, E5).y);
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
});

test('deletes every note a right-drag passes over, as one step of undo', async ({ page }) => {
  const at = await open(
    page,
    song([
      { row: 0, len: 4, note: 'C5' },
      { row: 8, len: 4, note: 'C5' },
      { row: 16, len: 4, note: 'C5' },
      { row: 24, len: 4, note: 'D5' },
    ]),
    C5 + 2,
  );
  // A fast drag, a single pointer event from one note to another, still gets the note between them.
  await page.mouse.move(at(1, C5).x, at(1, C5).y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(at(19, C5).x, at(19, C5).y);
  await page.mouse.move(at(30, C5).x, at(30, C5).y);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).not.toContain('"C5"');
  expect(await onDisk(page)).toContain('{ "row": 24, "len": 4, "note": "D5", "inst": 1 }');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await onDisk(page)).match(/"C5"/g)?.length).toBe(3);
});

test("paints notes of the pen's length along an Alt-drag, as one step of undo", async ({ page }) => {
  const at = await open(page, song([{ row: 0, len: 4, note: 'C5' }]));
  const G5 = 31;
  const moveTo = (row: number, note: number) => page.mouse.move(at(row, note).x, at(row, note).y);
  await moveTo(8.5, E5);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await moveTo(14.5, E5);
  await moveTo(18.5, E5);
  await moveTo(18.5, G5); // back over the third note, a third higher
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 16, "len": 4, "note": "G5", "inst": 1 }');
  const disk = await onDisk(page);
  expect(disk).toContain('{ "row": 8, "len": 4, "note": "E5", "inst": 1 },\n');
  expect(disk).toContain('{ "row": 12, "len": 4, "note": "E5", "inst": 1 },\n');
  expect(disk.match(/"note"/g)).toHaveLength(4);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await onDisk(page)).match(/"note"/g)?.length).toBe(1);

  // Down onto the effect strip and along it: there's no pitch there, so only the first slot is painted.
  const canvas = (await page.locator('canvas').boundingBox())!;
  const strip = canvas.y + stripTop(laneBoxes(canvas.height, 'pulse1')[0]!) + 12;
  await moveTo(40.5, E5);
  await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(at(40.5, E5).x, strip);
  await page.mouse.move(at(60.5, E5).x, strip);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await onDisk(page)).match(/"note"/g)?.length).toBe(2);
  expect(await onDisk(page)).toContain('{ "row": 40, "len": 4, "note": ');
});

test('shades the notes outside a scale, with the root the song fits best', async ({ page }) => {
  const at = await open(
    page,
    song([
      { row: 0, len: 12, note: 'A5' },
      { row: 12, len: 4, note: 'C6' },
      { row: 16, len: 4, note: 'E6' },
    ]),
    40, // E6
  );
  const B5 = 35;
  const C5sharp = 25;
  const [inside, outside] = [await pixel(page, at(40.5, B5)), await pixel(page, at(40.5, C5sharp))];
  await view(page, 'Scale: off', 'Minor');
  await page.getByRole('button', { name: 'View' }).click();
  await expect(page.getByRole('menuitem', { name: 'Scale: A minor' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => pixel(page, at(40.5, C5sharp))).not.toEqual(outside); // C# is out of A minor
  expect(await pixel(page, at(40.5, B5))).toEqual(inside);
  await view(page, 'Scale: A minor', 'Off');
  await expect.poll(() => pixel(page, at(40.5, C5sharp))).toEqual(outside);
});

test("draws a placed pattern's notes, and a click on one picks it up, editing its pattern", async ({ page }) => {
  const p = parseSong({
    ...parsed.song,
    patterns: [{ id: 'riff', kind: 'duty', length: 8, items: [{ row: 0, len: 4, note: 'C5', inst: 1 }] }],
    lanes: { pulse1: [{ row: 0, len: 4, note: 'E5', inst: 1 }, { row: 16, pattern: 'riff', repeat: 2, transpose: 4 }] },
  });
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  const text = formatSong(p.song);
  const at = await open(page, text, E5);
  const empty = await pixel(page, at(40.5, C5));
  // Both repeats play E5 (C5 transposed by 4).
  await expect.poll(() => pixel(page, at(17.5, E5))).not.toEqual(empty);
  await expect.poll(() => pixel(page, at(25.5, E5))).not.toEqual(empty);
  await page.locator('canvas').screenshot({ path: 'test-results/patterns.png' });
  // A click on a pattern's note selects it, without opening anything or changing the song.
  await page.mouse.click(at(17.5, E5).x, at(17.5, E5).y);
  await expect(page.getByLabel('Unsaved edits')).toHaveCount(0);
  await expect(page.getByLabel('Transpose')).toHaveCount(0);
  // Moving it up a semitone moves the pattern's note, in both repeats.
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => pixel(page, at(25.5, E5 + 1))).not.toEqual(empty);
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 0, "len": 4, "note": "C#5", "inst": 1 }');
  expect(await onDisk(page)).toContain('{ "row": 16, "pattern": "riff", "transpose": 4, "repeat": 2 }');
  // With the placement selected, pressing a note hides the bar above the roll, which moves the canvas mid-drag;
  // dragging it sideways keeps its pitch.
  const strip = await clip(page, 20.5);
  await page.mouse.click(strip.x, strip.y);
  await expect(page.getByLabel('Transpose')).toHaveValue('4');
  const now = (await page.locator('canvas').boundingBox())!;
  const box = laneBoxes(now.height, 'pulse1')[0]!;
  const y = now.y + noteToY(box, clampPitchTop(box, E5 + 4), E5 + 1) + 6; // F5, where the bar has moved it
  await page.mouse.move(at(17.5, 0).x, y);
  await page.mouse.down();
  await expect(page.getByLabel('Transpose')).toHaveCount(0);
  await page.mouse.move(at(21.5, 0).x, y);
  await page.mouse.up();
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 4, "len": 4, "note": "C#5", "inst": 1 }');
});

test('edits a pattern where it plays, changing every place, and arranges placements in the strip', async ({ page }) => {
  const p = parseSong({
    ...parsed.song,
    patterns: [{ id: 'riff', kind: 'duty', length: 8, items: [{ row: 0, len: 4, note: 'C5', inst: 1 }] }],
    lanes: { pulse1: [{ row: 0, len: 4, note: 'E5', inst: 1 }, { row: 16, pattern: 'riff', repeat: 2 }] },
  });
  if (p.errors) throw new Error(JSON.stringify(p.errors));
  const at = await open(page, formatSong(p.song), E5);
  const canvas = (await page.locator('canvas').boundingBox())!;
  const box = laneBoxes(canvas.height, 'pulse1')[0]!;
  // Where a row is on the strip of placed patterns. The bar for a selected placement moves the roll down, so it's
  // measured each time.
  const clips = async (row: number) => {
    const now = (await page.locator('canvas').boundingBox())!;
    return { x: now.x + GUTTER + row * ROW, y: now.y + laneBoxes(now.height, 'pulse1')[0]!.top + 8 };
  };
  const press = async (row: number) => {
    const p = await clips(row);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
  };
  const release = async (row: number) => {
    const p = await clips(row);
    await page.mouse.move(p.x, p.y);
    await page.mouse.up();
  };
  // Draw a note in the second repeat: it goes into the pattern.
  await page.mouse.click(at(28.5, E5).x, at(28.5, E5).y);
  await page.locator('canvas').screenshot({ path: 'test-results/pattern-edit.png' });
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 4, "len": 4, "note": "E5", "inst": 1 }');
  // The effect strip edits the pattern's rows there.
  const strip = canvas.y + stripTop(box) + 8;
  await page.mouse.click(at(28.5, E5).x, strip);
  await expect(page.getByText('The first row of E5')).toBeVisible();
  await page.keyboard.press('Escape');
  // Stepping rows in the popover goes on into the next repeat, which becomes the target.
  await page.mouse.click(at(23.5, E5).x, strip);
  await page.getByRole('button', { name: 'Row after' }).click();
  await expect(page.getByText('The first row of C5')).toBeVisible();
  await page.keyboard.press('Escape');
  // Click the placement in the strip to select it, transpose it with the arrow keys, and drag it a bar on.
  await press(18.5);
  await release(18.5);
  await expect(page.getByLabel('Transpose')).toHaveValue('0');
  // Esc in the name field puts the name back.
  await page.getByLabel('Pattern name').fill('zzz');
  await page.getByLabel('Pattern name').press('Escape');
  await expect(page.getByLabel('Pattern name')).toHaveValue('riff');
  await page.keyboard.press('ArrowUp');
  await expect(page.getByLabel('Transpose')).toHaveValue('1');
  await press(18.5);
  await release(34.5);
  await page.locator('canvas').screenshot({ path: 'test-results/pattern-selected.png' });
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 32, "pattern": "riff", "transpose": 1, "repeat": 2 }');
  // Drag its right edge a beat past the second repeat: a third repeat, cut short.
  await press(47.8);
  await release(52);
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 32, "pattern": "riff", "transpose": 1, "repeat": 3, "len": 20 }');
  // A click on empty strip places the current pattern, the one last selected, at the beat.
  await press(57.5);
  await release(57.5);
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 56, "pattern": "riff" }');
  // Make a pattern of the first note's beat.
  await page.mouse.click(at(1, E5).x, at(1, E5).y);
  await page.keyboard.press('Control+g');
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 0, "pattern": "p2" }');
});

test('mutes and solos lanes while the song plays', async ({ page }) => {
  // Taps the app's output, to measure how loud it is.
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => AudioNode;
    AudioNode.prototype.connect = function (this: AudioNode, ...a: unknown[]) {
      if (a[0] === this.context.destination) {
        const analyser = this.context.createAnalyser();
        connect.call(this, analyser);
        (window as unknown as Record<string, unknown>).analyser = analyser;
      }
      return connect.apply(this, a);
    } as AudioNode['connect'];
  });
  await open(page, song([{ row: 0, len: 64, note: 'C5' }]));
  const loudness = () =>
    page.evaluate(() => {
      const analyser = (window as unknown as { analyser?: AnalyserNode }).analyser;
      if (!analyser) return 0;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return Math.max(...samples.map(Math.abs));
    });
  const mute = page.getByRole('button', { name: 'Mute Pulse 1' });
  const soloWave = page.getByRole('button', { name: 'Solo Wave' });

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(loudness).toBeGreaterThan(0.05);
  await soloWave.click(); // the wave lane is empty
  await expect(soloWave).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(loudness).toBeLessThan(0.005);
  await soloWave.click();
  await expect.poll(loudness).toBeGreaterThan(0.05);
  await mute.click();
  await expect.poll(loudness).toBeLessThan(0.005);
  await mute.click();
  await expect.poll(loudness).toBeGreaterThan(0.05);
  await page.getByRole('button', { name: 'Stop' }).click();
  // Muted before it plays: the next play starts muted.
  await mute.click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText(/started in \d+ ms/)).toBeVisible();
  await page.waitForTimeout(300);
  expect(await loudness()).toBeLessThan(0.005);
  await mute.click();
  await expect.poll(loudness).toBeGreaterThan(0.05);
  await page.getByRole('button', { name: 'Stop' }).click();

  // A collapsed lane's buttons don't expand it, which would move pulse 2's down.
  const pulse2 = await page.getByRole('button', { name: 'Mute Pulse 2' }).boundingBox();
  await page.getByRole('button', { name: 'Solo Noise' }).click();
  await expect(page.getByRole('button', { name: 'Solo Noise' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.getByRole('button', { name: 'Mute Pulse 2' }).boundingBox()).toEqual(pulse2);
});

test('loops the beats dragged along the ruler while the song plays, and turns looping off', async ({ page }) => {
  const at = await open(page);
  const canvas = (await page.locator('canvas').boundingBox())!;
  const ruler = canvas.y + 10;
  const loopButton = page.getByRole('button', { name: 'Loop' });
  await expect(loopButton).toBeDisabled();
  // From row 26 back to row 17: the beats they're in, rows 16 to 27, with the flag at the start.
  await page.mouse.move(at(26.5, C5).x, ruler);
  await page.mouse.down();
  await page.mouse.move(at(17.5, C5).x, ruler, { steps: 5 });
  await page.mouse.up();
  await expect(loopButton).toHaveAttribute('aria-pressed', 'true');
  const label = page.getByLabel('Position');
  await expect(label).toHaveText(position(parsed.song.grid, 16));

  // A row is a tenth of a second, so the loop lasts 1.2 s.
  const rowOf = new Map(Array.from({ length: 64 }, (_, row) => [position(parsed.song.grid, row), row]));
  const rows = async (ms: number) => {
    const seen: number[] = [];
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(30)) {
      const row = rowOf.get((await label.textContent())!);
      if (row !== undefined && row !== seen.at(-1)) seen.push(row);
    }
    return seen;
  };
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByText(/started in \d+ ms/)).toBeVisible();
  const looped = await rows(3000);
  expect(Math.min(...looped)).toBe(16);
  expect(Math.max(...looped)).toBe(27);
  expect(looped.some((row, i) => i > 0 && row < looped[i - 1]!)).toBe(true); // went back

  // Off while it plays: it plays on past the loop.
  await loopButton.click();
  await expect(loopButton).toHaveAttribute('aria-pressed', 'false');
  expect(Math.max(...(await rows(2500)))).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'Stop' }).click();
});

test("sets the song's length and loop from the ruler, cutting past a shorter end, and draws past the old end", async ({ page }) => {
  const at = await open(page, song([{ row: 0, len: 4, note: 'C5' }, { row: 40, len: 4, note: 'C5' }]));
  const canvas = page.locator('canvas');
  const ruler = (await canvas.boundingBox())!.y + 10;
  const dialog = page.getByRole('dialog');
  await page.mouse.move(at(20, C5).x, ruler);
  await expect(canvas).toHaveAttribute('title', /The song ends at 5\.1\.1 and loops back to 1\.1\.1/);

  // A right-click picks the nearest beat. Ending the song there cuts the note past it, as one step of undo.
  await page.mouse.click(at(33.2, C5).x, ruler, { button: 'right' });
  await expect(dialog).toContainText('Song · 3.1.1 (row 32)');
  await dialog.getByRole('button', { name: 'End the song here' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/The song now ends at 3\.1\.1: a note cut/)).toBeVisible();
  await page.keyboard.press('Control+z');

  // Past the end, the length in bars and rows.
  await page.mouse.click(at(70, C5).x, ruler, { button: 'right' });
  await dialog.getByLabel('Length in bars').fill('6');
  await dialog.getByLabel('And rows').fill('2');
  await expect(dialog).toContainText('98 rows');
  await dialog.getByLabel('And rows').press('Enter');
  await expect(dialog).toHaveCount(0);
  await page.mouse.click(at(16.4, C5).x, ruler, { button: 'right' });
  await dialog.getByRole('button', { name: 'Loop back to here' }).click();

  // A note goes where the song used to end.
  await page.mouse.click(at(70.5, C5).x, at(70.5, C5).y);
  await page.keyboard.press('Control+s');
  await expect(page.getByLabel('Unsaved edits')).toHaveCount(0);
  const saved = JSON.parse(await onDisk(page));
  expect(saved).toMatchObject({ length: 98, loop: 16 });
  expect(saved.lanes.pulse1.map((n: { row: number }) => n.row)).toEqual([0, 40, 70]);
});

test("sets the song's title, artist, comment and grid from the song menu, and the ruler and note lengths follow", async ({ page }) => {
  const at = await open(page);
  const canvas = page.locator('canvas');
  const ruler = (await canvas.boundingBox())!.y + 10;
  await expect(page.getByRole('button', { name: 'Note length: 1 beat' })).toBeVisible();

  await page.getByRole('button', { name: 'tune' }).click();
  await page.getByRole('menuitem', { name: 'Song settings…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('Tune');
  await dialog.getByLabel('Artist').fill('Me');
  await dialog.getByLabel('Comment').fill('For the\ntitle screen');
  await dialog.getByLabel('Rows per beat').fill('3');
  await dialog.getByLabel('Beats per bar').fill('3');
  await dialog.getByLabel('Beats per bar').press('Enter');
  await expect(dialog).toHaveCount(0);

  // 64 rows in bars of 9 rows end at bar 8's second row. The pen's beat is still a beat, now 3 rows.
  await page.mouse.move(at(20, C5).x, ruler);
  await expect(canvas).toHaveAttribute('title', /The song ends at 8\.1\.2/);
  await expect(page.getByRole('button', { name: 'Note length: 1 beat' })).toBeVisible();
  await page.mouse.click(at(30.5, C5).x, at(30.5, C5).y);

  await page.keyboard.press('Control+s');
  await expect(page.getByLabel('Unsaved edits')).toHaveCount(0);
  const saved = JSON.parse(await onDisk(page));
  expect(saved).toMatchObject({ title: 'Tune', artist: 'Me', comment: 'For the\ntitle screen', grid: { rowsPerBeat: 3, beatsPerBar: 3 } });
  expect(saved.lanes.pulse1.at(-1)).toMatchObject({ row: 30, len: 3 });
});

test("sets the groove from song settings, refusing one the loop row can't keep in phase", async ({ page }) => {
  await open(page, formatSong({ ...parsed.song, loop: 2 }));
  await page.getByRole('button', { name: 'tune' }).click();
  await page.getByRole('menuitem', { name: 'Song settings…' }).click();
  const dialog = page.getByRole('dialog');
  // 6 ticks a row at 4 rows a beat.
  await expect(dialog).toContainText('151 BPM on average at 4 rows a beat, through the song');

  await dialog.getByLabel('Groove step 4').fill('8');
  await expect(dialog).toContainText("Can't: loop (2) must be a multiple of 4 when the groove isn't uniform");
  await dialog.getByRole('button', { name: 'Set' }).click();
  await expect(dialog).toBeVisible();

  await dialog.getByLabel('Groove step 4').fill('5');
  await dialog.getByLabel('Groove step 3').fill('5');
  await dialog.getByLabel('Groove step 2').fill('5');
  await dialog.getByLabel('Groove step 1').fill('5');
  await expect(dialog).toContainText('181 BPM on average');
  await dialog.getByLabel('Groove step 1').press('Enter');
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press('Control+s');
  await expect(page.getByLabel('Unsaved edits')).toHaveCount(0);
  expect(JSON.parse(await onDisk(page))).toMatchObject({ groove: [5, 5, 5, 5], loop: 2 });
});

test('makes the selected note legato with L, and normal again, each one step of undo', async ({ page }) => {
  const at = await open(page, song([{ row: 0, len: 4, note: 'C5' }, { row: 4, len: 4, note: 'C5' }]));
  await page.mouse.click(at(5, C5).x, at(5, C5).y);
  await page.keyboard.press('l');
  await expect(page.getByText('1 note now legato')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 4, "len": 4, "note": "C5", "legato": true }');

  await page.keyboard.press('l');
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('{ "row": 4, "len": 4, "note": "C5", "inst": 1 }');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  await expect.poll(() => onDisk(page)).toContain('"legato": true');
});
