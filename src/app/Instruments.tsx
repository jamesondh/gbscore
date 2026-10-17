import { Copy, Play, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { AnyInstrument } from '../core/instruments.ts';
import {
  DUTY_NAMES,
  LANE_KIND,
  type DutyInstrument,
  type InstrumentKind,
  type NoiseInstrument,
  type Song,
  type WaveInstrument,
} from '../core/schema.ts';
import { Button } from './components/ui/button.tsx';
import * as edits from './instruments.ts';
import { apply, Choice, hold, Label, Range } from './controls.tsx';
import { noteColour } from './roll/draw.ts';
import { TableEditor } from './Table.tsx';
import { addInstrument, editSong, giveSelection, removeInstrument, setPen, tryInstrument, useApp } from './store.ts';

// The instrument panel (docs/editor/, "Instruments and waves"): the instruments of the expanded lane's kind, and
// the one new notes get, to edit. Changes are heard soon after they stop, with the first selected note, or the last
// played with Play keys (C5 until one is).

const KIND_TITLE: Record<InstrumentKind, string> = {
  duty: 'Duty instruments',
  wave: 'Wave instruments',
  noise: 'Noise instruments',
};

export function InstrumentPanel() {
  const song = useApp((s) => s.open?.song);
  const lane = useApp((s) => s.view.expanded);
  const inst = useApp((s) => s.pen[s.view.expanded].inst);
  if (!song) return null;
  const kind = LANE_KIND[lane];
  const list = edits.instrumentsOf(song, kind);
  const counts = edits.noteCounts(song, kind);
  const chosen = list.find((i) => i.id === inst);
  const full = list.length >= edits.MAX_INSTRUMENTS;
  return (
    <section aria-label="Instruments" className="flex h-72 shrink-0 border-t bg-card text-xs">
      <div className="flex w-48 shrink-0 flex-col border-r">
        <p className="px-3 pt-2 pb-1 font-medium text-muted-foreground">{KIND_TITLE[kind]}</p>
        <div role="listbox" aria-label="Instrument" className="min-h-0 flex-1 overflow-y-auto px-1">
          {list.map((i) => (
            <button
              key={i.id}
              role="option"
              aria-selected={i.id === inst}
              onClick={() => setPen(lane, { inst: i.id })}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted aria-selected:bg-secondary"
            >
              <span className="w-4 text-right tabular-nums text-muted-foreground">{i.id}</span>
              <Swatch inst={i.id} />
              <span className="flex-1 truncate">{i.name ?? <span className="text-muted-foreground">untitled</span>}</span>
              <span className="tabular-nums text-muted-foreground" title="Notes that use it">
                {counts.get(i.id) ?? ''}
              </span>
            </button>
          ))}
        </div>
        <div className="p-1">
          <Button size="xs" variant="ghost" disabled={full} onClick={() => addInstrument()} title={full ? 'The driver allows 15' : undefined}>
            <Plus />
            New instrument
          </Button>
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-auto p-3">
        {chosen ? (
          <Editor key={`${kind}${chosen.id}`} song={song} kind={kind} inst={chosen} full={full} />
        ) : (
          <div className="space-y-2">
            <p className="text-muted-foreground">
              {list.length
                ? `New notes get instrument ${inst}, which isn't defined. Pick one, or add a new one.`
                : `No ${kind} instruments yet. Add one to play notes in this lane.`}
            </p>
            {/* Waves no instrument plays are still in the song, and are deleted here. */}
            {kind === 'wave' && !list.length && song.waves.length > 0 && <Waves song={song} />}
          </div>
        )}
      </div>
    </section>
  );
}

/** The colour of an instrument's notes in the piano roll. */
export function Swatch({ inst }: { inst: number }) {
  return <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: noteColour(inst) }} />;
}

