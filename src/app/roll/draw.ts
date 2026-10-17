import { rowTicks } from '../../core/compile.ts';
import { rowsPerBar, type SongError } from '../../core/location.ts';
import { noteName } from '../../core/notes.ts';
import { expand, occurrenceAt, occurrenceEnd, placementExtras } from '../../core/patterns.ts';
import { LANE_KIND, LANES, type Effect, type LaneItem, type LaneName, type Song } from '../../core/schema.ts';
import { endRows, globalKind, GLOBAL_KINDS, type GlobalKind, shortEffect, tempos } from '../effects.ts';
import { inScale, type Scale } from '../scales.ts';
import { noteIndex } from '../song.ts';
import type { View } from '../store.ts';
import {
  CLIPS,
  GUTTER,
  KEY_LEFT,
  LANE_BUTTONS,
  LANE_HEADER,
  type LaneBox,
  NOTE_HEIGHT,
  notesTop,
  noteToY,
  RULER,
  rowToX,
  SONG_LANE,
  songLaneTop,
  STRIP,
  stripTop,
  volumeHeight,
} from './geometry.ts';

// Draws the piano roll on a canvas, from the song, the view and the playhead. Nothing here changes state.

export const LANE_TITLES: Record<LaneName, string> = { pulse1: 'Pulse 1', pulse2: 'Pulse 2', wave: 'Wave', noise: 'Noise' };
const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
const HUES = [205, 135, 30, 275, 345, 55, 175, 0, 95, 235, 315, 15, 155, 255, 45];
const EFFECT = '#f5b544';
const SELECTED_EFFECT = '#ffffff';

export interface DrawnNote {
  item: LaneItem;
  row: number;
  end: number; // fractional row where it stops sounding
  note: number;
  inst: number; // legato notes take the instrument still playing
  legato: boolean;
  fx?: Effect;
  pattern?: string; // the pattern it plays in, unless that place is the target of edits
}

/** A placed pattern, drawn as a band over its rows. */
export interface DrawnPlacement {
  item: LaneItem; // the lane item that places it
  start: number;
  end: number; // after its last repeat
  label: string;
  repeats: number[]; // rows where its second and later repeats start
}

/** An effect in a lane's strip: a note's fx or an item without a note. */
export interface StripEffect {
  row: number;
  fx: Effect;
}

/** A song-wide effect in its track of the song lane. */
export interface GlobalMark {
  row: number;
  label: string;
}

interface Model {
  lanes: Record<
    LaneName,
    {
      notes: DrawnNote[];
      effects: number[]; // rows with effects without a note
      strip: StripEffect[];
      ends: number[]; // rows a note's end needs
      placements: DrawnPlacement[];
      low: number;
      high: number;
    }
  >;
  globals: Record<GlobalKind, GlobalMark[]>;
}

const models = new WeakMap<Song, Model>();

