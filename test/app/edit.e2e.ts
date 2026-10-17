import { expect, test, type Page } from '@playwright/test';
import { formatSong } from '../../src/core/format.ts';
import { parseSong } from '../../src/core/compile.ts';
import { clampPitchTop, GUTTER, laneBoxes, noteToY } from '../../src/app/roll/geometry.ts';

// Step 2 of pass 4 in a real browser: draw, transpose, drag, undo, save, and a change on disk while there are
// unsaved edits. The folder is the origin-private file system, standing in for the one the picker would return.

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
const tune = formatSong(parsed.song);
const ROW_WIDTH = 12;

async function writeFiles(page: Page, files: Record<string, string>) {
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [name, text] of Object.entries(files)) {
      const w = await (await root.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }, files);
}

async function files(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const out: Record<string, string> = {};
    const root = await navigator.storage.getDirectory();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind === 'file') out[name] = await (await (handle as FileSystemFileHandle).getFile()).text();
    }
    return out;
  });
}

const C5 = 24;
const E5 = 28;

/** Opens a folder holding one song, and returns where a row and note are on the canvas, as the roll lays them out. */
async function open(page: Page, song: string, highest: number) {
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => unknown }).showDirectoryPicker = () =>
      navigator.storage.getDirectory();
  });
  await page.goto('/');
  await writeFiles(page, { [NAME]: song });
  await page.getByRole('button', { name: 'halt_bug' }).click(); // the demo song is open
  await page.getByRole('menuitem', { name: /Open a folder/ }).click();
  await expect(page.getByRole('button', { name: 'tune' })).toBeVisible();
  const canvas = (await page.locator('canvas').boundingBox())!;
  const box = laneBoxes(canvas.height, 'pulse1')[0]!;
  const pitchTop = clampPitchTop(box, highest + 4); // the lane opens 4 notes above its highest
  return (row: number, note: number) => ({
    x: canvas.x + GUTTER + row * ROW_WIDTH,
    y: canvas.y + noteToY(box, pitchTop, note) + 6,
  });
}

test('draws, transposes, moves, undoes and saves notes', async ({ page }) => {
  const at = await open(page, tune, C5);
  const onDisk = async () => (await files(page))[NAME]!;

  // Draw a note, a beat long like the lane's last note, and transpose it.
  let p = at(8.5, E5);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).toContain('{ "row": 8, "len": 4, "note": "F5", "inst": 1 }');
  await expect(page.getByLabel('Unsaved edits')).toBeHidden();

  // Drag the first note four rows on and a tone up, then undo.
  p = at(0.5, C5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const to = at(4.5, C5 + 2);
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).toContain('{ "row": 4, "len": 4, "note": "D5", "inst": 1 }');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).toContain('{ "row": 0, "len": 4, "note": "C5", "inst": 1 }');

  // Resize it by its end, then delete it with a right-click.
  p = at(3.8, C5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(at(6, C5).x, p.y, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).toContain('{ "row": 0, "len": 6, "note": "C5", "inst": 1 }');
  await page.mouse.click(at(1, C5).x, p.y, { button: 'right' });
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).not.toContain('"note": "C5"');

  // A change on disk while there are unsaved edits: keep mine, and theirs is kept as a copy.
  await page.mouse.click(at(20.5, E5).x, at(20.5, E5).y);
  const theirs = (await onDisk()).replace('"version": 1,', '"version": 1,\n  "comment": "edited elsewhere",');
  await writeFiles(page, { [NAME]: theirs });
  await expect(page.getByText(/changed on disk/)).toBeVisible({ timeout: 4000 });
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await expect.poll(async () => Object.entries(await files(page)).find(([n]) => n.includes('.theirs-'))?.[1]).toBe(theirs);
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).toContain('{ "row": 20, "len": 4, "note": "E5", "inst": 1 }');

  await page.getByRole('button', { name: 'Keys', exact: true }).click();
  await expect(page.getByText('Transpose a semitone; with Shift, an octave')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Keys' })).toBeHidden();
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keys' })).toBeVisible();
});

test('keeps the selection right after a drag that comes back, and a key press during a Shift-drag', async ({ page }) => {
  const two = tune.replace(
    '{ "row": 0, "len": 4, "note": "C5", "inst": 1 }',
    '{ "row": 0, "len": 4, "note": "C5", "inst": 1 },\n      { "row": 8, "len": 4, "note": "E5", "inst": 1 }',
  );
  expect(two).not.toBe(tune);
  const at = await open(page, two, E5);
  const onDisk = async () => (await files(page))[NAME]!;

  // With the E5 selected, drag the C5 away and back: the C5 is what's selected, so Delete deletes it.
  await page.mouse.click(at(8.5, E5).x, at(8.5, E5).y);
  await page.mouse.move(at(0.5, C5).x, at(0.5, C5).y);
  await page.mouse.down();
  await page.mouse.move(at(2.5, C5).x, at(2.5, C5).y, { steps: 3 });
  await page.mouse.move(at(0.5, C5).x, at(0.5, C5).y, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).not.toContain('"note": "C5"');
  expect(await onDisk()).toContain('"note": "E5"');

  // Select the E5, start a Shift-drag on empty space, and transpose (an octave, with Shift) before letting go.
  // The selection is the transposed note, so Delete deletes it.
  await page.mouse.click(at(8.5, E5).x, at(8.5, E5).y);
  await page.keyboard.down('Shift');
  await page.mouse.move(at(30, C5).x, at(30, C5).y);
  await page.mouse.down();
  await page.keyboard.press('ArrowUp');
  await page.mouse.move(at(34, C5).x, at(34, C5).y, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).not.toContain('"row": 8');
});

test('hears notes as they are drawn, clicked and dragged to a new pitch', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { heard: string[] };
    w.heard = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, m: { type: string; once?: boolean }, ...rest: never[]) {
      if (m.type === 'play' && m.once) w.heard.push('note');
      return post.call(this, m, ...rest);
    } as typeof post;
  });
  const at = await open(page, tune, C5);
  const heard = () => page.evaluate(() => (window as unknown as { heard: string[] }).heard.length);

  let p = at(8.5, E5);
  await page.mouse.click(p.x, p.y); // draws a note
  await expect.poll(heard).toBe(1);
  p = at(0.5, C5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down(); // presses one
  await expect.poll(heard).toBe(2);
  await page.mouse.move(p.x, at(0.5, C5 + 2).y, { steps: 6 }); // up a semitone, then another
  await page.mouse.up();
  await expect.poll(heard).toBe(4);

  // Not with hearing off.
  await page.getByRole('button', { name: 'Hear notes' }).click();
  await page.mouse.click(at(20.5, E5).x, at(20.5, E5).y);
  await expect(page.getByLabel('Unsaved edits')).toBeVisible();
  expect(await heard()).toBe(4);
});
