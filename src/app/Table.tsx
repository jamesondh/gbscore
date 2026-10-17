import { useState } from 'react';
import type { AnyInstrument } from '../core/instruments.ts';
import type { InstrumentKind, TableRow } from '../core/schema.ts';
import { Button } from './components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover.tsx';
import { apply, Choice, hold } from './controls.tsx';
import { EffectEditor } from './EffectEditor.tsx';
import { shortEffect } from './effects.ts';
import { MAX_JUMP, setTable, setTableRow, TABLE_ROWS, tablePresets, tableRows } from './instruments.ts';

// An instrument's table (docs/editor/, "Tables"): a column per table row, with lanes for pitch, effect and jump.
// Columns are rows, not ticks: the table runs a row a tick, but jumps decide which.

const COLUMN = 32; // pixels
const PITCH_HEIGHT = 80;
const RANGES = [12, 24, 36] as const;

export function TableEditor({ kind, inst }: { kind: InstrumentKind; inst: AnyInstrument }) {
  const rows = tableRows(inst.table);
  const used = inst.table?.length ?? 0;
  const widest = Math.max(0, ...rows.map((r) => Math.abs(r.note ?? 0)));
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES.find((r) => r >= widest) ?? 36);
  const set = (next: TableRow[] | undefined) => apply((s) => setTable(s, kind, inst.id, next), inst.id);
  const setRow = (i: number, row: TableRow) => apply((s) => setTableRow(s, kind, inst.id, i, row), inst.id);
  const dim = (i: number) => (i >= used ? 'opacity-35' : '');
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <span className="mr-1 text-muted-foreground">Presets</span>
        {tablePresets(kind).map(([name, preset]) => (
          <Button key={name} size="xs" variant="ghost" onClick={() => set(preset)}>
            {name}
          </Button>
        ))}
        <Button size="xs" variant="ghost" disabled={!inst.table} onClick={() => set(undefined)}>
          Clear
        </Button>
        <span className="ml-4 mr-1 text-muted-foreground">Range</span>
        <Choice label="Pitch range" options={RANGES} names={{ 12: '±12', 24: '±24', 36: '±36' }} value={range} onChange={setRange} />
        <p className="ml-4 max-w-md text-[11px] leading-snug text-muted-foreground">
          A row a tick from each note's start, then where jumps send it. Pitch is semitones from the note; a row
          without one leaves the pitch as it was. Draw pitches; right-click clears them.
        </p>
      </div>
      <div className="grid w-fit items-center gap-y-1" style={{ gridTemplateColumns: `3.5rem repeat(${TABLE_ROWS}, ${COLUMN}px)` }}>
        <span className="text-muted-foreground">Row</span>
        {rows.map((_, i) => (
          <span key={i} className={`text-center tabular-nums ${i % 4 ? 'text-muted-foreground/60' : 'text-muted-foreground'} ${dim(i)}`}>
            {i}
          </span>
        ))}

        <span className="self-start text-muted-foreground">Pitch</span>
        <PitchDrawing rows={rows} range={range} used={used} onDraw={set} />
        <span />
        {rows.map((r, i) => (
          <Cell
            key={i}
            label={`Row ${i} pitch`}
            className={dim(i)}
            small
            shown={r.note === undefined ? undefined : r.note > 0 ? `+${r.note}` : String(r.note)}
          >
            <Pitch value={r.note} onChange={(note) => setRow(i, { ...r, note })} />
          </Cell>
        ))}

        <span className="text-muted-foreground">Effect</span>
        {rows.map((r, i) => (
          <Cell key={i} label={`Row ${i} effect`} className={dim(i)} shown={r.fx ? shortEffect(r.fx) : undefined}>
            <EffectEditor kind={kind} inTable value={r.fx} onChange={(fx) => setRow(i, { ...r, fx })} />
          </Cell>
        ))}

        <span className="text-muted-foreground">Jump</span>
        {rows.map((r, i) => (
          <Cell
            key={i}
            label={`Row ${i} jump`}
            className={dim(i)}
            shown={r.jump !== undefined ? ['→', String(r.jump)] : undefined}
            implied={i === TABLE_ROWS - 1 ? ['→', '0'] : undefined}
          >
            <Jump row={i} value={r.jump} onChange={(jump) => setRow(i, { ...r, jump })} />
          </Cell>
        ))}
      </div>
    </div>
  );
}