/** What the roll draws of a song, as it plays, with its patterns written out, worked out once per version of it. */
export function model(source: Song): Model {
  let m = models.get(source);
  if (m) return m;
  const { song, occurrences } = expand(source);
  const lanes = {} as Model['lanes'];
  // Ticks per row on the first pass, as the driver will play them, for drawing notes that end mid-row.
  const ticks = rowTicks(song, tempos(song));
  for (const lane of LANES) {
    const placements = new Map<LaneItem, DrawnPlacement>();
    const places = (id: string) => occurrences.filter((o) => o.pattern.id === id).length;
    for (const o of occurrences) {
      if (o.lane !== lane) continue;
      const p = placements.get(o.placement);
      if (p) {
        p.repeats.push(o.start);
        p.end = occurrenceEnd(o);
        continue;
      }
      const n = places(o.pattern.id);
      const label = [o.pattern.id, ...placementExtras(o.placement)].join(' ') + (n > 1 ? ` · ${n} places` : '');
      placements.set(o.placement, { item: o.placement, start: o.start, end: occurrenceEnd(o), label, repeats: [] });
    }
    const notes: DrawnNote[] = [];
    const effects: number[] = [];
    const strip: StripEffect[] = [];
    let inst = 0;
    for (const item of song.lanes[lane]) {
      if (item.fx) strip.push({ row: item.row, fx: item.fx });
      if (!item.note) {
        effects.push(item.row);
        continue;
      }
      if (item.inst) inst = item.inst;
      const len = item.len ?? 1;
      const lastRowTicks = ticks[item.row + len - 1]?.[0] ?? song.groove[0];
      const end = item.cutTick === undefined ? item.row + len : item.row + len - 1 + item.cutTick / lastRowTicks;
      const pattern = occurrenceAt(occurrences, lane, item.row)?.pattern.id;
      notes.push({ item, row: item.row, end, note: noteIndex(item.note), inst, legato: !item.inst, fx: item.fx, pattern });
    }
    const pitches = notes.map((n) => n.note);
    const ends = [...endRows(song, lane).keys()].sort((a, b) => a - b);
    lanes[lane] = {
      notes,
      effects,
      strip,
      ends,
      placements: [...placements.values()],
      low: Math.min(...pitches),
      high: Math.max(...pitches),
    };
  }
  const globals = { tempo: [], pan: [], masterVolume: [] } as Model['globals'];
  for (const g of song.global) {
    const k = globalKind(g);
    const label = g.tempo !== undefined ? String(g.tempo) : g.pan ? 'pan' : g.masterVolume!.join(',');
    globals[k].push({ row: g.row, label });
  }
  m = { lanes, globals };
  models.set(source, m);
  return m;
}

/** The bar beside the keys the computer keyboard plays. */
export const KEY_RANGE = '#38bdf8';

export interface Scene {
  width: number;
  height: number;
  song: Song | undefined;
  view: View;
  boxes: LaneBox[];
  startRow: number;
  loop: { start: number; end: number } | undefined; // the rows dragged along the ruler
  looping: boolean;
  playhead: number | undefined; // fractional row
  selected: Set<LaneItem>;
  fxSelected: Set<number>; // rows of the expanded lane's effects selected apart from their notes
  errors: SongError[];
  ghosts: boolean;
  scale: Scale | undefined;
  silent: Set<LaneName>; // muted, or not soloed when others are
  keysDown: { notes: Set<number>; inst: number }; // notes held on the keyboard, and the instrument they play with
  keyRange?: { low: number; high: number }; // the notes the computer keyboard plays, with note entry or Play keys on
  source?: Song; // the song with its placements, when `song` is the view of a target occurrence
  placement?: LaneItem; // the selected placement
  target?: { start: number; end: number }; // the place a pattern plays that's the target of edits, in the expanded lane
  marquee?: { x0: number; y0: number; x1: number; y1: number };
}

export function draw(ctx: CanvasRenderingContext2D, s: Scene) {
  const { width, height, song, view } = s;
  ctx.fillStyle = '#0d0d0f';
  ctx.fillRect(0, 0, width, height);
  if (!song) return;
  const m = model(song);
  const firstRow = Math.max(0, Math.floor(view.scrollRow));
  const lastRow = Math.ceil(view.scrollRow + (width - GUTTER) / view.rowWidth);
  const x = (row: number) => rowToX(view, row);

  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER, 0, width - GUTTER, height);
  ctx.clip();
  for (const box of s.boxes) {
    drawLaneBackground(ctx, s, box);
    if (box.expanded) {
      ctx.fillStyle = '#0f0f11';
      ctx.fillRect(GUTTER, stripTop(box), s.width - GUTTER, STRIP - 1);
      ctx.fillStyle = '#2a2a2e';
      ctx.fillRect(GUTTER, stripTop(box), s.width - GUTTER, 1);
    }
    drawGrid(ctx, s, box, firstRow, lastRow);
    drawPlacements(ctx, s, box, model(s.source ?? song).lanes[box.lane].placements);
    if (box.expanded && s.ghosts) drawGhosts(ctx, s, box, m);
    drawNotes(ctx, s, box, m.lanes[box.lane]);
    if (box.expanded) drawStrip(ctx, s, box, m.lanes[box.lane]);
    if (box.expanded) drawClips(ctx, s, box, model(s.source ?? song).lanes[box.lane].placements);
  }
  drawSongLane(ctx, s, m);
  drawErrors(ctx, s);
  if (s.marquee) {
    const { x0, y0, x1, y1 } = s.marquee;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }
  // Past the end of the song.
  const end = x(song.length);
  if (end < width) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(end, RULER, width - end, height - RULER);
  }
  drawRuler(ctx, s, firstRow, lastRow);
  if (s.playhead === undefined) {
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(Math.round(x(s.startRow)), RULER, 1, height - RULER);
  } else {
    const px = Math.round(x(s.playhead)) + 0.5;
    ctx.strokeStyle = '#7cf29a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
  }
  ctx.restore();
  drawGutter(ctx, s, m);
}

