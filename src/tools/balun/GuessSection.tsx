// "What is this core? Let EMWS guess" - a step-by-step run from an unlabelled core in the
// hand to a named core in the bin: connect the VNA, calibrate it if it needs it, wind
// what the page asks for, measure, let it judge the reading and ask for the next winding,
// read the estimate, and keep the core. The reasoning is identify.ts and guess-plan.ts;
// the VNA is useVna.ts. A .s1p of a winding, or a core already in the library, can be
// guessed too, from the same starting point.

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { TouchstoneError, parseTouchstone } from '../../lib/touchstone';
import { NumberField } from '../../ui/NumberField';
import { STANDARDS, useVna } from '../../ui/useVna';
import { VnaSources } from '../../ui/VnaSources';
import { CORES, type CoreSize, describeSize } from './catalog';
import { type Agreement, FIRST_TURNS, type Judgement, type Reading, type Tried, WIZARD_SWEEP, agreement, betterReading, commonCrossing, confirmingTurns, judgeNext } from './guess-plan';
import { type Candidate, type CoreGuess, identifyCore, nearestSize } from './identify';
import { type Design, coreOf } from './model';
import { type CoreProfile, makeProfile } from './profiles';
import { referenceCores } from './reference-cores';

const FAMILY_NAME = { NiZn: 'nickel-zinc', MnZn: 'manganese-zinc' } as const;
const degrees = (rad: number) => `${((rad * 180) / Math.PI).toFixed(0)}°`;
const mhz = (f: number) => f.toFixed(f < 10 ? 2 : 1);
const who = (c: Candidate) => (c.kind === 'core' ? `your core "${c.name}"` : c.kind === 'reference' ? `EMWS's measured ${c.name}` : c.name);