/** A cell that opens a popover to edit it. `implied` is what the driver does when the cell is empty. */
function Cell({
  label,
  className,
  shown,
  implied,
  small,
  children,
}: {
  label: string;
  className: string;
  shown: [string, string] | string | undefined;
  implied?: [string, string];
  small?: boolean;
  children: React.ReactNode;
}) {
  const text = shown ?? implied;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={label}
          title={label}
          className={`flex ${small ? 'h-6' : 'h-8'} flex-col items-center justify-center rounded-sm border border-transparent leading-tight hover:border-border hover:bg-muted ${shown ? '' : 'text-muted-foreground/50'} ${className}`}
        >
          {typeof text === 'string' ? (
            <span className="tabular-nums">{text}</span>
          ) : text ? (
            <>
              <span className="text-[10px] text-muted-foreground">{text[0]}</span>
              <span className="text-[10px] tabular-nums">{text[1]}</span>
            </>
          ) : (
            '·'
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <p className="mb-2 text-xs font-medium">{label}</p>
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** A row's pitch as a number, for exact values and the keyboard. Typing goes in once it's a whole number in range. */
function Pitch({ value, onChange }: { value: number | undefined; onChange: (note: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          type="number"
          aria-label="Semitones"
          min={-36}
          max={35}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value !== '' && Number.isInteger(n) && n >= -36 && n <= 35) onChange(n);
          }}
          className="h-7 w-20 rounded-md border border-input bg-background px-1.5 tabular-nums"
        />
        <Button
          size="xs"
          variant="ghost"
          disabled={value === undefined}
          onClick={() => {
            setText('');
            onChange(undefined);
          }}
        >
          None
        </Button>
      </div>
      <p className="text-muted-foreground">
        Semitones from the note, −36 to +35. None leaves the pitch as it was.
      </p>
    </div>
  );
}

function Jump({ row, value, onChange }: { row: number; value: number | undefined; onChange: (jump: number | undefined) => void }) {
  const next = row === TABLE_ROWS - 1 ? 'Go back to row 0' : 'Go on to the next row';
  return (
    <div className="space-y-2 text-xs">
      <select
        aria-label="Then"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        className="h-7 w-full rounded-md border border-input bg-background px-1.5"
      >
        <option value="">{next}</option>
        {Array.from({ length: MAX_JUMP + 1 }, (_, i) => (
          <option key={i} value={i}>
            Jump to row {i}
            {i === row ? ' (hold here)' : ''}
          </option>
        ))}
      </select>
      <p className="text-muted-foreground">
        Where the table goes after this row. A row that jumps to itself holds there, running its effect each tick.
      </p>
    </div>
  );
}

/** The pitch lane: a bar per row from the zero line, a semitone per step. A left stroke draws, a right one clears. */
function PitchDrawing({
  rows,
  range,
  used,
  onDraw,
}: {
  rows: TableRow[];
  range: number;
  used: number;
  onDraw: (rows: TableRow[]) => void;
}) {
  const steps = range * 2 + 1; // from +range at the top to −range at the bottom
  const [stroke, setStroke] = useState<{ col: number; note: number | undefined; rows: TableRow[] }>();
  const point = (e: React.PointerEvent<SVGSVGElement>, clear: boolean) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.max(0, Math.min(TABLE_ROWS - 1, Math.floor(((e.clientX - r.left) / r.width) * TABLE_ROWS)));
    const note = range - Math.floor(((e.clientY - r.top) / r.height) * steps);
    return { col, note: clear ? undefined : Math.max(-range, Math.min(Math.min(range, 35), note)) };
  };
  const drawTo = (from: { col: number; note: number | undefined }, to: { col: number; note: number | undefined }, base: TableRow[]) => {
    const next = [...base];
    const span = Math.abs(to.col - from.col);
    for (let k = 0; k <= span; k++) {
      const t = span ? k / span : 1;
      const col = Math.round(from.col + (to.col - from.col) * t);
      const note =
        to.note === undefined ? undefined : Math.round((from.note ?? to.note) + (to.note - (from.note ?? to.note)) * t);
      next[col] = { ...next[col], note };
    }
    onDraw(next);
    return next;
  };
  const bar = (note: number) => {
    const top = range - Math.max(0, Math.min(range, note)); // the cell of the higher end
    const bottom = range - Math.min(0, Math.max(-range, note)) + 1;
    return { y: top, height: bottom - top };
  };
  return (
    <svg
      role="img"
      aria-label="Table pitches"
      viewBox={`0 0 ${TABLE_ROWS} ${steps}`}
      preserveAspectRatio="none"
      style={{ gridColumn: `span ${TABLE_ROWS}`, width: TABLE_ROWS * COLUMN, height: PITCH_HEIGHT }}
      className="cursor-crosshair touch-none rounded-md border bg-background"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        hold(e);
        const p = point(e, e.button === 2);
        setStroke({ ...p, rows: drawTo(p, p, rows) });
      }}
      onPointerMove={(e) => {
        if (!stroke) return;
        const p = point(e, stroke.note === undefined);
        if (p.col === stroke.col && p.note === stroke.note) return;
        setStroke({ ...p, rows: drawTo(stroke, p, stroke.rows) });
      }}
      onPointerUp={() => setStroke(undefined)}
      onPointerCancel={() => setStroke(undefined)}
    >
      {[12, 24]
        .filter((n) => n < range)
        .flatMap((n) => [range - n + 0.5, range + n + 0.5])
        .map((y) => (
          <line key={y} x1={0} x2={TABLE_ROWS} y1={y} y2={y} className="stroke-border" strokeWidth={0.04} />
        ))}
      <line x1={0} x2={TABLE_ROWS} y1={range + 0.5} y2={range + 0.5} className="stroke-muted-foreground" strokeWidth={0.06} />
      {rows.map((r, i) =>
        r.note === undefined ? null : (
          <rect key={i} x={i + 0.1} width={0.8} {...bar(r.note)} className={i < used ? 'fill-primary/75' : 'fill-primary/30'} />
        ),
      )}
    </svg>
  );
}