function drawLaneBackground(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox) {
  ctx.fillStyle = box.expanded ? '#141417' : '#111113';
  ctx.fillRect(GUTTER, box.top, s.width - GUTTER, box.height);
  if (box.expanded) {
    const top = s.view.pitchTop[box.lane];
    // With a scale, notes outside it are shaded instead of the black keys, and its root is tinted. Not on the
    // noise lane, whose pitches aren't notes.
    const scale = LANE_KIND[box.lane] === 'noise' ? undefined : s.scale;
    for (let note = Math.floor(top); note >= 0; note--) {
      const y = noteToY(box, top, note);
      if (y > box.top + box.height) break;
      if (scale ? !inScale(scale, note) : BLACK_KEYS.has(note % 12)) {
        ctx.fillStyle = scale ? '#0c0c0e' : '#101012';
        ctx.fillRect(GUTTER, y, s.width - GUTTER, NOTE_HEIGHT);
      } else if (scale && note % 12 === scale.root) {
        ctx.fillStyle = 'rgba(124,196,245,0.07)';
        ctx.fillRect(GUTTER, y, s.width - GUTTER, NOTE_HEIGHT);
      }
      if (note % 12 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(GUTTER, y + NOTE_HEIGHT - 1, s.width - GUTTER, 1);
      }
    }
  }
  ctx.fillStyle = '#2a2a2e';
  ctx.fillRect(GUTTER, box.top + box.height - 1, s.width - GUTTER, 1);
}

function drawGrid(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox, firstRow: number, lastRow: number) {
  const { grid } = s.song!;
  const bar = rowsPerBar(grid);
  const showRows = s.view.rowWidth >= 6;
  const showBeats = s.view.rowWidth * grid.rowsPerBeat >= 6;
  for (let row = firstRow; row <= lastRow; row++) {
    let alpha = 0;
    if (row % bar === 0) alpha = 0.14;
    else if (row % grid.rowsPerBeat === 0) alpha = showBeats ? 0.07 : 0;
    else alpha = showRows ? 0.03 : 0;
    if (!alpha) continue;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fillRect(Math.round(rowToX(s.view, row)), box.top, 1, box.height - 1);
  }
}

/** Placed patterns: a tinted band over each one's rows, edged at its start and end and marked faintly where each
 * repeat starts. In a collapsed lane its name is along the top; the expanded lane has the strip for that. */