/** The estimate: the verdict, the clues it rests on, every candidate's score, and the caveats. */
export function GuessView({ guess, profile, sizeNote, onCall }: { guess: CoreGuess; profile: CoreProfile; sizeNote?: string; onCall?: (mix: Candidate) => void }) {
  let headline = '';
  if (guess.undecidable) {
    headline = guess.undecidable;
  } else if (guess.best) {
    const others = guess.alsoPossible.length > 0 ? `, or ${guess.alsoPossible.map(who).join(' or ')}` : '';
    const family = guess.family ? ` (${FAMILY_NAME[guess.family]})` : '';
    headline =
      guess.fit === 'fits'
        ? `Looks like ${who(guess.best)}${family}${others}.`
        : guess.fit === 'roughly'
          ? `Roughly like ${who(guess.best)}${family}${others} - not a close fit.`
          : `None of the pictures EMWS has fits this core closely${
              guess.nearestFamily
                ? `, but the three nearest are all ${FAMILY_NAME[guess.nearestFamily]} (${guess.candidates
                    .filter((c) => c.kind === 'mix')
                    .slice(0, 3)
                    .map((c) => c.name)
                    .join(', ')})`
                : `; the nearest is ${who(guess.best)}, and it is far off`
            }${guess.coreCrossingMHz !== undefined ? `. Its own zero-crossing at ${mhz(guess.coreCrossingMHz)} MHz is a manganese-zinc trait (#31, #73, #77 territory)` : ''}.`;
  } else {
    headline = 'Nothing to compare yet.';
  }
  const mix = guess.suggestedMix;
  const canCall = onCall && mix?.callIt && (profile.mix !== mix.callIt || profile.family !== mix.family);
  return (
    <div className="core-guess-result">
      <p className="core-guess-verdict">
        <strong>{headline}</strong>
      </p>
      <ul className="muted">
        <li>
          μ′ {Math.round(guess.muLow)} at {mhz(guess.fromMHz)} MHz, with a loss part of {Math.round(guess.lossLow)}
          {guess.stillFalling ? ' - and still falling, so the real initial permeability is higher' : ''}
          {sizeNote ? ` (${sizeNote})` : ''}.
        </li>
        <li>
          {guess.crossoverMHz !== undefined
            ? `Loss overtakes reactance at ${mhz(guess.crossoverMHz)} MHz: above there the core is more resistor than inductor.`
            : `Loss stays below the reactance all the way to ${mhz(guess.toMHz)} MHz: a low-loss mix at these frequencies.`}
          {guess.halfMHz !== undefined ? ` μ′ has halved by ${mhz(guess.halfMHz)} MHz.` : ''}
        </li>
        <li>
          Compared {mhz(guess.fromMHz)} to {mhz(guess.toMHz)} MHz{guess.cutAtHalf ? ' - up to where μ′ has halved: the pictures describe the knee, not the tail' : ''} on the
          shape of the curve, which does not depend on the {profile.setup.turns} turns or the size entered.
        </li>
        <li>
          {guess.size
            ? `Size: ${guess.size.core.name} (${describeSize(guess.size.core)}), within ${Math.max(1, Math.round(guess.size.deviation * 100))} %.`
            : 'Size: no catalogue size within 10 % of these dimensions.'}
        </li>
      </ul>
      <table className="band-table">
        <thead>
          <tr>
            <th scope="col">Candidate</th>
            <th scope="col">Loss angle differs by</th>
            <th scope="col">μ′ level against it</th>
          </tr>
        </thead>
        <tbody>
          {guess.candidates.map((c) => (
            <tr key={`${c.kind}-${c.id}`}>
              <th scope="row">
                {c.name}
                {c.kind === 'core' ? ' (your core)' : c.kind === 'reference' ? ' (measured, shipped with EMWS)' : ` (${FAMILY_NAME[c.family]})`}
              </th>
              <td>{degrees(c.angleRms)} on average</td>
              <td>{c.levelRatio.toFixed(2)}×</td>
            </tr>
          ))}
        </tbody>
      </table>
      {canCall && mix && (
        <div className="button-row">
          <button type="button" className="small" onClick={() => onCall(mix)}>
            Call it {mix.callIt} ({mix.family})
          </button>
          <span className="muted">Writes it onto the core's card; the family also sets the winding-capacitance estimate.</span>
        </div>
      )}
      {guess.caveats.length > 0 && (
        <ul className="muted">
          {guess.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <p className="muted">
        The six mixes are EMWS's own estimates, not the makers' curves, and the level depends on the size and turns typed - a #31 first measured with
        its height typed 12.7 mm instead of 20 read 1.6× the picture's level while its shape still said #31 - which is why the shape decides and the
        level is only shown. Manganese-zinc mixes resemble each other closely; a core that is none of the six is still
        matched to the nearest. The guide says more.
      </p>
    </div>
  );
}

type Step = 'idle' | 'connect' | 'calibrate' | 'wind' | 'estimate' | 'save' | 'done';

interface GuessSectionProps {
  design: Design;
  profiles: readonly CoreProfile[];
  onAddProfiles: (profiles: CoreProfile[]) => void;
  onUpdateProfile: (profile: CoreProfile) => void;
}

export function GuessSection({ design, profiles, onAddProfiles, onUpdateProfile }: GuessSectionProps) {
  const vna = useVna(WIZARD_SWEEP);
  /** What a measurement is compared against: your cores, and the measured cores shipped with EMWS. */
  const compareWith = useMemo(() => [...profiles, ...referenceCores()], [profiles]);
  const [step, setStep] = useState<Step>('idle');
  const [mode, setMode] = useState<'vna' | 'file'>('vna');
  const [turns, setTurns] = useState(FIRST_TURNS);
  const [readings, setReadings] = useState<Reading[]>([]);
  /** Everything this run has measured, good or not: what the next judgement is made in the light of. */
  const [history, setHistory] = useState<Tried[]>([]);
  const [judgement, setJudgement] = useState<Judgement>();
  /** Why the kept reading stands alone, when no second winding confirmed it. */
  const [aloneWhy, setAloneWhy] = useState<string>();
  const [agree, setAgree] = useState<Agreement>();
  /** Both windings went capacitive here: the core's own crossing, not a winding resonance. */
  const [crossing, setCrossing] = useState<number>();
  const [kept, setKept] = useState<Reading>();
  const [savedId, setSavedId] = useState('');
  const [message, setMessage] = useState<string>();
  // The save step's fields.
  const [name, setName] = useState('');
  const [sizeId, setSizeId] = useState('');
  const [custom, setCustom] = useState<{ odMm: number; idMm: number; heightMm: number; shape: 'ring' | 'sleeve' }>({ odMm: 0, idMm: 0, heightMm: 0, shape: 'ring' });
  const [mixName, setMixName] = useState('');
  const [family, setFamily] = useState<CoreProfile['family']>('NiZn');
  const fileInput = useRef<HTMLInputElement>(null);

  const current = coreOf(design);
  const chosenSize = (): CoreSize => (sizeId === 'custom' ? { id: 'custom', name: 'Custom', ...custom } : (CORES.find((c) => c.id === sizeId) ?? { ...current, id: 'custom', name: current.name }));

  // Steps that wait on the instrument move on by themselves.
  useEffect(() => {
    if (step === 'connect' && vna.instrument) setStep(vna.needsCalibration ? 'calibrate' : 'wind');
    if (step === 'calibrate' && vna.calibrated) setStep('wind');
  }, [step, vna.instrument, vna.needsCalibration, vna.calibrated]);

  const reset = () => {
    setReadings([]);
    setHistory([]);
    setJudgement(undefined);
    setAloneWhy(undefined);
    setAgree(undefined);
    setCrossing(undefined);
    setKept(undefined);
    setTurns(FIRST_TURNS);
    setMessage(undefined);
  };

  const start = (how: 'vna' | 'file') => {
    reset();
    setMode(how);
    setSavedId('');
    if (how === 'file') setStep('wind');
    else setStep(vna.instrument ? (vna.needsCalibration && !vna.calibrated ? 'calibrate' : 'wind') : 'connect');
  };

  /** A reading of the winding the page asked for, from the instrument or a file. */
  const took = (points: Reading['points'], source: string) => {
    const reading: Reading = { turns, points, source };
    const { judgement: judged, coreCrossingMHz: cross, use } = judgeNext(reading, history);
    const tried = [...history, { reading, judgement: judged }];
    setHistory(tried);
    setJudgement(judged);
    setAgree(undefined);
    if (cross !== undefined) setCrossing(cross);
    if (use) {
      // The count it would ask for next has been tried and judged the other way: stop asking.
      setAloneWhy(judged.why);
      setKept(use);
      setStep('estimate');
      return;
    }
    if (judged.verdict !== 'good') {
      setTurns(judged.nextTurns);
      return;
    }
    const good = [...readings, reading];
    setReadings(good);
    if (good.length === 1) {
      const next = confirmingTurns(reading, judged, tried);
      if (next === undefined) {
        setAloneWhy('the neighbouring counts were tried and found wanting, so there is nothing left to confirm it with');
        setKept(reading);
        setStep('estimate');
        return;
      }
      setTurns(next);
      return;
    }
    const previous = good[good.length - 2]!;
    const crossingNow = cross ?? crossing;
    const a = agreement(previous, reading, crossingNow);
    setAgree(a);
    if (a && !a.agrees) return;
    setCrossing(commonCrossing(previous, reading) ?? crossingNow);
    setKept(betterReading(previous, reading));
    setStep('estimate');
  };

  const measureWinding = async () => {
    const points = await vna.sweep(`Measuring the ${turns}-turn winding…`);
    if (points) took(points, `${vna.instrument?.name ?? 'VNA'}, ${vna.range.startMHz}–${vna.range.stopMHz} MHz`);
  };

  const open = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      took(parseTouchstone(await file.text()).points, file.name);
    } catch (problem) {
      setMessage(problem instanceof TouchstoneError ? problem.message : String(problem));
    }
  };

  const useAlone = () => {
    const last = readings[readings.length - 1];
    if (!last) return;
    setKept(last);
    setStep('estimate');
  };

  // The estimate: the kept reading as a profile on the size the design has now - the
  // shape, which decides, is the same whatever size is typed; only the mu' level moves.
  const estimate = useMemo(() => {
    if (!kept) return undefined;
    const profile = makeProfile({
      name: 'this core',
      size: { ...current, id: 'custom', name: current.name },
      family: 'NiZn',
      mix: 'unknown',
      setup: { turns: kept.turns, strayPf: 0, stack: 1 },
      sweep: kept.points.map((p) => ({ fMHz: p.fMHz, r: p.z.re, x: p.z.im })),
      sourceFile: kept.source,
      coreCrossingMHz: crossing,
    });
    return { profile, guess: identifyCore(profile, compareWith) };
  }, [kept, current, compareWith, crossing]);

  const toSave = () => {
    const mix = estimate?.guess.suggestedMix;
    setMixName(mix?.callIt ?? 'unknown');
    setFamily(mix?.family ?? 'NiZn');
    // The catalogue size under the design, or the one its dimensions match (a measured core is "custom" by id).
    const near = nearestSize(current);
    setSizeId(CORES.some((c) => c.id === design.coreId) ? design.coreId : near ? near.core.id : 'custom');
    setCustom({ odMm: current.odMm, idMm: current.idMm, heightMm: current.heightMm, shape: current.shape ?? 'ring' });
    setName('');
    setStep('save');
  };

  const keep = () => {
    if (!kept) return;
    const size = chosenSize();
    const confirmed = readings.length > 1 && agree ? `; a second winding agreed within ${Math.abs(Math.round((agree.ratio - 1) * 100))} %` : '';
    const profile = makeProfile({
      name: name.trim() || `${size.name} ${mixName.trim() || 'unknown'}`.trim(),
      size: { ...size, id: 'custom' },
      family,
      mix: mixName.trim() || 'unknown mix',
      setup: { turns: kept.turns, strayPf: 0, stack: 1 },
      sweep: kept.points.map((p) => ({ fMHz: p.fMHz, r: p.z.re, x: p.z.im })),
      sourceFile: kept.source,
      coreCrossingMHz: crossing,
      notes: `Measured step by step: ${kept.turns}-turn winding${confirmed}${crossing !== undefined ? `; both windings went capacitive at ${crossing.toFixed(2)} MHz - the core itself` : ''}. EMWS's guess: ${estimate?.guess.best ? who(estimate.guess.best) : 'none'}.`,
    });
    const other = readings.find((r) => r !== kept);
    if (other && agree) profile.confirmed = { turns: other.turns, sweep: other.points.map((p) => ({ fMHz: p.fMHz, r: p.z.re, x: p.z.im })), agreedWithin: Math.abs(agree.ratio - 1), coreCrossingMHz: crossing };
    onAddProfiles([profile]);
    setMessage(`Kept ${profile.name} under Your cores.`);
    setStep('done');
  };

  const another = () => {
    reset();
    setStep(mode === 'file' ? 'wind' : vna.instrument ? 'wind' : 'connect');
  };

  const saved = profiles.find((p) => p.id === savedId);
  const savedGuess = saved ? identifyCore(saved, compareWith) : undefined;
  const nextStandard = STANDARDS.find((s) => !vna.standards[s.id]);

  /** What the wind step asks for. */
  const instruction = (): string => {
    if (agree && !agree.agrees) {
      return `The two windings disagree by ${Math.abs(Math.round((agree.ratio - 1) * 100))} % once the turns are allowed for: a turn miscounted, or a poor contact? Rewind ${turns} turns, check the count and the connections, and measure again - or use the better reading anyway.`;
    }
    if (judgement && judgement.verdict !== 'good') return `${judgement.why} Wind ${turns} ${turns === 1 ? 'turn' : 'turns'} and measure again.`;
    if (judgement && readings.length === 1) return `That reading is good: ${judgement.why} One more winding, to confirm it: wind ${turns} ${turns === 1 ? 'turn' : 'turns'} this time and measure again.`;
    return `Wind ${turns} turns of insulated wire through the core - spread them round the ring, leads as short as you can - and connect the two ends to the VNA's port 1. Then measure.`;
  };

  return (
    <section className="form-section">
      <details>
        <summary>What is this core? Let EMWS guess</summary>
        <div className="core-guess">
          {step === 'idle' && (
            <>
              <p className="muted">
                An unlabelled core in your hand: EMWS takes it from there - connects the VNA, calibrates it if it needs to, tells you what to wind, measures, judges
                each reading and asks for the next, then says which mix it most resembles, and keeps the core under <em>Your cores</em> with a name you give it.
              </p>
              <div className="button-row">
                <button type="button" onClick={() => start('vna')}>
                  Guess what this core is
                </button>
                <button type="button" className="small" onClick={() => start('file')}>
                  Guess from a .s1p of a winding
                </button>
              </div>
              {profiles.length > 0 && (
                <label className="field">
                  <span className="field-label">Guess a saved core</span>
                  <select value={savedId} onChange={(e) => setSavedId(e.target.value)}>
                    <option value="">—</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {saved && savedGuess && <GuessView guess={savedGuess} profile={saved} onCall={(mix) => onUpdateProfile({ ...saved, mix: mix.callIt ?? mix.name, family: mix.family })} />}
            </>
          )}

          {step === 'connect' && (
            <>
              <p className="core-guess-step">
                <strong>Step 1 - connect.</strong> Plug the VNA in by USB (or start the EMWS VNA bridge for an instrument on the network) and press Connect. The
                sweep will be {vna.range.startMHz}–{vna.range.stopMHz} MHz, {vna.range.points} points: low enough for a manganese-zinc core's knee, high enough
                for nickel-zinc, dense enough for both. Change it below only if the instrument cannot go that low (some FieldFoxes start at 2 MHz).
              </p>
              <div className="field-row">
                <NumberField label="Sweep from" value={vna.range.startMHz} above={0} unit="MHz" onCommit={(v) => vna.setRange({ ...vna.range, startMHz: Math.min(v, vna.range.stopMHz * 0.99) })} />
                <NumberField label="to" value={vna.range.stopMHz} above={0} unit="MHz" onCommit={(v) => vna.setRange({ ...vna.range, stopMHz: Math.max(v, vna.range.startMHz * 1.01) })} />
                <NumberField label="Points" value={vna.range.points} min={2} integer onCommit={(v) => vna.setRange({ ...vna.range, points: v })} />
              </div>
              <div className="vna">
                <VnaSources onConnected={vna.connected} busy={vna.busy} setBusy={vna.setBusy} onError={vna.say} />
              </div>
              <div className="button-row">
                <button type="button" className="small" onClick={() => setStep('idle')}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {step === 'calibrate' && nextStandard && (
            <>
              <p className="core-guess-step">
                <strong>Step 2 - calibrate.</strong> <strong>{vna.instrument?.name}</strong> sends raw readings, so the correction is done here. Put the{' '}
                <strong>{nextStandard.label.toLowerCase()}</strong> on the port - {nextStandard.hint} - at the end of whatever cable the core will hang from, and
                press the button. {Object.keys(vna.standards).length} of 3 done.
              </p>
              <div className="button-row">
                <button type="button" onClick={() => vna.measureStandard(nextStandard.id)} disabled={vna.busy !== undefined}>
                  {vna.busy ?? `Measure the ${nextStandard.label.toLowerCase()}`}
                </button>
                <button type="button" className="small" onClick={() => setStep('idle')}>
                  Cancel
                </button>
              </div>
            </>
          )}

          {step === 'wind' && (
            <>
              <p className="core-guess-step">
                <strong>Step {mode === 'file' ? 1 : vna.needsCalibration ? 3 : 2} - wind and measure.</strong> {instruction()}
              </p>
              {mode === 'file' && (
                <div className="field-row">
                  <NumberField label="Turns on the winding in the file" value={turns} min={1} integer onCommit={setTurns} />
                </div>
              )}
              <div className="button-row">
                {mode === 'vna' ? (
                  <button type="button" onClick={measureWinding} disabled={vna.busy !== undefined || !vna.instrument}>
                    {vna.busy ?? `Measure the ${turns}-turn winding`}
                  </button>
                ) : (
                  <button type="button" onClick={() => fileInput.current?.click()}>
                    Open the .s1p of the {turns}-turn winding
                  </button>
                )}
                {mode === 'vna' && (
                  <button type="button" className="small" onClick={() => fileInput.current?.click()} disabled={vna.busy !== undefined}>
                    …or open a .s1p of it
                  </button>
                )}
                <input ref={fileInput} type="file" accept=".s1p,.txt,text/plain" hidden onChange={open} />
                {readings.length > 0 && (
                  <button type="button" className="small" onClick={useAlone} disabled={vna.busy !== undefined}>
                    Use the reading I have
                  </button>
                )}
                <button type="button" className="small" onClick={() => setStep('idle')} disabled={vna.busy !== undefined}>
                  Cancel
                </button>
              </div>
              {vna.progress && (
                <p className="muted">
                  {vna.progress[0]} of {vna.progress[1]}
                </p>
              )}
              {mode === 'vna' && !vna.instrument && <p className="alert-inline">The instrument has gone: connect again.</p>}
            </>
          )}

          {step === 'estimate' && estimate && kept && (
            <>
              <p className="core-guess-step">
                <strong>The estimate</strong>, from the {kept.turns}-turn winding
                {readings.length > 1 && agree
                  ? ` (a second winding agreed within ${Math.abs(Math.round((agree.ratio - 1) * 100))} %${crossing !== undefined ? `; both went capacitive at ${crossing.toFixed(2)} MHz - the core itself, so the curve is trusted up to there` : ''})`
                  : aloneWhy
                    ? ` (used alone: ${aloneWhy})`
                    : ''}
                :
              </p>
              <GuessView guess={estimate.guess} profile={estimate.profile} sizeNote={`taking the core as ${current.name} - give its size when you keep it`} />
              <div className="button-row">
                <button type="button" onClick={toSave}>
                  Save this core…
                </button>
                <button type="button" className="small" onClick={() => setStep('wind')}>
                  Measure one more winding
                </button>
                <button type="button" className="small" onClick={another}>
                  Measure another core
                </button>
                <button type="button" className="small" onClick={() => setStep('idle')}>
                  Done
                </button>
              </div>
            </>
          )}

          {step === 'save' && kept && (
            <>
              <p className="core-guess-step">
                <strong>Keep it.</strong> Give the core a name and its size - measure the ring with calipers if it is not a catalogue one - and it goes under{' '}
                <em>Your cores</em> with the whole sweep, as any measured core does.
              </p>
              <label className="field">
                <span className="field-label">Call it</span>
                <span className="field-input">
                  <input type="text" value={name} placeholder={`${chosenSize().name} ${mixName}`} onChange={(e) => setName(e.target.value)} />
                </span>
              </label>
              <label className="field">
                <span className="field-label">Size</span>
                <select value={sizeId} onChange={(e) => setSizeId(e.target.value)}>
                  {CORES.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.odMm} × {c.idMm} × {c.heightMm} mm)
                    </option>
                  ))}
                  <option value="custom">Custom dimensions…</option>
                </select>
              </label>
              {sizeId === 'custom' && (
                <div className="field-row">
                  <NumberField label="Outside" value={custom.odMm} above={0} unit="mm" onCommit={(v) => setCustom({ ...custom, odMm: v })} />
                  <NumberField label="Inside" value={custom.idMm} above={0} unit="mm" onCommit={(v) => setCustom({ ...custom, idMm: v })} />
                  <NumberField label={custom.shape === 'sleeve' ? 'Length' : 'Height'} value={custom.heightMm} above={0} unit="mm" onCommit={(v) => setCustom({ ...custom, heightMm: v })} />
                  <label className="field">
                    <span className="field-label">Shape</span>
                    <select value={custom.shape} onChange={(e) => setCustom({ ...custom, shape: e.target.value === 'sleeve' ? 'sleeve' : 'ring' })}>
                      <option value="ring">Ring</option>
                      <option value="sleeve">Sleeve (tube)</option>
                    </select>
                  </label>
                </div>
              )}
              <div className="field-row">
                <label className="field">
                  <span className="field-label">What it is</span>
                  <span className="field-input">
                    <input type="text" value={mixName} onChange={(e) => setMixName(e.target.value)} />
                  </span>
                </label>
                <label className="field">
                  <span className="field-label">Family</span>
                  <select value={family} onChange={(e) => setFamily(e.target.value === 'MnZn' ? 'MnZn' : 'NiZn')}>
                    <option value="NiZn">Nickel-zinc (#43, #52, #61…)</option>
                    <option value="MnZn">Manganese-zinc (#31, #73, #77…)</option>
                  </select>
                </label>
              </div>
              <div className="button-row">
                <button type="button" onClick={keep} disabled={sizeId === 'custom' && !(custom.odMm > custom.idMm && custom.idMm > 0 && custom.heightMm > 0)}>
                  Keep it
                </button>
                <button type="button" className="small" onClick={() => setStep('estimate')}>
                  Back
                </button>
              </div>
            </>
          )}

          {step === 'done' && (
            <>
              <p className="core-guess-step">
                <strong>{message}</strong>
              </p>
              <div className="button-row">
                <button type="button" onClick={another}>
                  Measure another core
                </button>
                <button type="button" className="small" onClick={() => setStep('idle')}>
                  Finish
                </button>
              </div>
            </>
          )}

          {step !== 'done' && message && <p className="alert-inline">{message}</p>}
          {vna.error && step !== 'idle' && <p className="alert-inline">{vna.error}</p>}
        </div>
      </details>
    </section>
  );
}
