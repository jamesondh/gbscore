import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { position } from '../../core/location.ts';
import { expand, occurrenceAt } from '../../core/patterns.ts';
import { LANE_KIND, LANES, PAN_NAMES, type Effect, type LaneName, type Song } from '../../core/schema.ts';
import { TICK_RATE } from '../../play/player.ts';
import { Button } from '../components/ui/button.tsx';
import { Popover, PopoverAnchor, PopoverContent } from '../components/ui/popover.tsx';
import { Choice } from '../controls.tsx';
import { EffectEditor } from '../EffectEditor.tsx';
import { bpm, effectAt, endRows, globalAt, type GlobalRow, longEffect, setCutTick, setEffect, setGlobal, ticksAt } from '../effects.ts';
import { noteEnd } from '../edit.ts';
import { edit, editSong, hearNote, shown, targetRow, useApp } from '../store.ts';
import { LANE_TITLES } from './draw.ts';
import { rowToX } from './geometry.ts';

// The popovers that edit a row's effect in the expanded lane's strip, or a row of the song lane (docs/editor/,
// "Effects on the timeline"). They open at the row clicked; ‹ and › step a row, for rows too narrow to click.

export type RowPop = { kind: 'fx'; lane: LaneName; row: number; y: number } | { kind: 'song'; row: number; y: number };

export function RowEdit({ pop, onChange }: { pop: RowPop | undefined; onChange: (pop: RowPop | undefined) => void }) {
  const view = useApp((s) => s.view);
  const song = useApp((s) => shown(s)); // with a pattern open, its notes are the lane's there
  const open = !!pop && !!song && pop.row < song.length && (pop.kind === 'song' || pop.lane === view.expanded);
  useEffect(() => {
    if (pop && !open) onChange(undefined);
  }, [pop, open, onChange]);
  if (!pop || !song || !open) return null;
  const step = (by: number) => {
    const row = Math.max(0, Math.min(song.length - 1, pop.row + by));
    if (pop.kind === 'fx' && !targetRow(row)) return; // the row's place a pattern plays becomes the target, as a press makes it
    onChange({ ...pop, row });
  };
  const where = `${position(song.grid, pop.row)} (row ${pop.row})`;
  return (
    <Popover open onOpenChange={(o) => !o && onChange(undefined)}>
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute size-0"
          style={{ left: rowToX(view, pop.row) + view.rowWidth / 2, top: pop.y }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        className="w-72"
        // A press on the roll opens another row, or closes this, itself.
        onPointerDownOutside={(e) => (e.target as Element).tagName === 'CANVAS' && e.preventDefault()}
      >
        <div className="mb-2 flex items-center gap-1 text-xs">
          <p className="flex-1 font-medium">
            {pop.kind === 'fx' ? LANE_TITLES[pop.lane] : 'Song'} · {where}
          </p>
          <Button size="icon-xs" variant="ghost" aria-label="Row before" disabled={pop.row === 0} onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Row after"
            disabled={pop.row >= song.length - 1}
            onClick={() => step(1)}
          >
            <ChevronRight />
          </Button>
        </div>
        {pop.kind === 'fx' ? (
          <LaneRow key={`${pop.lane}:${pop.row}`} song={song} lane={pop.lane} row={pop.row} />
        ) : (
          <SongRow key={pop.row} song={song} row={pop.row} />
        )}
      </PopoverContent>
    </Popover>
  );
}

let hearing: ReturnType<typeof setTimeout> | undefined;

/** Hears the note a row is in, once changes stop for a moment, as instrument changes are heard. */
function hearRowSoon(lane: LaneName, row: number) {
  clearTimeout(hearing);
  hearing = setTimeout(() => {
    const { view } = useApp.getState();
    const song = shown();
    const inside = song && view.expanded === lane ? effectAt(song, lane, row).inside : undefined;
    if (inside) hearNote(lane, inside);
  }, 150);
}

function LaneRow({ song, lane, row }: { song: Song; lane: LaneName; row: number }) {
  const placed = occurrenceAt(expand(song).occurrences, lane, row);
  if (placed) {
    return (
      <p className="text-xs text-muted-foreground">
        Pattern {placed.pattern.id} plays here, at its row {row - placed.start}, in a repeat cut short. Edit its effects where it plays
        whole.
      </p>
    );
  }
  return <LooseRow song={song} lane={lane} row={row} />;
}

function LooseRow({ song, lane, row }: { song: Song; lane: LaneName; row: number }) {
  const { fx, note, inside } = effectAt(song, lane, row);
  const ender = endRows(expand(song).song, lane).get(row); // a pattern's note can end here too
  const loose = !!ender && song.lanes[lane].includes(ender);
  const at = (r: number) => position(song.grid, r);
  // A loose note whose last row this is can end at a tick of it, which takes the row's effect slot.
  const ending =
    inside && inside.cutTick === undefined && song.lanes[lane].includes(inside) && Math.min(noteEnd(inside), song.length) - 1 === row
      ? inside
      : undefined;
  const change = (next: Effect | undefined) => {
    if (edit((s, _lane, selection) => setEffect(s, lane, row, next, selection))) hearRowSoon(lane, row);
  };
  return (
    <div className="space-y-2 text-xs">
      <p className="text-muted-foreground">
        {note
          ? `The first row of ${note.note}: the effect is the note's.`
          : inside
            ? `Inside ${inside.note} at ${at(inside.row)}: the effect moves with the note.`
            : 'Outside any note.'}
      </p>
      {ender && (
        <div className="space-y-1.5 rounded-md bg-muted/50 p-2">
          <p>
            {ender.note} at {at(ender.row)} ends here
            {ender.cutTick === undefined
              ? ': the driver cuts it on this row, which takes the effect slot. Change its length, or cut it at a tick of its last row, to put an effect here.'
              : `, at tick ${ender.cutTick} of this row, which takes the effect slot.`}
          </p>
          {ender.cutTick !== undefined && loose && (
            <CutTick
              value={ender.cutTick}
              ticks={ticksAt(song, row)}
              onChange={(t) => edit((s, _lane, selection) => setCutTick(s, lane, ender, t, selection))}
            />
          )}
        </div>
      )}
      {ending && (
        <div className="space-y-1.5 rounded-md bg-muted/50 p-2">
          {fx ? (
            <p>
              {ending.note} at {at(ending.row)} ends on this row. To cut it at a tick of the row, remove the {longEffect(fx)} here
              first: the cut takes the row's effect slot.
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <p className="flex-1">
                {ending.note} at {at(ending.row)} ends on this row.
              </p>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  edit((s, _lane, selection) => setCutTick(s, lane, ending, Math.floor(ticksAt(s, row) / 2), selection))
                }
              >
                Cut at a tick
              </Button>
            </div>
          )}
        </div>
      )}
      {(!ender || fx) && (
        <EffectEditor
          kind={LANE_KIND[lane]}
          inTable={false}
          value={fx}
          exclude={inside ? ['cut'] : []}
          ticks={ticksAt(song, row)}
          onChange={change}
        />
      )}
    </div>
  );
}