function drawPlacements(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox, placements: DrawnPlacement[]) {
  const x = (row: number) => Math.round(rowToX(s.view, row));
  const top = box.expanded ? notesTop(box) : box.top;
  const bottom = box.expanded ? stripTop(box) : box.top + box.height - 1;
  ctx.save();
  for (const p of placements) {
    const left = x(p.start);
    const right = x(p.end);
    if (right < GUTTER || left > s.width) continue;
    ctx.fillStyle = 'rgba(124,196,245,0.07)';
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.fillStyle = 'rgba(124,196,245,0.45)';
    ctx.fillRect(left, top, 1, bottom - top);
    ctx.fillRect(right - 1, top, 1, bottom - top);
    ctx.fillStyle = 'rgba(124,196,245,0.2)';
    for (const r of p.repeats) ctx.fillRect(x(r), top, 1, bottom - top);
    if (!box.expanded) {
      ctx.fillStyle = 'rgba(124,196,245,0.8)';
      ctx.fillRect(left, top, right - left, 1);
      label(ctx, p.label, left, right, top, 'rgba(124,196,245,0.8)');
    }
  }
  if (box.expanded && s.target) {
    ctx.strokeStyle = 'rgba(124,196,245,0.9)';
    ctx.lineWidth = 1.5;
    const [left, right] = [x(s.target.start), x(s.target.end)];
    ctx.strokeRect(left + 0.75, top + 0.75, right - left - 1.5, bottom - top - 1.5);
  }
  ctx.restore();
}

/** The expanded lane's strip of placed patterns, handled like clips: a header for each, with its name, and the
 * selected one outlined. Drawn over the notes, so a note scrolled above the lane doesn't show through. */
function drawClips(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox, placements: DrawnPlacement[]) {
  const x = (row: number) => Math.round(rowToX(s.view, row));
  ctx.save();
  ctx.fillStyle = '#101013';
  ctx.fillRect(GUTTER, box.top, s.width - GUTTER, CLIPS);
  ctx.fillStyle = '#2a2a2e';
  ctx.fillRect(GUTTER, box.top + CLIPS - 1, s.width - GUTTER, 1);
  for (const p of placements) {
    const left = x(p.start);
    const right = x(p.end);
    if (right < GUTTER || left > s.width) continue;
    const selected = p.item === s.placement;
    ctx.fillStyle = selected ? 'rgba(124,196,245,0.55)' : 'rgba(124,196,245,0.28)';
    ctx.fillRect(left + 1, box.top + 1, right - left - 2, CLIPS - 3);
    ctx.fillStyle = 'rgba(124,196,245,0.9)';
    ctx.fillRect(right - 3, box.top + 1, 2, CLIPS - 3); // the edge to drag
    if (selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left + 1.75, box.top + 1.75, right - left - 3.5, CLIPS - 4.5);
    }
    label(ctx, p.label, left, right - 4, box.top + 2, selected ? '#ffffff' : 'rgba(225,240,255,0.95)');
  }
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, left: number, right: number, top: number, colour: string) {
  const room = right - Math.max(left, GUTTER) - 6;
  if (room <= 12) return;
  ctx.save();
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.rect(Math.max(left, GUTTER), top, room + 3, 13);
  ctx.clip();
  ctx.fillText(text, Math.max(left, GUTTER) + 3, top + 1);
  ctx.restore();
}

// The colour of an instrument's notes; the instrument panel shows it too.
export function noteColour(inst: number, light = 55, alpha = 1) {
  return `hsla(${HUES[(inst - 1 + HUES.length) % HUES.length]}, 70%, ${light}%, ${alpha})`;
}