function Editor({ song, kind, inst, full }: { song: Song; kind: InstrumentKind; inst: AnyInstrument; full: boolean }) {
  const lane = useApp((s) => s.view.expanded);
  const selection = useApp((s) => s.selection);
  const others = selection.filter((n) => n.inst !== undefined && n.inst !== inst.id).length;
  const [tab, setTab] = useState(lastTab);
  const showTab = (t: Tab) => setTab((lastTab = t));
  const update = (change: Partial<AnyInstrument>) => apply((s) => edits.updateInstrument(s, kind, inst.id, change), inst.id);
  return (
    <div className="flex gap-6">
      <div className="space-y-3">
        <div className="flex items-center gap-1.5">
          <span className="w-4 text-right tabular-nums text-muted-foreground">{inst.id}</span>
          <Name
            label="Name"
            value={inst.name}
            onSave={(name) => editSong((s) => edits.updateInstrument(s, kind, inst.id, { name }))}
          />
          <Choice
            label="Show"
            options={['sound', 'table'] as const}
            names={{ sound: 'Sound', table: inst.table ? `Table · ${inst.table.length} ${inst.table.length === 1 ? 'row' : 'rows'}` : 'Table' }}
            value={tab}
            onChange={showTab}
          />
          <Button size="xs" variant="secondary" onClick={() => tryInstrument(inst.id, true)} title="Play the selected note with it, or the last note played with Play keys">
            <Play />
            Try
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Duplicate" title="Duplicate" disabled={full} onClick={() => addInstrument(inst.id)}>
            <Copy />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Delete" title="Delete" onClick={() => removeInstrument(inst.id)}>
            <Trash2 />
          </Button>
          {others > 0 && (
            <Button size="xs" variant="ghost" onClick={() => giveSelection(inst.id)} title={`In ${lane}`}>
              Give to {others === 1 ? 'the selected note' : `${others} selected notes`}
            </Button>
          )}
        </div>
        {tab === 'table' ? (
          <TableEditor kind={kind} inst={inst} />
        ) : (
          <div className="grid grid-cols-[5.5rem_auto] items-center gap-x-3 gap-y-2">
            {kind === 'duty' && <DutyFields inst={inst as DutyInstrument} update={update} />}
            {kind === 'wave' && <WaveFields song={song} inst={inst as WaveInstrument} update={update} />}
            {kind === 'noise' && <NoiseFields inst={inst as NoiseInstrument} update={update} />}
            <Length inst={inst} wave={kind === 'wave'} update={update} />
          </div>
        )}
      </div>
      {kind === 'wave' && tab === 'sound' && <WaveEditor song={song} inst={inst as WaveInstrument} />}
    </div>
  );
}

type Update = (change: Partial<AnyInstrument>) => void;

type Tab = 'sound' | 'table';
let lastTab: Tab = 'sound'; // the tab shown, kept as other instruments are picked

function DutyFields({ inst, update }: { inst: DutyInstrument; update: Update }) {
  return (
    <>
      <Label>Duty</Label>
      <Choice label="Duty" options={DUTY_NAMES} value={inst.duty} onChange={(duty) => update({ duty })} />
      <Envelope inst={inst} update={update} />
      <Label>Sweep</Label>
      <div className="flex items-center gap-3">
        <Range label="Sweep pace" caption="pace" min={0} max={7} value={inst.sweepTime} onChange={(sweepTime) => update({ sweepTime })} />
        <Choice label="Sweep direction" options={['down', 'up']} value={inst.sweepDir} onChange={(sweepDir) => update({ sweepDir })} />
        <Range label="Sweep step" caption="step" min={0} max={7} value={inst.sweepShift} onChange={(sweepShift) => update({ sweepShift })} />
        <span className="text-muted-foreground">{describeSweep(inst)}</span>
      </div>
    </>
  );
}

function NoiseFields({ inst, update }: { inst: NoiseInstrument; update: Update }) {
  return (
    <>
      <Envelope inst={inst} update={update} />
      <Label>Mode</Label>
      <Choice
        label="Mode"
        options={[15, 7] as const}
        names={{ 15: '15-bit, hiss', 7: '7-bit, buzz' }}
        value={inst.bits}
        onChange={(bits) => update({ bits })}
      />
    </>
  );
}

function WaveFields({ song, inst, update }: { song: Song; inst: WaveInstrument; update: Update }) {
  const full = song.waves.length >= edits.MAX_WAVES;
  const current = song.waves.find((w) => w.id === inst.wave);
  const newWave = () => {
    let id = 0;
    const added = editSong((s) => {
      const r = edits.addWave(s, current?.data ?? edits.WAVE_PRESETS.Triangle!);
      if (typeof r === 'string') return r;
      id = r.id;
      return edits.updateInstrument(r.song, 'wave', inst.id, { wave: id });
    });
    if (added) tryInstrument(inst.id, false);
  };
  return (
    <>
      <Label>Wave</Label>
      <Waves song={song} picked={inst.wave} onPick={(wave) => update({ wave })}>
        <Button size="icon-xs" variant="ghost" aria-label="New wave" title="New wave, a copy of this one" disabled={full} onClick={newWave}>
          <Plus />
        </Button>
      </Waves>
      <Label>Level</Label>
      <Choice label="Level" options={['100%', '50%', '25%', '0%'] as const} value={inst.level} onChange={(level) => update({ level })} />
    </>
  );
}

