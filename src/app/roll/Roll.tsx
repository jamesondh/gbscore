import { useEffect, useRef, useState } from 'react';
import { formatError, position } from '../../core/location.ts';
import { NOTE_COUNT, noteName } from '../../core/notes.ts';
import { expand } from '../../core/patterns.ts';
import { LANES, type LaneItem, type LaneName, type Song } from '../../core/schema.ts';
import * as edits from '../edit.ts';
import { PIANO, press, release } from '../entry.ts';
import { drawVolume as setVolumes, effectAt, endRows, globalAt, longEffect, moveEffects, setEffect, setGlobal } from '../effects.ts';
import { noteIndex } from '../song.ts';
import {
  arrangeGestureTo,
  audible,
  edit,
  editSong,
  endGesture,
  engine,
  gestureTo,
  hearNote,
  placeAt,
  removePlacement,
  select,
  selectEffects,
  selectPlacement,
  shown,
  setLoop,
  setPen,
  setStartRow,
  setView,
  startGesture,
  targetRow,
  toggleLane,
  useApp,
  type AppState,
  type View,
} from '../store.ts';
import { movePlacement, resizePlacement } from '../arrange.ts';
import { occurrenceOf } from '../placements.ts';
import { draw, type DrawnNote, LANE_TITLES, model } from './draw.ts';
import { LengthEdit } from './LengthEdit.tsx';
import { RowEdit, type RowPop } from './RowEdit.tsx';
import {
  clampPitchTop,
  clampScroll,
  GUTTER,
  KEY_LEFT,
  laneAt,
  LANE_BUTTONS,
  type LaneBox,
  laneBoxes,
  NOTE_HEIGHT,
  notesTop,
  noteToY,
  RULER,
  rowToX,
  SONG_LANE,
  songLaneTop,
  STRIP,
  stripTop,
  volumeAt,
  xToRow,
  yToNote,
  zoomAt,
} from './geometry.ts';

const PIANO_SPAN = Math.max(...Object.values(PIANO)); // semitones from A to the computer keyboard's top key

/** What a press on the roll is doing until it's let go. */
type Drag =
  | {
      kind: 'move';
      x0: number;
      y0: number;
      notes: LaneItem[];
      limits: ReturnType<typeof edits.moveLimits>;
      held: LaneItem; // the note pressed, heard again at each pitch it's dragged to
      heard: number; // semitones it was last heard at
    }
  | { kind: 'resize'; x0: number; notes: LaneItem[] }
  | { kind: 'draw'; x0: number; note: LaneItem; room: number }
  | { kind: 'erase'; x: number; y: number; gone: Set<LaneItem> }
  | {
      kind: 'paint';
      x0: number;
      y0: number;
      x: number;
      y: number;
      from: { row: number; len: number; inst: number };
      pitches: Map<number, number>; // each slot's pitch, slots counted in note lengths from the first
    }
  | { kind: 'select'; x0: number; y0: number; x1: number; y1: number; before: LaneItem[]; song: Song }
  | { kind: 'place'; x0: number; item: LaneItem; copy: boolean }
  | { kind: 'edge'; x0: number; item: LaneItem; rows: number } // a placement's right edge, dragged to change how long it plays
  | { kind: 'key'; box: LaneBox; note: number } // a key held on the keyboard, sounding
  | { kind: 'ruler'; x0: number; row: number; moved: boolean } // a click moves the flag, a drag sets the loop
  // On the effect strip a press is a click, which opens the row's popover, until it moves DRAG_PX.
  | { kind: 'volume'; box: LaneBox; row: number; x: number; y: number; moved: boolean; volumes: Map<number, number> }
  | { kind: 'fxMove'; x0: number; row: number; rows: number[]; moved: boolean }
  | { kind: 'fxSelect'; box: LaneBox; x0: number; x1: number; row: number; before: number[]; moved: boolean; song: Song };

const DRAG_PX = 3; // a press that moves less than this is a click

/** Points a pixel apart from one to another, so a fast drag doesn't skip the notes between pointer events: a note
 * can be as narrow as 3 px, or less where the gutter covers part of it. */
function along(x0: number, y0: number, x1: number, y1: number): { x: number; y: number }[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  return Array.from({ length: steps }, (_, i) => ({ x: x0 + ((x1 - x0) * (i + 1)) / steps, y: y0 + ((y1 - y0) * (i + 1)) / steps }));
}