function drawNotes(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox, lane: Model['lanes'][LaneName]) {
  const { view } = s;
  const x = (row: number) => rowToX(view, row);
  const pitchTop = view.pitchTop[box.lane];
  const span = Math.max(1, lane.high - lane.low);
  const y = (note: number) =>
    box.expanded
      ? noteToY(box, pitchTop, note) + 1
      : box.top + 6 + ((lane.high - note) / span) * (box.height - 16);
  const h = box.expanded ? NOTE_HEIGHT - 2 : 4;
  ctx.save();
  if (box.expanded) {
    ctx.beginPath();
    ctx.rect(GUTTER, notesTop(box), s.width - GUTTER, stripTop(box) - notesTop(box));
    ctx.clip();
  }
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const n of lane.notes) {
    const left = x(n.row);
    const right = x(n.end);
    if (right < GUTTER || left > s.width) continue;
    const top = y(n.note);
    if (top + h < box.top || top > box.top + box.height) continue;
    const w = Math.max(1, right - left - 1);
    ctx.fillStyle = noteColour(n.inst, n.legato ? 45 : 55, n.legato ? 0.75 : 1);
    ctx.fillRect(left, top, w, h);
    if (!n.legato && w > 3) {
      ctx.fillStyle = noteColour(n.inst, 80); // the attack
      ctx.fillRect(left, top, 2, h);
    }
    if (n.fx) {
      ctx.fillStyle = EFFECT;
      ctx.fillRect(left + 2, top, Math.min(4, w), 2);
    }
    if (box.expanded && s.selected.has(n.item)) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(left + 0.75, top + 0.75, Math.max(1, w - 1.5), h - 1.5);
    }
    if (box.expanded && w >= 28) {
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillText(noteName(n.note), left + 4, top + h / 2 + 0.5);
    }
  }
  ctx.restore();
  if (box.expanded) return; // the strip shows them
  for (const row of lane.effects) {
    const ex = x(row);
    if (ex < GUTTER - 4 || ex > s.width) continue;
    ctx.fillStyle = EFFECT;
    diamond(ctx, ex, box.top + 5, 3);
  }
}

/** The other tonal lanes' notes, faint, behind the expanded lane's own at the pitch they're named, as FL Studio's
 * ghost notes are, for writing one lane against another. The noise lane's pitches aren't notes, so it neither
 * shows them nor is shown. */
function drawGhosts(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox, m: Model) {
  if (LANE_KIND[box.lane] === 'noise') return;
  const { view } = s;
  const pitchTop = view.pitchTop[box.lane];
  ctx.save();
  ctx.beginPath();
  ctx.rect(GUTTER, notesTop(box), s.width - GUTTER, stripTop(box) - notesTop(box));
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  for (const lane of LANES) {
    if (lane === box.lane || LANE_KIND[lane] === 'noise') continue;
    for (const n of m.lanes[lane].notes) {
      const left = rowToX(view, n.row);
      const right = rowToX(view, n.end);
      if (right < GUTTER || left > s.width) continue;
      const top = noteToY(box, pitchTop, n.note) + 1;
      if (top + NOTE_HEIGHT < box.top || top > stripTop(box)) continue;
      const w = Math.max(1, right - left - 1);
      ctx.fillRect(left, top, w, NOTE_HEIGHT - 2);
      ctx.strokeRect(left + 0.5, top + 0.5, Math.max(1, w - 1), NOTE_HEIGHT - 3);
    }
  }
  ctx.restore();
}

/** The expanded lane's effects, a row each: volume as a bar over a baseline, others as a mark labelled when the
 * label fits before the next. Rows a note's end needs are a dim "end". */
function drawStrip(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox, lane: Model['lanes'][LaneName]) {
  const { view } = s;
  const top = stripTop(box);
  const bottom = box.top + box.height - 1;
  const x = (row: number) => rowToX(view, row);
  const w = Math.max(1, Math.min(view.rowWidth - 1, 10));
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const shown = (row: number) => x(row + 1) >= GUTTER && x(row) <= s.width;
  const marks = [...lane.strip.map((e) => e.row), ...lane.ends].sort((a, b) => a - b);
  const room = (row: number) => {
    const next = marks.find((r) => r > row);
    return (next === undefined ? s.width : x(next)) - x(row) - 4;
  };
  for (const row of lane.ends) {
    if (!shown(row)) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x(row), top + 6, Math.min(w, 3), bottom - top - 10);
    if (room(row) >= ctx.measureText('end').width + 6) ctx.fillText('end', x(row) + 5, top + (bottom - top) / 2);
  }
  for (const e of lane.strip) {
    if (!shown(e.row)) continue;
    const left = x(e.row);
    ctx.fillStyle = s.fxSelected.has(e.row) ? SELECTED_EFFECT : EFFECT;
    if (e.fx.volume !== undefined) {
      const h = volumeHeight(e.fx.volume);
      ctx.fillRect(left, bottom - 2 - h, w, h);
      continue;
    }
    ctx.fillRect(left, top + 5, Math.min(w, 3), bottom - top - 8);
    const label = shortEffect(e.fx).join(' ');
    if (room(e.row) >= ctx.measureText(label).width + 6) ctx.fillText(label, left + 5, top + (bottom - top) / 2);
  }
}