/** The song's waves, picked for an instrument when there's one to pick for, each with a × to delete it shown on
 * hover. */
function Waves(props: { song: Song; picked?: number; onPick?: (wave: number) => void; children?: React.ReactNode }) {
  const { song, picked, onPick } = props;
  return (
    <div role={onPick ? 'radiogroup' : 'list'} aria-label="Waves" className="flex flex-wrap items-center gap-1">
      {song.waves.map((w) => {
        const shape = (
          <>
            <span className="tabular-nums text-muted-foreground">{w.id}</span>
            <WaveShape data={w.data} className="h-3 w-6" />
          </>
        );
        const title = w.name ? `${w.id} ${w.name}` : `Wave ${w.id}`;
        const chip = 'flex items-center gap-1 rounded-md border border-transparent px-1 py-0.5';
        return (
          <span key={w.id} role={onPick ? undefined : 'listitem'} className="group relative">
            {onPick ? (
              <button
                role="radio"
                aria-checked={w.id === picked}
                aria-label={`Wave ${w.id}`}
                title={title}
                onClick={() => onPick(w.id)}
                className={`${chip} hover:bg-muted aria-checked:border-border aria-checked:bg-secondary`}
              >
                {shape}
              </button>
            ) : (
              <span aria-label={`Wave ${w.id}`} title={title} className={chip}>
                {shape}
              </span>
            )}
            {/* Not on the instrument's own wave, which it uses, so deleting it would always be refused. */}
            {w.id !== picked && (
              <button
                aria-label={`Delete wave ${w.id}`}
                title={`Delete wave ${w.id}`}
                onClick={() => editSong((s) => edits.removeWave(s, w.id))}
                className="absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            )}
          </span>
        );
      })}
      {props.children}
    </div>
  );
}

function Envelope({ inst, update }: { inst: DutyInstrument | NoiseInstrument; update: Update }) {
  return (
    <>
      <Label>Volume</Label>
      <Range label="Volume" min={0} max={15} value={inst.volume} onChange={(volume) => update({ volume })} />
      <Label>Envelope</Label>
      <div className="flex items-center gap-3">
        <Choice label="Envelope direction" options={['down', 'up']} value={inst.envDir} onChange={(envDir) => update({ envDir })} />
        <Range label="Envelope pace" caption="pace" min={0} max={7} value={inst.envPace} onChange={(envPace) => update({ envPace })} />
        <span className="text-muted-foreground">{describeEnvelope(inst)}</span>
      </div>
    </>
  );
}

/** The length counter, as how long the note lasts: the slider runs the other way from the driver's value. */
function Length({ inst, wave, update }: { inst: AnyInstrument; wave: boolean; update: Update }) {
  const steps = wave ? 256 : 64;
  const id = useId();
  return (
    <>
      <Label>Length</Label>
      <div className="flex items-center gap-3">
        <label htmlFor={id} className="flex items-center gap-1.5">
          <input
            id={id}
            type="checkbox"
            checked={inst.lengthEnabled}
            onChange={(e) => update({ lengthEnabled: e.target.checked })}
            className="accent-primary"
          />
          Stops by itself
        </label>
        <Range
          label="Length"
          min={1}
          max={steps}
          value={steps - inst.length}
          disabled={!inst.lengthEnabled}
          onChange={(v) => update({ length: steps - v })}
          text={inst.lengthEnabled ? `after ${seconds((steps - inst.length) / 256)}` : ''}
        />
      </div>
    </>
  );
}

/** An instrument's or a wave's name, saved when the field loses focus or Enter is pressed. Escape puts it back. */
function Name({ label, value, onSave }: { label: string; value: string | undefined; onSave: (name: string | undefined) => void }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const done = () => {
    const name = text.trim();
    if (name !== (value ?? '')) onSave(name || undefined);
  };
  return (
    <input
      aria-label={label}
      placeholder="untitled"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(value ?? '');
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className="h-6 w-40 rounded-md border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    />
  );
}

/** The instrument's wave, drawn with the mouse: a column per sample, 0 at the bottom and 15 at the top. Editing it
 * changes every instrument that plays it. */
function WaveEditor({ song, inst }: { song: Song; inst: WaveInstrument }) {
  const wave = song.waves.find((w) => w.id === inst.wave);
  if (!wave) return <p className="text-destructive">Wave {inst.wave} isn't defined.</p>;
  const sharing = song.instruments.wave.filter((i) => i.wave === wave.id && i.id !== inst.id).map((i) => i.id);
  const set = (data: string) => apply((s) => edits.setWave(s, wave.id, data), inst.id);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Wave {wave.id}</span>
        <Name
          key={wave.id}
          label="Wave name"
          value={wave.name}
          onSave={(name) => editSong((s) => edits.renameWave(s, wave.id, name))}
        />
      </div>
      <WaveDrawing data={wave.data} onDraw={set} />
      <div className="flex items-center gap-1">
        {Object.entries(edits.WAVE_PRESETS).map(([name, data]) => (
          <Button key={name} size="xs" variant="ghost" onClick={() => set(data)}>
            {name}
          </Button>
        ))}
      </div>
      <p aria-label="Samples" className="font-mono text-[10px] text-muted-foreground select-text">
        {wave.data}
      </p>
      {sharing.length > 0 && (
        <p className="text-muted-foreground">
          Instrument{sharing.length > 1 && 's'} {sharing.join(', ')} also {sharing.length > 1 ? 'play' : 'plays'} wave {wave.id}.
        </p>
      )}
    </div>
  );
}

function WaveDrawing({ data, onDraw }: { data: string; onDraw: (data: string) => void }) {
  const samples = edits.waveSamples(data);
  // Where a stroke last drew, so a fast stroke fills the columns it skipped.
  const [last, setLast] = useState<{ col: number; level: number; samples: number[] }>();
  const point = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.max(0, Math.min(31, Math.floor(((e.clientX - r.left) / r.width) * 32)));
    const level = Math.max(0, Math.min(15, 15 - Math.floor(((e.clientY - r.top) / r.height) * 16)));
    return { col, level };
  };
  const drawTo = (from: { col: number; level: number }, to: { col: number; level: number }, base: number[]) => {
    const next = [...base];
    const span = Math.abs(to.col - from.col);
    for (let k = 0; k <= span; k++) {
      const t = span ? k / span : 1;
      next[Math.round(from.col + (to.col - from.col) * t)] = Math.round(from.level + (to.level - from.level) * t);
    }
    onDraw(edits.waveData(next));
    return next;
  };
  return (
    <svg
      role="img"
      aria-label="Wave shape"
      viewBox="0 0 32 16"
      preserveAspectRatio="none"
      className="h-32 w-64 cursor-crosshair touch-none rounded-md border bg-background"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        hold(e);
        const p = point(e);
        setLast({ ...p, samples: drawTo(p, p, samples) });
      }}
      onPointerMove={(e) => {
        if (!last) return;
        const p = point(e);
        if (p.col === last.col && p.level === last.level) return;
        setLast({ ...p, samples: drawTo(last, p, last.samples) });
      }}
      onPointerUp={() => setLast(undefined)}
      onPointerCancel={() => setLast(undefined)}
    >
      {[4, 8, 12].map((y) => (
        <line key={y} x1={0} x2={32} y1={y} y2={y} className="stroke-border" strokeWidth={0.05} />
      ))}
      {samples.map((v, i) => (
        <rect key={i} x={i + 0.06} y={15 - v} width={0.88} height={v + 1} className="fill-primary/70" />
      ))}
    </svg>
  );
}