function CutTick({ value, ticks, onChange }: { value: number; ticks: number; onChange: (t: number | undefined) => void }) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Cut at tick</span>
        <input
          type="number"
          aria-label="Cut at tick"
          min={0}
          max={ticks - 1}
          value={value}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            if (Number.isInteger(n) && n >= 0 && n < ticks) onChange(n);
          }}
          className="h-7 w-14 rounded-md border border-input bg-background px-1.5 tabular-nums"
        />
      </label>
      <Button size="xs" variant="ghost" onClick={() => onChange(undefined)}>
        At the next row
      </Button>
    </div>
  );
}

function SongRow({ song, row }: { song: Song; row: number }) {
  const g = globalAt(song, row);
  const set = (change: GlobalRow) => editSong((s) => setGlobal(s, row, { ...globalAt(s, row), ...change }));
  return (
    <div className="space-y-3 text-xs">
      <Section label="Tempo" on={g.tempo !== undefined} onToggle={(on) => set({ tempo: on ? ticksAt(song, row) : undefined })}>
        {g.tempo !== undefined && <Tempo song={song} value={g.tempo} onChange={(tempo) => set({ tempo })} />}
      </Section>
      <Section label="Pan" on={!!g.pan} onToggle={(on) => set({ pan: on ? ['LR', 'LR', 'LR', 'LR'] : undefined })}>
        {g.pan && (
          <div className="grid grid-cols-[4rem_auto] items-center gap-1">
            {LANES.map((lane, i) => {
              const bits = PAN_NAMES.indexOf(g.pan![i]!);
              const toggle = (bit: number) => {
                const pan = [...g.pan!] as NonNullable<GlobalRow['pan']>;
                pan[i] = PAN_NAMES[bits ^ bit]!;
                set({ pan });
              };
              return [
                <span key={`${lane}-name`} className="text-muted-foreground">
                  {LANE_TITLES[lane]}
                </span>,
                <div key={lane} className="flex gap-1">
                  <Toggle label={`${LANE_TITLES[lane]} left`} on={!!(bits & 2)} onClick={() => toggle(2)}>
                    L
                  </Toggle>
                  <Toggle label={`${LANE_TITLES[lane]} right`} on={!!(bits & 1)} onClick={() => toggle(1)}>
                    R
                  </Toggle>
                </div>,
              ];
            })}
          </div>
        )}
      </Section>
      <Section
        label="Master volume"
        on={!!g.masterVolume}
        onToggle={(on) => set({ masterVolume: on ? [7, 7] : undefined })}
      >
        {g.masterVolume && (
          <div className="space-y-1">
            {(['Left', 'Right'] as const).map((side, i) => (
              <div key={side} className="flex items-center gap-2">
                <span className="w-9 text-muted-foreground">{side}</span>
                <Choice
                  label={`Master volume ${side.toLowerCase()}`}
                  options={[0, 1, 2, 3, 4, 5, 6, 7] as const}
                  value={g.masterVolume![i]! as 0}
                  onChange={(v) => {
                    const mv = [...g.masterVolume!] as [number, number];
                    mv[i] = v;
                    set({ masterVolume: mv });
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({
  label,
  on,
  onToggle,
  children,
}: {
  label: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 font-medium">
        <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        {label}
      </label>
      {children}
    </div>
  );
}

function Toggle({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className="w-7 rounded border border-input py-0.5 text-muted-foreground aria-pressed:bg-secondary aria-pressed:text-foreground"
    >
      {children}
    </button>
  );
}

function Tempo({ song, value, onChange }: { song: Song; value: number; onChange: (t: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const beats = bpm(value, song.grid.rowsPerBeat, TICK_RATE);
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        aria-label="Ticks a row"
        min={1}
        max={255}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = e.target.valueAsNumber;
          if (Number.isInteger(n) && n >= 1 && n <= 255) onChange(n);
        }}
        className="h-7 w-16 rounded-md border border-input bg-background px-1.5 tabular-nums"
      />
      <span className="text-muted-foreground">
        ticks a row: {beats.toFixed(beats < 100 ? 1 : 0)} BPM at {song.grid.rowsPerBeat} rows a beat
      </span>
    </div>
  );
}