const TRACK_COLOURS: Record<GlobalKind, string> = { tempo: '#7cc4f5', pan: '#c4a5f5', masterVolume: '#f59e9e' };

/** Song-wide effects, a track per kind, so kinds on one row don't hide each other. */
function drawSongLane(ctx: CanvasRenderingContext2D, s: Scene, m: Model) {
  const { view } = s;
  const top = songLaneTop(s.boxes);
  const x = (row: number) => rowToX(view, row);
  ctx.fillStyle = '#121214';
  ctx.fillRect(GUTTER, top, s.width - GUTTER, SONG_LANE);
  ctx.fillStyle = '#2a2a2e';
  ctx.fillRect(GUTTER, top + SONG_LANE - 1, s.width - GUTTER, 1);
  const track = (SONG_LANE - 3) / 3;
  ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const [i, k] of GLOBAL_KINDS.entries()) {
    const y = top + 1 + i * track;
    const marks = m.globals[k];
    ctx.fillStyle = TRACK_COLOURS[k];
    for (const [j, g] of marks.entries()) {
      const left = x(g.row);
      if (x(g.row + 1) < GUTTER || left > s.width) continue;
      ctx.fillRect(left, y + 1, Math.max(1, Math.min(view.rowWidth - 1, 3)), track - 2);
      const next = marks[j + 1];
      const room = (next ? x(next.row) : s.width) - left - 4;
      if (room >= ctx.measureText(g.label).width + 6) ctx.fillText(g.label, left + 5, y + track / 2);
    }
  }
}

/** Compile errors with a row: that row's column tinted red, in its lane or the song lane. */
function drawErrors(ctx: CanvasRenderingContext2D, s: Scene) {
  const songTop = songLaneTop(s.boxes);
  for (const e of s.errors) {
    if (e.row === undefined) continue;
    const box = e.lane === 'global' ? { top: songTop, height: SONG_LANE } : s.boxes.find((b) => b.lane === e.lane);
    if (!box) continue;
    const left = rowToX(s.view, e.row);
    if (left > s.width || left + s.view.rowWidth < GUTTER) continue;
    const w = Math.max(2, s.view.rowWidth);
    ctx.fillStyle = 'rgba(239,68,68,0.22)';
    ctx.fillRect(left, box.top, w, box.height - 1);
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(left, box.top, w, 2);
  }
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
  ctx.fill();
}

function drawRuler(ctx: CanvasRenderingContext2D, s: Scene, firstRow: number, lastRow: number) {
  const { view } = s;
  const song = s.song!;
  const x = (row: number) => rowToX(view, row);
  ctx.fillStyle = '#18181b';
  ctx.fillRect(GUTTER, 0, s.width - GUTTER, RULER);
  ctx.fillStyle = '#2a2a2e';
  ctx.fillRect(GUTTER, RULER - 1, s.width - GUTTER, 1);
  // The rows dragged along the ruler, which play over and over while looping is on.
  if (s.loop) {
    const [lx, rx] = [Math.round(x(s.loop.start)), Math.round(x(s.loop.end))];
    ctx.fillStyle = s.looping ? 'rgba(96,165,250,0.3)' : 'rgba(255,255,255,0.07)';
    ctx.fillRect(lx, 0, rx - lx, RULER - 1);
    ctx.fillStyle = s.looping ? 'rgba(96,165,250,0.9)' : 'rgba(255,255,255,0.25)';
    ctx.fillRect(lx, 0, rx - lx, 2);
  }
  const bar = rowsPerBar(song.grid);
  const every = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, 28 / (bar * view.rowWidth))))); // bars per label
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let row = firstRow - (firstRow % bar); row <= lastRow; row += bar) {
    const n = row / bar;
    if (n % every) continue;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(Math.round(x(row)), 12, 1, RULER - 12);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(String(n + 1), x(row) + 3, 8);
  }
  // The loop: a bracket from the loop row to the end.
  const loopX = x(song.loop);
  const endX = x(song.length);
  ctx.fillStyle = 'rgba(124,242,154,0.18)';
  ctx.fillRect(loopX, RULER - 5, endX - loopX, 4);
  ctx.fillStyle = 'rgba(124,242,154,0.7)';
  ctx.fillRect(loopX, RULER - 9, 1, 8);
  ctx.fillRect(endX - 1, RULER - 9, 1, 8);
  // Where Play starts: a flag.
  const sx = Math.round(x(s.startRow));
  ctx.fillStyle = '#e4e4e7';
  ctx.fillRect(sx, 2, 1, RULER - 3);
  ctx.beginPath();
  ctx.moveTo(sx + 1, 2);
  ctx.lineTo(sx + 8, 6);
  ctx.lineTo(sx + 1, 10);
  ctx.closePath();
  ctx.fill();
}