/** The piano roll: a canvas redrawn whenever the state changes, and every frame while playing. */
export function Roll() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pop, setPop] = useState<RowPop>();
  const [rulerAt, setRulerAt] = useState<number>(); // the row of the ruler right-clicked, for the song's length and loop
  const [size, setSize] = useState(0); // the height, for placing the lanes' buttons

  useEffect(() => {
    const box = wrap.current!;
    const el = canvas.current!;
    const ctx = el.getContext('2d')!;
    let width = 0;
    let height = 0;
    let dirty = true;
    let frame = 0;
    let drag: Drag | undefined;

    const resize = () => {
      const r = box.getBoundingClientRect();
      width = r.width;
      height = r.height;
      el.width = Math.round(width * devicePixelRatio);
      el.height = Math.round(height * devicePixelRatio);
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      setSize(height);
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(box);
    const unsubscribe = useApp.subscribe(() => (dirty = true));

    let flag = useApp.getState().startRow;
    const render = () => {
      frame = requestAnimationFrame(render);
      const s = useApp.getState();
      // Keep the flag in view when it moves, as it does after each note entered or pasted.
      if (s.startRow !== flag && width) {
        flag = s.startRow;
        const visible = (width - GUTTER) / s.view.rowWidth;
        if (!s.playing && (flag < s.view.scrollRow || flag >= s.view.scrollRow + visible)) follow(flag, width);
      }
      let playhead: number | undefined;
      if (s.playing) {
        const p = engine().now();
        if (p) playhead = p.row + Math.min(p.tick, p.rowTicks - 1) / Math.max(1, p.rowTicks);
        if (playhead !== undefined) follow(playhead, width);
        dirty = true;
      }
      if (!dirty || !width) return;
      dirty = false;
      const boxes = laneBoxes(height, useApp.getState().view.expanded);
      const view = withPitchClamped(useApp.getState().view, boxes);
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      draw(ctx, {
        width,
        height,
        song: shown(s),
        source: s.open?.song,
        placement: s.placement,
        target: targetOf(s),
        view,
        boxes,
        startRow: s.startRow,
        loop: s.loop,
        looping: s.looping,
        playhead,
        selected: new Set(s.selection),
        fxSelected: new Set(s.fxSelection),
        errors: s.open?.errors ?? [],
        ghosts: s.ghosts,
        silent: new Set(LANES.filter((l) => !audible(s, l))),
        keysDown: { notes: new Set(s.keysDown), inst: s.pen[s.view.expanded].inst },
        keyRange: s.entry || s.playKeys ? { low: s.octave, high: s.octave + PIANO_SPAN } : undefined,
        scale: s.open ? s.scales[s.open.name] : undefined,
        marquee: drag?.kind === 'select' ? drag : drag?.kind === 'fxSelect' && drag.moved ? stripMarquee(drag) : undefined,
      });
    };
    render();

    // Trackpad: two-finger swipes scroll, pinches (which arrive as ctrl-wheel) zoom. A mouse wheel scrolls the
    // expanded lane's notes, or the rows with Shift.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, open } = useApp.getState();
      const length = open?.song?.length ?? 0;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (e.ctrlKey || e.metaKey) {
        const z = zoomAt(view, Math.max(GUTTER, x), Math.exp(-e.deltaY * 0.01));
        setView({ ...z, scrollRow: clampScroll({ ...view, ...z }, width, length, z.scrollRow) });
        return;
      }
      const lane = laneAt(laneBoxes(height, view.expanded), y);
      const vertical = Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey;
      if (vertical && lane?.expanded) {
        const shown = clampPitchTop(lane, view.pitchTop[lane.lane]);
        const top = clampPitchTop(lane, shown - e.deltaY / NOTE_HEIGHT);
        setView({ pitchTop: { ...view.pitchTop, [lane.lane]: top } });
      } else {
        const delta = (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX || e.deltaY) / view.rowWidth;
        setView({ scrollRow: clampScroll(view, width, length, view.scrollRow + delta) });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });

    // Where the canvas was when a drag began. A press can show or hide the bar above the roll, moving the canvas;
    // measuring the drag from where it began keeps that from reading as the pointer moving.
    let pressedAt: DOMRect | undefined;
    const at = (e: PointerEvent) => {
      const r = (drag && pressedAt) || el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    /** The expanded lane's box, with its pitch as drawn, if (x, y) is on its notes. */
    const expandedAt = (x: number, y: number) => {
      const { view } = useApp.getState();
      const box = laneAt(laneBoxes(height, view.expanded), y);
      if (!box?.expanded || x < GUTTER || y < notesTop(box) || y >= stripTop(box)) return undefined;
      return { box, pitchTop: clampPitchTop(box, view.pitchTop[box.lane]) };
    };
    /** The placement at (x, y) on the expanded lane's strip of placed patterns, and whether it's at its right edge,
     * or the row there if it's empty. */
    const clipAt = (x: number, y: number) => {
      const { view, open } = useApp.getState();
      const box = laneAt(laneBoxes(height, view.expanded), y);
      if (!box?.expanded || !open?.song || x < GUTTER || y >= notesTop(box)) return undefined;
      const row = xToRow(view, x);
      const placed = model(open.song).lanes[box.lane].placements.find((p) => row >= p.start && row < p.end);
      return { lane: box.lane, row, placed, edge: !!placed && x >= rowToX(view, placed.end) - 6 };
    };
    /** The expanded lane's box, if (x, y) is on its keyboard. */
    const keysAt = (x: number, y: number) => {
      const box = laneAt(laneBoxes(height, useApp.getState().view.expanded), y);
      return box?.expanded && x >= KEY_LEFT && x < GUTTER && y >= notesTop(box) && y < stripTop(box) ? box : undefined;
    };
    /** The note on the keyboard at y, kept to the lane's notes. */
    const keyAt = (box: LaneBox, y: number) => {
      const top = clampPitchTop(box, useApp.getState().view.pitchTop[box.lane]);
      const inside = Math.max(notesTop(box), Math.min(stripTop(box) - 1, y));
      return Math.max(0, Math.min(NOTE_COUNT - 1, yToNote(box, top, inside)));
    };
    /** The row and what's there, if (x, y) is on the expanded lane's effect strip or the song lane. */
    const rowAt = (x: number, y: number) => {
      const { view } = useApp.getState();
      const song = shown();
      const row = Math.floor(xToRow(view, x));
      if (!song || x < GUTTER || row < 0 || row >= song.length) return undefined;
      const boxes = laneBoxes(height, view.expanded);
      const songTop = songLaneTop(boxes);
      if (y >= songTop && y < songTop + SONG_LANE) return { kind: 'song' as const, row, y: songTop, song };
      const box = laneAt(boxes, y);
      if (box?.expanded && y >= stripTop(box)) return { kind: 'fx' as const, lane: box.lane, row, y: stripTop(box), song };
      return undefined;
    };
    /** Whether (x, y) is on a selected effect in the strip, where a drag moves the selection. */
    const fxSelected = (x: number, y: number) => {
      const onRow = rowAt(x, y);
      return onRow?.kind === 'fx' && useApp.getState().fxSelection.includes(onRow.row);
    };
    /** What hovering at (x, y) shows: an error there, or the effects on the strip or song lane. */
    const tooltip = (x: number, y: number): string => {
      const { view, open } = useApp.getState();
      const song = shown();
      if (song && x >= GUTTER && y < RULER) {
        const at = (row: number) => position(song.grid, row);
        return `The song ends at ${at(song.length)} and loops back to ${at(song.loop)}. Right-click to change.`;
      }
      if (!song || x < GUTTER || y < RULER) return '';
      const row = Math.floor(xToRow(view, x));
      const boxes = laneBoxes(height, view.expanded);
      const songTop = songLaneTop(boxes);
      const lane = y >= songTop && y < songTop + SONG_LANE ? 'global' : laneAt(boxes, y)?.lane;
      const lines = (open?.errors ?? []).filter((e) => e.row === row && e.lane === lane).map((e) => formatError(song.grid, e));
      const onRow = rowAt(x, y);
      if (onRow?.kind === 'fx') {
        const flat = expand(song).song; // as it plays, with patterns written out
        const { fx } = effectAt(flat, onRow.lane, row);
        const ender = endRows(flat, onRow.lane).get(row);
        if (fx) lines.push(longEffect(fx));
        if (ender) lines.push(`${ender.note}'s end`);
      } else if (onRow?.kind === 'song') {
        const g = globalAt(song, row);
        if (g.tempo !== undefined) lines.push(`Tempo ${g.tempo} ticks a row`);
        if (g.pan) lines.push(`Pan ${g.pan.join(' ')}`);
        if (g.masterVolume) lines.push(`Master volume ${g.masterVolume.join(', ')}`);
      }
      return lines.join('\n');
    };
    const hit = (x: number, y: number) => {
      const lane = expandedAt(x, y);
      const song = shown();
      return lane && song ? noteAt(looseNotes(song, lane.box.lane, targetOf(useApp.getState())), lane, useApp.getState().view, x, y) : undefined;
    };
    /** Any note under (x, y), in a pattern or not: a press there makes its place the target, then picks it up. */
    const hover = (x: number, y: number) => {
      const lane = expandedAt(x, y);
      const song = shown();
      return lane && song ? noteAt(model(song).lanes[lane.box.lane].notes, lane, useApp.getState().view, x, y) : undefined;
    };

    // Click on space to draw a note, and drag to set its length. Drag a note to move the selection, or its end to
    // resize it. Shift-click adds a note to the selection or takes it out; Shift-drag selects what it covers.
    // Right-click deletes, and right-drag deletes every note it passes over. Alt-drag from space paints notes of the
    // pen's length along the drag, each at the pitch under the pointer. On the ruler, a click moves the flag, a
    // drag loops the beats it covers, and a right-click sets the song's length and loop at the nearest beat.
    const onPointerDown = (e: PointerEvent) => {
      const { view, open, pen } = useApp.getState();
      pressedAt = el.getBoundingClientRect();
      const { x, y } = at(e);
      setRulerAt(undefined);
      if (y < RULER && x >= GUTTER) {
        if (e.button === 2 && open?.song) {
          const beat = open.song.grid.rowsPerBeat;
          setPop(undefined);
          setRulerAt(Math.max(0, Math.round(xToRow(view, x) / beat) * beat));
        }
        if (e.button !== 0) return;
        el.setPointerCapture(e.pointerId);
        drag = { kind: 'ruler', x0: x, row: Math.floor(xToRow(view, x)), moved: false };
        return;
      }
      const box = laneAt(laneBoxes(height, view.expanded), y);
      if (box && !box.expanded) {
        setView({ expanded: box.lane });
        return;
      }
      // The keyboard: a key plays its note while it's held, and dragging along the keys plays each one passed.
      const keys = keysAt(x, y);
      if (keys) {
        if (e.button !== 0) return;
        el.setPointerCapture(e.pointerId);
        drag = { kind: 'key', box: keys, note: keyAt(keys, y) };
        press('pointer', drag.note, true);
        return;
      }
      // The strip and the song lane: click edits a row in a popover, right-click clears it.
      // On the strip, a click opens the popover when it's let go; Shift selects effects, a drag on a selected one
      // moves them, and any other drag draws volume (docs/editor/, "Effect strip").
      const onRow = rowAt(x, y);
      setPop(undefined);
      if (onRow) {
        const { kind, row } = onRow;
        if (kind === 'fx' && !targetRow(row)) return; // the effect strip edits the place a pattern plays there, too
        if (e.button === 0 && kind === 'fx') {
          el.setPointerCapture(e.pointerId);
          const box = laneAt(laneBoxes(height, view.expanded), y)!;
          const { fxSelection } = useApp.getState(); // after the target, which a new one clears
          if (e.shiftKey) drag = { kind: 'fxSelect', box, x0: x, x1: x, row, before: fxSelection, moved: false, song: shown()! };
          else if (fxSelection.includes(row)) drag = { kind: 'fxMove', x0: x, row, rows: fxSelection, moved: false };
          else drag = { kind: 'volume', box, row, x, y, moved: false, volumes: new Map() };
        } else if (e.button === 0) setPop({ kind: 'song', row, y: onRow.y });
        else if (e.button === 2 && kind === 'fx') edit((song, lane, sel) => setEffect(song, lane, row, undefined, sel));
        else if (e.button === 2) editSong((song) => setGlobal(song, row, {}));
        return;
      }
      // The strip of placed patterns: click one to select it, drag to move it (by rows with Shift), Alt-drag to copy
      // it, drag its right edge to make it play longer or shorter, right-click to remove it. A click where there's
      // none places the current pattern there, at the beat.
      const clip = clipAt(x, y);
      if (clip) {
        if (!clip.placed) {
          selectPlacement(undefined);
          const beat = open?.song?.grid.rowsPerBeat ?? 1;
          if (e.button === 0) placeAt(Math.floor(clip.row / beat) * beat);
          return;
        }
        selectPlacement(clip.placed.item);
        if (e.button === 2) removePlacement();
        else if (e.button === 0 && startGesture()) {
          el.setPointerCapture(e.pointerId);
          drag = clip.edge
            ? { kind: 'edge', x0: x, item: clip.placed.item, rows: clip.placed.end - clip.placed.start }
            : { kind: 'place', x0: x, item: clip.placed.item, copy: e.altKey };
        }
        return;
      }
      const lane = expandedAt(x, y);
      if (!lane || !open?.song) return;
      // What's under the pointer becomes the target of edits first: the place a pattern plays there, or the loose
      // notes. Then the press works on that.
      if (!targetRow(Math.floor(xToRow(view, x)))) return;
      const { selection } = useApp.getState(); // a new target has none
      const song = shown();
      if (!song) return;
      const target = hit(x, y);
      if (e.button === 2) {
        if (!startGesture()) return;
        el.setPointerCapture(e.pointerId);
        drag = { kind: 'erase', x, y, gone: new Set() };
        erase(drag, [{ x, y }]);
        return;
      }
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      if (e.shiftKey) {
        if (target) {
          const item = target.note.item;
          select(selection.includes(item) ? selection.filter((i) => i !== item) : [...selection, item]);
        } else drag = { kind: 'select', x0: x, y0: y, x1: x, y1: y, before: selection, song };
        return;
      }
      const name = lane.box.lane;
      if (target) {
        const item = target.note.item;
        const notes = selection.includes(item) ? selection : [item];
        select(notes); // first, so a drag that comes back to where it began leaves these selected
        setPen(name, { inst: item.inst ?? pen[name].inst, len: item.len ?? 1 });
        if (!startGesture()) return;
        hearNote(name, item);
        drag = target.end
          ? { kind: 'resize', x0: x, notes }
          : { kind: 'move', x0: x, y0: y, notes, limits: edits.moveLimits(song, notes), held: item, heard: 0 };
        return;
      }
      const row = Math.floor(xToRow(view, x));
      const pitch = yToNote(lane.box, lane.pitchTop, y);
      if (row < 0 || row >= song.length || pitch < 0 || pitch >= NOTE_COUNT || !startGesture()) return;
      if (e.altKey) {
        drag = { kind: 'paint', x0: x, y0: y, x, y, from: { row, len: pen[name].len, inst: pen[name].inst }, pitches: new Map() };
        paint(drag, [{ x, y }]);
        return;
      }
      const room = song.length - row;
      const note = { row, len: Math.min(pen[name].len, room), note: noteName(pitch), inst: pen[name].inst };
      gestureTo((song, lane) => edits.draw(song, lane, note));
      hearNote(name, useApp.getState().selection[0] ?? note); // as placed, with an effect it took from its row
      drag = { kind: 'draw', x0: x, note, room };
    };

    /** Deletes the notes at the points, with what the erase drag has deleted so far. */
    const erase = (d: Extract<Drag, { kind: 'erase' }>, points: { x: number; y: number }[]) => {
      const before = d.gone.size;
      for (const p of points) {
        const target = hit(p.x, p.y);
        if (target) d.gone.add(target.note.item);
      }
      if (d.gone.size !== before) gestureTo((song, lane) => edits.remove(song, lane, [...d.gone]));
    };

    /** Paints the slots at the points, each at the pitch there, and hears the last one that changed. */
    const paint = (d: Extract<Drag, { kind: 'paint' }>, points: { x: number; y: number }[]) => {
      const { view, open } = useApp.getState();
      const lane = expandedAt(d.x0, d.y0);
      if (!lane || !open?.song) return;
      let changed: number | undefined;
      for (const p of points) {
        if (expandedAt(p.x, p.y)?.box.lane !== lane.box.lane) continue; // off the notes, as on the strip: no pitch there
        const slot = Math.floor((xToRow(view, p.x) - d.from.row) / d.from.len);
        const pitch = Math.max(0, Math.min(NOTE_COUNT - 1, yToNote(lane.box, lane.pitchTop, p.y)));
        if (d.pitches.get(slot) === pitch) continue;
        d.pitches.set(slot, pitch);
        changed = slot;
      }
      if (changed === undefined) return;
      gestureTo((song, name) => edits.drawAll(song, name, edits.paintRun(song, d.from, d.pitches)));
      const row = d.from.row + changed * d.from.len;
      const heard = useApp.getState().selection.find((n) => n.row === row);
      if (heard) hearNote(lane.box.lane, heard);
    };

    /** Draws volume at the points, each on the row it's over, and hears the note whose volume changed last. */
    const drawVolume = (d: Extract<Drag, { kind: 'volume' }>, points: { x: number; y: number }[]) => {
      const { view } = useApp.getState();
      const rows: number[] = [];
      for (const p of points) {
        const row = Math.floor(xToRow(view, p.x));
        const volume = volumeAt(d.box, p.y);
        if (d.volumes.get(row) === volume) continue;
        d.volumes.set(row, volume);
        rows.push(row);
      }
      if (!rows.length) return;
      const before = shown();
      // A stroke that changes nothing leaves the song as it was, so it isn't a step of undo.
      gestureTo((song, lane, selection) => {
        const r = setVolumes(song, lane, d.volumes, selection);
        return r.song === song ? undefined : r;
      });
      // Hear the note whose volume this changed last, of the rows passed, which may be empty or kept.
      const after = shown();
      const volume = (song: Song | undefined, row: number) => song && effectAt(song, d.box.lane, row).fx?.volume;
      const heard = rows.findLast((row) => volume(before, row) !== volume(after, row));
      const inside = heard === undefined ? undefined : effectAt(after!, d.box.lane, heard).inside;
      if (inside) hearNote(d.box.lane, inside);
    };

    /** The rows of the target's effects in the expanded lane: its loose items, or the open place a pattern plays. */
    const targetEffects = (lane: LaneName) => {
      const s = useApp.getState();
      const song = shown(s);
      const target = targetOf(s);
      return (song?.lanes[lane] ?? [])
        .filter((i) => i.fx && i.pattern === undefined && (!target || (i.row >= target.start && i.row < target.end)))
        .map((i) => i.row);
    };

    const onPointerMove = (e: PointerEvent) => {
      const { x, y } = at(e);
      if (!drag) {
        const target = hover(x, y);
        const clip = clipAt(x, y);
        el.style.cursor = clip
          ? clip.edge
            ? 'ew-resize'
            : clip.placed
              ? 'grab'
              : 'copy'
          : target
            ? target.end
              ? 'ew-resize'
              : 'move'
            : fxSelected(x, y)
              ? 'move'
              : rowAt(x, y) || keysAt(x, y)
                ? 'pointer'
                : '';
        const title = tooltip(x, y);
        if (el.title !== title) el.title = title;
        return;
      }
      const { view } = useApp.getState();
      const d = drag;
      if ((d.kind === 'volume' || d.kind === 'fxMove' || d.kind === 'fxSelect') && !d.moved) {
        const [x0, y0] = d.kind === 'volume' ? [d.x, d.y] : [d.x0, y];
        if (Math.hypot(x - x0, y - y0) < DRAG_PX) return;
        if (d.kind !== 'fxSelect' && !startGesture()) {
          drag = undefined;
          return;
        }
        d.moved = true;
      }
      if (d.kind === 'volume') {
        drawVolume(d, [{ x: d.x, y: d.y }, ...along(d.x, d.y, x, y)]);
        Object.assign(d, { x, y });
        return;
      }
      if (d.kind === 'fxMove') {
        const by = Math.round((x - d.x0) / view.rowWidth);
        gestureTo((song, lane) => (by ? moveEffects(song, lane, d.rows, by) : undefined));
        return;
      }
      if (d.kind === 'fxSelect') {
        if (shown() !== d.song) {
          drag = undefined; // edited or reloaded meanwhile: the selection it started from is gone
          dirty = true;
          return;
        }
        d.x1 = x;
        const [from, to] = [Math.min(d.x0, x), Math.max(d.x0, x)].map((px) => Math.floor(xToRow(view, px)));
        selectEffects([...d.before, ...targetEffects(d.box.lane).filter((r) => r >= from! && r <= to!)]);
        dirty = true;
        return;
      }
      if (d.kind === 'key') {
        const note = keyAt(d.box, y);
        if (note === d.note) return;
        release('pointer');
        press('pointer', (d.note = note), true);
        return;
      }
      if (d.kind === 'ruler') {
        const song = useApp.getState().open?.song;
        if (!song || (!d.moved && Math.abs(x - d.x0) < DRAG_PX)) return;
        d.moved = true;
        const beat = song.grid.rowsPerBeat;
        const beatOf = (row: number) => Math.floor(Math.max(0, row) / beat);
        const [from, to] = [beatOf(d.row), beatOf(xToRow(view, x))];
        const start = Math.min(from, to) * beat;
        const end = Math.min(song.length, (Math.max(from, to) + 1) * beat);
        if (start < end) setLoop(start, end);
        return;
      }
      if (d.kind === 'erase' || d.kind === 'paint') {
        if (d.kind === 'erase') erase(d, along(d.x, d.y, x, y));
        else paint(d, along(d.x, d.y, x, y));
        Object.assign(d, { x, y });
        return;
      }
      if (d.kind === 'select') {
        Object.assign(d, { x1: x, y1: y });
        const lane = expandedAt(d.x0, d.y0);
        const song = shown();
        if (song !== d.song) {
          drag = undefined; // edited or reloaded meanwhile: the selection it started from is gone
          dirty = true;
          return;
        }
        if (!lane || !song) return;
        const inside = looseNotes(song, lane.box.lane, targetOf(useApp.getState())).filter((n) => {
          const [left, right] = [rowToX(view, n.row), rowToX(view, n.end)];
          const top = noteToY(lane.box, lane.pitchTop, n.note);
          return right > Math.min(d.x0, x) && left < Math.max(d.x0, x) && top + NOTE_HEIGHT > Math.min(d.y0, y) && top < Math.max(d.y0, y);
        });
        select([...new Set([...d.before, ...inside.map((n) => n.item)])]);
        dirty = true;
        return;
      }
      const rows = Math.round((x - d.x0) / view.rowWidth);
      if (d.kind === 'place') {
        const beat = useApp.getState().open?.song?.grid.rowsPerBeat ?? 1;
        const by = e.shiftKey ? rows : Math.round(rows / beat) * beat; // placements move by beats, or rows with Shift
        arrangeGestureTo((song, lane) => (by ? movePlacement(song, lane, d.item, by, d.copy) : { song, placement: d.item }));
        return;
      }
      if (d.kind === 'edge') {
        const song = useApp.getState().open?.song;
        if (!song) return;
        // The end snaps to beats, and to the song's end within a beat of it.
        const beat = song.grid.rowsPerBeat;
        const end = d.item.row + d.rows + (x - d.x0) / view.rowWidth;
        const snapped = Math.abs(end - song.length) < beat ? song.length : Math.round(end / beat) * beat;
        const length = Math.max(1, Math.min(song.length, snapped) - d.item.row);
        arrangeGestureTo((song, lane) => (length === d.rows ? { song, placement: d.item } : resizePlacement(song, lane, d.item, length)));
        return;
      }
      if (d.kind === 'move') {
        const [lo, hi] = d.limits.rows;
        const [down, up] = d.limits.semitones;
        const by = Math.max(lo, Math.min(hi, rows));
        const semitones = Math.max(down, Math.min(up, Math.round((d.y0 - y) / NOTE_HEIGHT)));
        gestureTo((song, lane) => {
          if (!by && !semitones) return undefined;
          const r = edits.move(song, lane, d.notes, by, semitones);
          return typeof r === 'string' ? undefined : r;
        });
        if (semitones !== d.heard) {
          d.heard = semitones;
          hearNote(view.expanded, { ...d.held, row: d.held.row + by, note: noteName(noteIndex(d.held.note!) + semitones) });
        }
      } else if (d.kind === 'resize') {
        gestureTo((song, lane) => (rows ? edits.resize(song, lane, d.notes, rows) : undefined));
      } else if (Math.abs(x - d.x0) >= DRAG_PX) {
        const len = Math.max(1, Math.min(d.room, Math.ceil(xToRow(view, x)) - d.note.row));
        gestureTo((song, lane) => edits.draw(song, lane, { ...d.note, len }));
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const d = drag;
      drag = undefined;
      if (!d) return;
      const released = e.type === 'pointerup'; // not a press the browser took over
      if (d.kind === 'key') release('pointer');
      else if ((d.kind === 'volume' || d.kind === 'fxMove') && !d.moved) {
        if (!released) return;
        // A click: the row's popover, keeping the effects selected only if it's one of them.
        if (d.kind === 'volume' && useApp.getState().fxSelection.length) selectEffects([]);
        const box = laneBoxes(height, useApp.getState().view.expanded).find((b) => b.expanded)!;
        setPop({ kind: 'fx', lane: box.lane, row: d.row, y: stripTop(box) });
      } else if (d.kind === 'fxSelect') {
        dirty = true;
        if (d.moved || !released) return;
        const { fxSelection } = useApp.getState();
        if (fxSelection.includes(d.row)) selectEffects(fxSelection.filter((r) => r !== d.row));
        else if (targetEffects(d.box.lane).includes(d.row)) selectEffects([...fxSelection, d.row]);
      } else if (d.kind === 'ruler') {
        if (!d.moved && released) setStartRow(d.row);
      } else if (d.kind === 'select') dirty = true;
      else {
        if (d.kind === 'draw') {
          const drawn = useApp.getState().selection[0];
          if (drawn?.len) setPen(useApp.getState().view.expanded, { len: drawn.len });
        }
        endGesture();
      }
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    const noMenu = (e: Event) => e.preventDefault();
    el.addEventListener('contextmenu', noMenu);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('contextmenu', noMenu);
    };
  }, []);

  return (
    <div ref={wrap} className="relative min-h-0 flex-1 overflow-hidden">
      <canvas ref={canvas} className="absolute inset-0" />
      <LaneButtons height={size} />
      <RowEdit pop={pop} onChange={setPop} />
      <LengthEdit row={rulerAt} onClose={() => setRulerAt(undefined)} />
    </div>
  );
}

/** Each lane's mute and solo buttons, over the gutter under its name. */
function LaneButtons({ height }: { height: number }) {
  const expanded = useApp((s) => s.view.expanded);
  const mute = useApp((s) => s.mute);
  const solo = useApp((s) => s.solo);
  if (!height) return null;
  const button = 'absolute flex h-3.5 w-4 items-center justify-center rounded-sm text-[9px] leading-none font-semibold';
  return laneBoxes(height, expanded).map(({ lane, top }) => (
    <div key={lane}>
      <button
        type="button"
        aria-pressed={mute[lane]}
        aria-label={`Mute ${LANE_TITLES[lane]}`}
        title={`Mute ${LANE_TITLES[lane]} while the song plays`}
        className={`${button} bg-zinc-800 text-zinc-400 hover:bg-zinc-700 aria-pressed:bg-red-500 aria-pressed:text-white`}
        style={{ left: 6, top: top + LANE_BUTTONS }}
        onClick={() => toggleLane('mute', lane)}
      >
        M
      </button>
      <button
        type="button"
        aria-pressed={solo[lane]}
        aria-label={`Solo ${LANE_TITLES[lane]}`}
        title={`Solo ${LANE_TITLES[lane]}: play only the soloed lanes`}
        className={`${button} bg-zinc-800 text-zinc-400 hover:bg-zinc-700 aria-pressed:bg-amber-400 aria-pressed:text-black`}
        style={{ left: 24, top: top + LANE_BUTTONS }}
        onClick={() => toggleLane('solo', lane)}
      >
        S
      </button>
    </div>
  ));
}

/** The rectangle a Shift-drag along the effect strip covers. */
function stripMarquee(d: { box: LaneBox; x0: number; x1: number }) {
  const top = stripTop(d.box);
  return { x0: d.x0, y0: top + 1, x1: d.x1, y1: top + STRIP - 2 };
}

/** The view with the expanded lane's pitch kept in range for the lane's current height. */
function withPitchClamped(view: View, boxes: LaneBox[]): View {
  const box = boxes.find((b) => b.expanded)!;
  return { ...view, pitchTop: { ...view.pitchTop, [box.lane]: clampPitchTop(box, view.pitchTop[box.lane]) } };
}

/** Pages the view along as the playhead nears the right edge, or when it's out of view. */
function follow(playhead: number, width: number) {
  const { view } = useApp.getState();
  const visible = (width - GUTTER) / view.rowWidth;
  if (playhead < view.scrollRow || playhead > view.scrollRow + visible * 0.9) {
    setView({ scrollRow: Math.max(0, playhead - visible * 0.1) });
  }
}

/** The note under (x, y) in the expanded lane, and whether it's at its end, where dragging resizes it. */
/** The notes in a lane that can be picked and edited as notes: the target's. That's the loose notes, or with a place
 * a pattern plays as the target, its notes, which the view shows as the lane's. */
const looseNotes = (song: Song, lane: LaneName, target: Target | undefined) =>
  model(song).lanes[lane].notes.filter((n) => n.pattern === undefined && (!target || (n.row >= target.start && n.row < target.end)));

interface Target {
  start: number;
  end: number;
}

/** Where the target of edits is, if it's a place a pattern plays. */
function targetOf(s: AppState): Target | undefined {
  const song = s.open?.song;
  const occ = song && s.opened && occurrenceOf(song, s.opened);
  return occ ? { start: occ.start, end: occ.start + occ.length } : undefined;
}

export function noteAt(
  notes: DrawnNote[],
  lane: { box: LaneBox; pitchTop: number },
  view: View,
  x: number,
  y: number,
): { note: DrawnNote; end: boolean } | undefined {
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i]!;
    const left = rowToX(view, n.row);
    const right = Math.max(left + 3, rowToX(view, n.end));
    const top = noteToY(lane.box, lane.pitchTop, n.note);
    if (x < left || x >= right || y < top || y >= top + NOTE_HEIGHT) continue;
    return { note: n, end: x >= right - Math.min(6, (right - left) / 3) };
  }
  return undefined;
}
