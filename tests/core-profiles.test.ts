// Core profiles: a measured core, kept. What must hold is that nothing is lost on the
// way to a file and back, that a file which is not one of ours is refused rather than
// half-read, and that correcting a measurement re-derives the curve from the sweep
// instead of trusting whatever the file said.

import { describe, expect, it } from 'vitest';
import { coreImpedance, debyePermeability, toroidGeometry } from '../src/lib/ferrite';
import { CORES } from '../src/tools/balun/catalog';
import { efhwDesign, withCatalogueCore, withCustomDimensions, withProfile } from '../src/tools/balun/model';
import {
  type CoreProfile,
  ProfileFileError,
  exportProfiles,
  importProfiles,
  initialPermeability,
  isProfile,
  loadProfiles,
  makeProfile,
  profileIdOfMaterial,
  profileMaterial,
  rederive,
  suggestedFileName,
} from '../src/tools/balun/profiles';

const ft240 = CORES.find((c) => c.id === 'FT240')!;
const g = toroidGeometry(ft240.odMm, ft240.idMm, ft240.heightMm);

/** A sweep of eight turns on a #43-like core, with a stray capacitance across the winding. */
function sweep(strayPf: number) {
  return Array.from({ length: 30 }, (_, i) => {
    const fMHz = 1 * 30 ** (i / 29);
    const z = coreImpedance(g, 8, debyePermeability(800, 7, fMHz), fMHz);
    const w = 2 * Math.PI * fMHz * 1e6;
    const yr = z.re / (z.re ** 2 + z.im ** 2);
    const yi = -z.im / (z.re ** 2 + z.im ** 2) + w * strayPf * 1e-12;
    return { fMHz, r: yr / (yr * yr + yi * yi), x: -yi / (yr * yr + yi * yi) };
  });
}

function profile(strayPf = 0, taken = strayPf): CoreProfile {
  return makeProfile({
    name: 'Bench FT240 #43',
    size: ft240,
    family: 'NiZn',
    mix: '#43',
    setup: { turns: 8, strayPf: taken, stack: 1 },
    sweep: sweep(strayPf),
    sourceFile: 'ft240.s1p',
    notes: 'the one with the chipped edge',
  });
}

