import { useEffect, useState } from 'react';
import { encodeEffect, effectKey } from '../core/effects.ts';
import { DUTY_NAMES, effectSchema, type Effect, type InstrumentKind } from '../core/schema.ts';
import { Choice } from './controls.tsx';
import { EFFECT_NAMES as NAMES } from './effects.ts';

// One effect, chosen by name, with its values. Tables use it for a row's effect; lane effects (step 4b) will too.

type Key = keyof Effect;

const DEFAULTS: Record<Exclude<Key, 'raw'>, Effect> = {
  arp: { arp: [4, 7] },
  slideUp: { slideUp: 8 },
  slideDown: { slideDown: 8 },
  glide: { glide: 8 },
  vibrato: { vibrato: [4, 2] },
  duty: { duty: '50%' },
  wave: { wave: 0 },
  volSlide: { volSlide: [0, 1] },
  volume: { volume: 8 },
  cut: { cut: 0 },
  delay: { delay: 1 },
};

/** The effects an instrument kind can use, as the compiler decides: duty only on pulse, wave only on the wave
 * channel, and no glide, delay or cut in tables. Hex is always offered. */
export function effectChoices(kind: InstrumentKind, inTable: boolean): Key[] {
  return (Object.keys(NAMES) as Key[]).filter(
    (k) => k === 'raw' || typeof encodeEffect(DEFAULTS[k], kind, inTable) !== 'string',
  );
}

/** What an effect does, from the schema's description without its hex: "Set the volume (0–15) and…". */
function describe(k: Key): string {
  const text = (effectSchema.shape[k].unwrap().description ?? '').replace(/^[0-9A-Fa-fxyv]{3}[^:]*: /, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Picks an effect and its values. Calls `onChange` only with effects that encode for the kind, or undefined for
 * none; anything else stays in the editor with the reason shown. `exclude` takes effects off the list, and `ticks`
 * keeps delay and cut within the row's ticks. */
export function EffectEditor({
  kind,
  inTable,
  value,
  onChange,
  exclude = [],
  ticks,
}: {
  kind: InstrumentKind;
  inTable: boolean;
  value: Effect | undefined;
  onChange: (fx: Effect | undefined) => void;
  exclude?: Key[];
  ticks?: number;
}) {
  const key = value && effectKey(value);
  const [problem, setProblem] = useState<string>();
  // Hex is picked before there's a valid value to save, so it's shown until another effect is.
  const [rawing, setRawing] = useState(key === 'raw');
  // The effect can change from outside, as when the file reloads: show what it is now.
  useEffect(() => {
    if (key) setRawing(key === 'raw');
  }, [key]);
  // A delay needs a tick after the first to start on.
  const choices = effectChoices(kind, inTable).filter((k) => !exclude.includes(k) && !(k === 'delay' && ticks === 1));
  const change = (fx: Effect | undefined) => {
    const r = fx && encodeEffect(fx, kind, inTable);
    if (typeof r === 'string') return setProblem(r);
    setProblem(undefined);
    onChange(fx);
  };
  const pick = (k: string) => {
    setRawing(k === 'raw');
    if (!k) return change(undefined);
    if (k === 'raw') return;
    change(DEFAULTS[k as Exclude<Key, 'raw'>]);
  };
  const shown = rawing ? 'raw' : (key ?? '');
  return (
    <div className="space-y-2 text-xs">
      <select
        aria-label="Effect"
        value={shown}
        onChange={(e) => pick(e.target.value)}
        className="h-7 w-full rounded-md border border-input bg-background px-1.5"
      >
        <option value="">None</option>
        {choices.map((k) => (
          <option key={k} value={k}>
            {NAMES[k]}
          </option>
        ))}
        {key && !choices.includes(key) && <option value={key}>{NAMES[key]} (not allowed here)</option>}
      </select>
      {shown === 'raw' ? (
        <Hex value={value?.raw ?? ''} onChange={(raw) => change({ raw })} />
      ) : (
        value && key && <Values fx={value} k={key} ticks={ticks} onChange={change} />
      )}
      {shown && <p className="text-muted-foreground">{describe(shown as Key)}</p>}
      {problem && <p className="text-destructive">{problem}</p>}
    </div>
  );
}

function Values({ fx, k, ticks, onChange }: { fx: Effect; k: Key; ticks?: number; onChange: (fx: Effect) => void }) {
  const v = fx[k];
  if (k === 'duty') return <Choice label="Duty" options={DUTY_NAMES} value={fx.duty!} onChange={(duty) => onChange({ duty })} />;
  if (Array.isArray(v)) {
    const [x, y] = v as [number, number];
    const labels: Partial<Record<Key, [string, string]>> = {
      arp: ['+x', '+y'],
      vibrato: ['speed', 'depth'],
      volSlide: ['up', 'down'],
    };
    const [lx, ly] = labels[k] ?? ['x', 'y'];
    return (
      <div className="flex gap-3">
        <Num label={lx} max={15} value={x} onChange={(n) => onChange({ [k]: [n, y] })} />
        <Num label={ly} max={15} value={y} onChange={(n) => onChange({ [k]: [x, n] })} />
      </div>
    );
  }
  const max = k === 'volume' || k === 'wave' ? 15 : (k === 'cut' || k === 'delay') && ticks ? ticks - 1 : 255;
  const label = k === 'cut' || k === 'delay' ? 'tick' : 'value';
  const min = k === 'delay' ? 1 : 0; // delay 0 never plays
  return <Num label={label} min={min} max={max} value={v as number} onChange={(n) => onChange({ [k]: n })} />;
}

function Num({
  label,
  min = 0,
  max,
  value,
  onChange,
}: {
  label: string;
  min?: number;
  max: number;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
        className="h-7 w-16 rounded-md border border-input bg-background px-1.5 tabular-nums"
      />
    </label>
  );
}

/** Three hex digits, saved once they make an effect the kind can use. */
function Hex({ value, onChange }: { value: string; onChange: (raw: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label="Hex"
      placeholder="9D0"
      maxLength={3}
      value={text}
      onChange={(e) => {
        const t = e.target.value.toUpperCase();
        setText(t);
        if (/^[0-9A-F]{3}$/.test(t)) onChange(t);
      }}
      className="h-7 w-20 rounded-md border border-input bg-background px-1.5 font-mono uppercase"
    />
  );
}