function drawGutter(ctx: CanvasRenderingContext2D, s: Scene, m: Model) {
  ctx.fillStyle = '#18181b';
  ctx.fillRect(0, 0, GUTTER, s.height);
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (const box of s.boxes) {
    if (box.expanded) drawKeys(ctx, s, box);
    const count = m.lanes[box.lane].notes.length;
    ctx.fillStyle = s.silent.has(box.lane) ? 'rgba(255,255,255,0.3)' : box.expanded ? '#fafafa' : 'rgba(255,255,255,0.6)';
    ctx.fillText(LANE_TITLES[box.lane], 8, box.top + 6);
    if (!box.expanded) {
      // After the mute and solo buttons, which the roll puts over the gutter.
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(`${count} notes`, 44, box.top + LANE_BUTTONS + 2, GUTTER - 48); // squeezed, not spilling over
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    }
    if (box.expanded) {
      ctx.fillStyle = '#18181b';
      ctx.fillRect(0, stripTop(box), GUTTER, STRIP);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('Effects', 8, stripTop(box) + 7);
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    }
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(0, box.top + box.height - 1, GUTTER, 1);
  }
  const songTop = songLaneTop(s.boxes);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('Song', 8, songTop + 3);
  ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillText('tempo pan vol', 8, songTop + 17);
  ctx.fillStyle = '#2a2a2e';
  ctx.fillRect(0, songTop + SONG_LANE - 1, GUTTER, 1);
  ctx.fillRect(GUTTER - 1, 0, 1, s.height);
}

/** The expanded lane's keyboard, with the keys held down in the colour of the instrument they play, and a bar
 * beside the keys the computer keyboard plays. */
function drawKeys(ctx: CanvasRenderingContext2D, s: Scene, box: LaneBox) {
  const top = s.view.pitchTop[box.lane];
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, notesTop(box), GUTTER, box.height - CLIPS);
  ctx.clip();
  ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let note = Math.ceil(top); note >= 0; note--) {
    const y = noteToY(box, top, note);
    if (y > box.top + box.height) break;
    const black = BLACK_KEYS.has(note % 12);
    ctx.fillStyle = s.keysDown.notes.has(note) ? noteColour(s.keysDown.inst) : black ? '#27272a' : '#d4d4d8';
    ctx.fillRect(KEY_LEFT, y, GUTTER - KEY_LEFT - 1, NOTE_HEIGHT - 1);
    if (s.keyRange && note >= s.keyRange.low && note <= s.keyRange.high) {
      ctx.fillStyle = KEY_RANGE;
      ctx.fillRect(KEY_LEFT - 4, y, 3, NOTE_HEIGHT);
    }
    if (note % 12 === 0 && y >= box.top + LANE_HEADER) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(noteName(note), 8, y + NOTE_HEIGHT / 2);
    }
  }
  ctx.restore();
}