describe('a core profile', () => {
  it('derives its curve from the sweep, and knows what it is', () => {
    const p = profile();
    expect(p.curve.length).toBe(30);
    expect(initialPermeability(p)).toBe(Math.round(debyePermeability(800, 7, 1).real)); // 784: relaxing already at 1 MHz
    expect(p.trustworthyUpToMHz).toBeUndefined();
    expect(p.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('flags a sweep in which the test winding resonated', () => {
    const p = profile(400, 0);
    expect(p.trustworthyUpToMHz).toBeDefined();
    expect(p.trustworthyUpToMHz!).toBeLessThan(30);
  });

  it('re-derives from the sweep when the setup is corrected, keeping its identity', () => {
    const wrong = profile(15, 0); // measured with 15 pF across it, but not told so
    const right = rederive(wrong, { strayPf: 15 });
    expect(right.id).toBe(wrong.id);
    expect(right.measuredAt).toBe(wrong.measuredAt);
    expect(right.sweep).toEqual(wrong.sweep);
    // With the stray taken out, the curve is the bare core's again.
    for (const pt of right.curve) {
      expect(pt.real).toBeCloseTo(debyePermeability(800, 7, pt.fMHz).real, 3);
    }
    // ...whereas the uncorrected one is inflated towards the top of the sweep.
    const top = wrong.curve[wrong.curve.length - 1]!;
    expect(top.real).not.toBeCloseTo(debyePermeability(800, 7, top.fMHz).real, 0);
  });

  it('is a material to the engine, and can be told apart from a catalogue mix', () => {
    const p = profile();
    const m = profileMaterial(p);
    expect(m.curve).toBe(p.curve);
    expect(m.family).toBe('NiZn');
    expect(profileIdOfMaterial(m.id)).toBe(p.id);
    expect(profileIdOfMaterial('43')).toBeUndefined();
  });
});

describe('putting a profile under a design', () => {
  it('brings its size and its curve together, and remembers which core it is', () => {
    const p = profile();
    const d = withProfile(efhwDesign(), { id: p.id, name: p.name, size: p.size, materialId: profileMaterial(p).id });
    expect(d.profileId).toBe(p.id);
    expect(d.coreId).toBe('custom');
    expect(d.customCore?.odMm).toBe(ft240.odMm);
    expect(d.customCore?.name).toBe('Bench FT240 #43');
    expect(d.materialId).toBe(`core:${p.id}`);
  });

  it('is left behind the moment a catalogue core is picked or the dimensions are edited', () => {
    const p = profile();
    const d = withProfile(efhwDesign(), { id: p.id, name: p.name, size: p.size, materialId: profileMaterial(p).id });
    expect(withCatalogueCore(d, 'FT140', '52').profileId).toBeUndefined();
    const edited = withCustomDimensions(d, { odMm: 70 });
    expect(edited.profileId).toBeUndefined();
    expect(edited.customCore?.odMm).toBe(70);
    expect(edited.customCore?.idMm).toBe(ft240.idMm); // the rest carried over
  });
});

describe('profile files', () => {
  it('survive a trip through a file with nothing lost', () => {
    const before = [profile(), { ...profile(15), name: 'Second core', mix: 'unknown' }];
    const text = exportProfiles(before);
    expect(JSON.parse(text)).toMatchObject({ emws: 'core-profiles', version: 1 });

    const after = importProfiles(text);
    expect(after).toHaveLength(2);
    for (const [i, p] of after.entries()) {
      const b = before[i]!;
      expect(p.name).toBe(b.name);
      expect(p.mix).toBe(b.mix);
      expect(p.size).toEqual(b.size);
      expect(p.setup).toEqual(b.setup);
      expect(p.sweep).toEqual(b.sweep);
      expect(p.measuredAt).toBe(b.measuredAt);
      expect(p.notes).toBe(b.notes);
      expect(p.sourceFile).toBe(b.sourceFile);
      // The curve is re-derived, not copied - and so it agrees.
      expect(p.curve).toEqual(b.curve);
      // A fresh id, so importing never overwrites a core already here.
      expect(p.id).not.toBe(b.id);
    }
  });

  it('re-derives the curve rather than trusting the file', () => {
    const text = exportProfiles([profile()]);
    const tampered = JSON.parse(text) as { profiles: CoreProfile[] };
    tampered.profiles[0]!.curve = [{ fMHz: 1, real: 99999, loss: 0 }];
    const [p] = importProfiles(JSON.stringify(tampered));
    expect(p!.curve.length).toBe(30);
    expect(initialPermeability(p!)).toBe(Math.round(debyePermeability(800, 7, 1).real));
  });

  it('refuses anything that is not one of ours, and says why', () => {
    expect(() => importProfiles('not json')).toThrow(ProfileFileError);
    expect(() => importProfiles('{"hello":"world"}')).toThrow(/not an EMWS core profile file/);
    expect(() => importProfiles(JSON.stringify({ emws: 'core-profiles', version: 2, profiles: [] }))).toThrow(/version 2/);
    expect(() => importProfiles(JSON.stringify({ emws: 'core-profiles', version: 1, profiles: [{ junk: true }] }))).toThrow(/no usable/);
  });

  it('checks the shape of a profile properly', () => {
    const p = profile();
    expect(isProfile(p)).toBe(true);
    expect(isProfile({ ...p, size: { ...p.size, odMm: 10 } })).toBe(false); // inside bigger than outside
    expect(isProfile({ ...p, family: 'iron' })).toBe(false);
    expect(isProfile({ ...p, sweep: [{ fMHz: 1, r: 'ten', x: 0 }] })).toBe(false);
    expect(isProfile({ ...p, setup: { ...p.setup, turns: 0 } })).toBe(false);
    expect(isProfile(null)).toBe(false);
  });

  it('re-derives a stored profile on load, so an empty or stale curve never reaches the engine', () => {
    // Storage holds a profile with NO curve - as an older version, or a hand-edited file,
    // might leave it. Trusting that would run the simulator on an air core.
    const stored = { ...profile(), curve: [] };
    const store = new Map<string, string>([['emws.balun.cores.v1', JSON.stringify([stored])]]);
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      configurable: true,
    });
    try {
      const [loaded] = loadProfiles();
      expect(loaded).toBeDefined();
      expect(loaded!.id).toBe(stored.id); // the same core, not a copy
      expect(loaded!.curve.length).toBe(30);
      expect(initialPermeability(loaded!)).toBe(Math.round(debyePermeability(800, 7, 1).real));
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('names the file after what is in it', () => {
    expect(suggestedFileName([profile()])).toBe('bench-ft240-43.emws-cores.json');
    expect(suggestedFileName([profile(), profile()])).toBe('2-cores.emws-cores.json');
  });
});
