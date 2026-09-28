// Saved baluns, and what the radio sees through one: the first shelf of the component
// library, and the Antenna Modeler reading from it.

import { describe, expect, it } from 'vitest';
import { CORES, MATERIALS } from '../src/tools/balun/catalog';
import { analyse, sweepFrequencies } from '../src/tools/balun/circuit';
import { type SavedBalun, isSavedBalun, loadSavedBaluns, materialFor, saveSavedBaluns } from '../src/tools/balun/library';
import { chokeDesign, efhwDesign, guanella4Design, withProfile } from '../src/tools/balun/model';
import { makeProfile, profileMaterial } from '../src/tools/balun/profiles';
import { radioSide } from '../src/tools/antenna-modeler/through';

const saved = (name: string, design = efhwDesign()): SavedBalun => ({ id: `t-${name}`, name, savedAt: '2026-09-28T00:00:00Z', summary: 'test', design });

/** A browser's storage, for one test at a time. */
function withStorage<T>(seed: Record<string, string>, body: () => T): T {
  const store = new Map(Object.entries(seed));
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    configurable: true,
  });
  try {
    return body();
  } finally {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

describe('the balun library', () => {
  it('keeps what was saved and ignores what was not a design', () => {
    withStorage({}, () => {
      expect(loadSavedBaluns()).toEqual([]);
      saveSavedBaluns([saved('my 49:1'), saved('the choke', chokeDesign())]);
      const back = loadSavedBaluns();
      expect(back.map((b) => b.name)).toEqual(['my 49:1', 'the choke']);
      expect(back[1]!.design.topology).toBe('guanella-1-1');
    });
    withStorage({ 'emws.balun.designs.v1': JSON.stringify([saved('good'), { id: 'x', name: 'junk' }, 42, null]) }, () => {
      expect(loadSavedBaluns().map((b) => b.name)).toEqual(['good']);
    });
    withStorage({ 'emws.balun.designs.v1': '{not json' }, () => expect(loadSavedBaluns()).toEqual([]));
    expect(isSavedBalun(saved('a'))).toBe(true);
    expect(isSavedBalun({ ...saved('a'), design: { topology: 'autotransformer' } })).toBe(false);
  });

  it('finds a built-in mix, and says when a measured core is gone', () => {
    const design = efhwDesign();
    expect(materialFor(design, [])).toBe(MATERIALS.find((m) => m.id === design.materialId));
    const onMissingCore = { ...design, profileId: 'gone', materialId: 'core:gone' };
    expect(materialFor(onMissingCore, [])).toBeUndefined();
  });

  it('a design wound on a measured core keeps using the measurement, wherever it is used', () => {
    // A bench sweep of 8 turns on an FT240: inductive, with loss that grows with frequency.
    const ft240 = CORES.find((c) => c.id === 'FT240')!;
    const sweep = Array.from({ length: 30 }, (_, i) => {
      const fMHz = 1 * 30 ** (i / 29);
      return { fMHz, r: 20 + 60 * Math.sqrt(fMHz), x: 2 * Math.PI * fMHz * 1e6 * 30e-6 * (1 - fMHz / 60) };
    });
    const profile = makeProfile({ name: 'My FT240', size: ft240, family: 'NiZn', mix: '#43', setup: { turns: 8, strayPf: 0, stack: 1 }, sweep });
    const design = withProfile(efhwDesign(), { id: profile.id, name: profile.name, size: profile.size, materialId: profileMaterial(profile).id }, 1);
    const material = materialFor(design, [profile]);
    expect(material).toBeDefined();
    expect(material!.id).toBe(`core:${profile.id}`);
    expect(material!.curve!.length).toBeGreaterThan(0);
    // Deleting the profile leaves the saved design honest: no material, rather than a guess.
    expect(materialFor(design, [])).toBeUndefined();
    // And the radio side comes out of the measured curve, not the built-in estimate.
    const measured = radioSide({ saved: saved('mine', design), material: material! }, [{ fMHz: 7.1, z: { re: 2450, im: 0 } }])[0]!;
    const estimated = radioSide({ saved: saved('est', efhwDesign()), material: materialFor(efhwDesign(), [])! }, [{ fMHz: 7.1, z: { re: 2450, im: 0 } }])[0]!;
    expect(Number.isFinite(measured.z.re) && Number.isFinite(measured.lossDb)).toBe(true);
    expect(measured.z.re !== estimated.z.re || measured.lossDb !== estimated.lossDb).toBe(true);
  });
});

describe('through a saved balun', () => {
  const material = (design: ReturnType<typeof efhwDesign>) => materialFor(design, [])!;

  it('evaluates the balun at exactly the frequencies it is given, in that order', () => {
    const design = chokeDesign();
    const freqs = [3.5, 7.1, 14.2, 21.2];
    const points = analyse(design, material(design), undefined, freqs).points;
    expect(points.map((p) => p.fMHz)).toEqual(freqs);
    // And left alone, its own sweep: log-spaced from start to stop.
    const own = sweepFrequencies(design.sweep);
    expect(own[0]).toBeCloseTo(design.sweep.startMHz, 9);
    expect(own[own.length - 1]).toBeCloseTo(design.sweep.stopMHz, 9);
    expect(own[1]! / own[0]!).toBeCloseTo(own[2]! / own[1]!, 9);
  });

  it('a 1:1 current balun passes a 50 ohm antenna through nearly unchanged', () => {
    const design = chokeDesign();
    const radio = radioSide({ saved: saved('choke', design), material: material(design) }, [3.6, 7.1, 14.2, 28.5].map((fMHz) => ({ fMHz, z: { re: 50, im: 0 } })));
    expect(radio).toHaveLength(4);
    for (const r of radio) {
      expect(Math.abs(r.z.re - 50)).toBeLessThan(5);
      expect(Math.abs(r.z.im)).toBeLessThan(10);
      expect(r.lossDb).toBeLessThan(0.3);
      expect(r.lossDb).toBeGreaterThanOrEqual(0);
    }
  });

  it('a 1:4 Guanella brings 200 ohms to about 50, and a 49:1 brings 2450 down likewise', () => {
    const four = guanella4Design();
    const fourSide = radioSide({ saved: saved('g4', four), material: material(four) }, [{ fMHz: 7.1, z: { re: 200, im: 0 } }])[0]!;
    expect(fourSide.z.re).toBeGreaterThan(40);
    expect(fourSide.z.re).toBeLessThan(62);
    const efhw = efhwDesign();
    const efhwSide = radioSide({ saved: saved('49', efhw), material: material(efhw) }, [{ fMHz: 7.1, z: { re: 2450, im: 0 } }])[0]!;
    expect(efhwSide.z.re).toBeGreaterThan(35);
    expect(efhwSide.z.re).toBeLessThan(70);
    // What the antenna is changes what the radio sees: the same balun into a mismatch.
    const off = radioSide({ saved: saved('49', efhw), material: material(efhw) }, [{ fMHz: 7.1, z: { re: 800, im: -300 } }])[0]!;
    expect(Math.abs(off.z.re - efhwSide.z.re) + Math.abs(off.z.im - efhwSide.z.im)).toBeGreaterThan(10);
  });

  it('gives nothing for nothing', () => {
    const design = chokeDesign();
    expect(radioSide({ saved: saved('choke', design), material: material(design) }, [])).toEqual([]);
  });
});