function WaveShape({ data, className }: { data: string; className?: string }) {
  const points = edits.waveSamples(data).flatMap((v, i) => [`${i},${15 - v}`, `${i + 1},${15 - v}`]);
  return (
    <svg viewBox="0 -0.5 32 17" preserveAspectRatio="none" className={className} aria-hidden>
      <polyline points={points.join(' ')} fill="none" className="stroke-foreground" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---- what the numbers mean

const seconds = (s: number) => (s < 1 ? `${Math.round(s * 1000)} ms` : `${s.toFixed(2)} s`);

/** The envelope steps the volume once every `pace` 64ths of a second. */
export function describeEnvelope(i: { volume: number; envDir: 'up' | 'down'; envPace: number }): string {
  if (i.envPace === 0) return 'holds its volume';
  const steps = i.envDir === 'down' ? i.volume : 15 - i.volume;
  if (steps === 0) return i.envDir === 'down' ? 'silent' : 'holds at 15';
  const time = seconds((steps * i.envPace) / 64);
  return i.envDir === 'down' ? `fades out over ${time}` : `rises to 15 over ${time}`;
}

/** The sweep shifts the pitch once every `sweepTime` 128ths of a second. */
export function describeSweep(i: DutyInstrument): string {
  if (i.sweepTime === 0) return 'off';
  if (i.sweepShift === 0) return 'off: the step is 0';
  return `pitch ${i.sweepDir} every ${seconds(i.sweepTime / 128)}, pulse 1 only`;
}
