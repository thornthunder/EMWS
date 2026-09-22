// The transformer engine, held to things that must be true whatever the design:
// energy is conserved, an ideal transformer transforms ideally, a matched line stays
// matched, and a measurement run backwards gives back what went in.
//
// None of this proves the model matches a transformer on a bench - only a bench can do
// that. What it proves is that the model is internally sound, so that when it disagrees
// with a measurement the disagreement is about ferrite and strays, not arithmetic.

import { describe, expect, it } from 'vitest';
import { cAbs } from '../src/lib/complex';
import {
  MU0,
  coreImpedance,
  debyePermeability,
  inductanceFactor,
  interpolatePermeability,
  permeabilityFromImpedance,
  snoekRelaxationMHz,
  toroidGeometry,
} from '../src/lib/ferrite';
import { CORES, MATERIALS, type Material, awgMm } from '../src/tools/balun/catalog';
import { analyse } from '../src/tools/balun/circuit';
import { permeabilityCurve, trustworthyUpToMHz } from '../src/tools/balun/measure';
import { makeProfile, profileMaterial } from '../src/tools/balun/profiles';
import {
  type Design,
  checkDesign,
  chokeDesign,
  crossover,
  efhwDesign,
  guanella4Design,
  summarise,
  tap,
  tappedTurns,
  turnsThatFit,
  wind,
} from '../src/tools/balun/model';
import { copperOhmsPerM, windingCapacitanceF } from '../src/tools/balun/strays';

const ft240 = CORES.find((c) => c.id === 'FT240')!;
const mix43 = MATERIALS.find((m) => m.id === '43')!;

/** A core that stores perfectly and loses nothing: what an ideal transformer is wound on. */
const perfect: Material = {
  id: 'perfect',
  name: 'perfect',
  family: 'NiZn',
  muInitial: 1e9,
  curve: [{ fMHz: 1, real: 1e9, loss: 0 }],
  note: 'test',
};

describe('the shape of a toroid', () => {
  const g = toroidGeometry(ft240.odMm, ft240.idMm, ft240.heightMm);

  it('gives the effective area and path the core-constant method should', () => {
    // Worked by hand from OD 60.96, ID 35.56, height 12.7 mm.
    expect(g.areaM2 * 1e6).toBeCloseTo(157.7, 0);
    expect(g.pathM * 1e3).toBeCloseTo(144.6, 0);
  });

  it('makes inductance from C1 agree with mu0 mu N^2 Ae / le', () => {
    const viaC1 = inductanceFactor(g, 800);
    const viaAeLe = (MU0 * 800 * g.areaM2) / g.pathM;
    expect(viaC1).toBeCloseTo(viaAeLe, 15);
    // An FT240 at mu = 800, from 2.40 x 1.40 x 0.50 inches exactly: a figure to hold
    // against a datasheet. (Rounding the size to 61.0 x 35.55 mm gives 1097 instead.)
    expect(viaC1 * 1e9).toBeCloseTo(1095.2, 1);
  });

  it('counts two stacked cores as one twice as tall', () => {
    const two = toroidGeometry(ft240.odMm, ft240.idMm, ft240.heightMm, 2);
    expect(inductanceFactor(two, 800)).toBeCloseTo(2 * inductanceFactor(g, 800), 15);
    expect(two.pathM).toBeCloseTo(g.pathM, 12); // the path round the ring has not changed
  });
});

describe('permeability against frequency', () => {
  it('holds at the initial value low down, and halves at the relaxation frequency', () => {
    expect(debyePermeability(800, 7, 0.001).real).toBeCloseTo(800, 1);
    const at = debyePermeability(800, 7, 7);
    expect(at.real).toBeCloseTo(1 + 799 / 2, 9);
    expect(at.loss).toBeCloseTo(799 / 2, 9);
  });

  it('puts the loss peak at the relaxation frequency', () => {
    const peak = debyePermeability(800, 7, 7).loss;
    expect(debyePermeability(800, 7, 5).loss).toBeLessThan(peak);
    expect(debyePermeability(800, 7, 10).loss).toBeLessThan(peak);
  });

  it('is exactly a fixed resistor across a fixed inductor', () => {
    // mu_i / (1 + j f/f_r) on a core is, identically, L = L0 mu_i in parallel with
    // R = 2 pi f_r L - at every frequency. So a single-relaxation core puts a constant
    // resistance across the radio, which is why its loss is flat across the band. It
    // also checks the permeability and the impedance code against each other by a
    // route neither of them was written from.
    const g = toroidGeometry(ft240.odMm, ft240.idMm, ft240.heightMm);
    const turns = 2;
    const muI = 800;
    const fr = 7;
    const L = (MU0 * (muI - 1) * turns * turns) / g.c1; // the relaxing part
    const R = 2 * Math.PI * fr * 1e6 * L;
    for (const f of [1.8, 3.6, 7, 14.2, 28.5]) {
      const w = 2 * Math.PI * f * 1e6;
      // R parallel jwL, plus the mu = 1 of free space that never relaxes
      const d = R * R + (w * L) ** 2;
      const expected = { re: (R * (w * L) ** 2) / d, im: (R * R * w * L) / d + (w * MU0 * turns * turns) / g.c1 };
      const z = coreImpedance(g, turns, debyePermeability(muI, fr, f), f);
      expect(z.re).toBeCloseTo(expected.re, 9);
      expect(z.im).toBeCloseTo(expected.im, 9);
    }
  });

  it('trades permeability for bandwidth, as Snoek found', () => {
    expect(snoekRelaxationMHz(800, 'NiZn')).toBeCloseTo(5600 / 799, 9);
    expect(snoekRelaxationMHz(125, 'NiZn')).toBeGreaterThan(snoekRelaxationMHz(800, 'NiZn'));
  });

  it('reads a measured curve on a log axis and does not extrapolate', () => {
    const curve = [
      { fMHz: 1, real: 800, loss: 10 },
      { fMHz: 100, real: 100, loss: 300 },
    ];
    // 10 MHz is half way from 1 to 100 on a log axis.
    expect(interpolatePermeability(curve, 10)).toEqual({ real: 450, loss: 155 });
    expect(interpolatePermeability(curve, 0.1)).toEqual({ real: 800, loss: 10 });
    expect(interpolatePermeability(curve, 1000)).toEqual({ real: 100, loss: 300 });
  });

  it('turns permeability into impedance and back without loss', () => {
    const g = toroidGeometry(ft240.odMm, ft240.idMm, ft240.heightMm);
    const mu = { real: 470, loss: 230 };
    const z = coreImpedance(g, 8, mu, 3.6);
    // The lossy part is the resistance, the storing part the reactance.
    expect(z.re / z.im).toBeCloseTo(mu.loss / mu.real, 12);
    const back = permeabilityFromImpedance(z, g, 8, 3.6);
    expect(back.real).toBeCloseTo(470, 9);
    expect(back.loss).toBeCloseTo(230, 9);
  });
});

describe('a winding described as steps', () => {
  it('adds up the way it was wound: 2, tap, 5, cross over, 7', () => {
    const steps = [wind(2), tap(), wind(5), crossover(), wind(7)];
    expect(summarise(steps)).toEqual({ totalTurns: 14, taps: [2], crossoverAt: 7 });
    const design = { ...efhwDesign(), steps };
    expect(tappedTurns(design)).toEqual({ primary: 2, total: 14 });
    expect(analyse(design, mix43).ratio).toBeCloseTo(49, 12);
  });

  it('knows how many turns a core will take', () => {
    const design = efhwDesign();
    // 18 AWG PTFE is 1.62 mm over the insulation; the inside of an FT240 is 35.56 mm.
    expect(turnsThatFit(design)).toBe(65);
    expect(checkDesign(design).filter((i) => i.severity === 'error')).toEqual([]);
    const tooMany = { ...design, steps: [wind(2), tap(), wind(78)] };
    expect(checkDesign(tooMany).some((i) => i.message.includes('will not fit'))).toBe(true);
  });

  it('refuses what cannot be built', () => {
    expect(checkDesign({ ...efhwDesign(), steps: [wind(14)] }).some((i) => i.message.includes('needs a tap'))).toBe(true);
    expect(checkDesign({ ...chokeDesign(), conductor: { kind: 'wire', wireId: 'awg18-ptfe' } }).some((i) => i.severity === 'error')).toBe(true);
    // The trap: a 1:4 Guanella on one core, into a load with one side earthed.
    const trap = { ...guanella4Design(), positions: 1 as const, loadGrounded: true };
    expect(checkDesign(trap).some((i) => i.message.includes('ONE core'))).toBe(true);
    expect(checkDesign({ ...trap, loadGrounded: false }).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('follows the AWG definition', () => {
    expect(awgMm(36)).toBeCloseTo(0.127, 9);
    expect(awgMm(18)).toBeCloseTo(1.024, 3);
  });
});

describe('a tapped transformer', () => {
  it('on a perfect core with no strays, is exactly its turns ratio squared', () => {
    const design: Design = { ...efhwDesign(), leadMm: 0, overrides: { leakageUh: 0, windingPf: 0 } };
    for (const p of analyse(design, perfect).points) {
      // 2450 / 49 = 50, plus a few milliohms of copper.
      expect(p.zIn.re).toBeCloseTo(50, 1);
      expect(Math.abs(p.zIn.im)).toBeLessThan(0.01);
      expect(p.swr).toBeLessThan(1.001);
      expect(p.coreW).toBeCloseTo(0, 9);
      expect(p.lossDb).toBeLessThan(0.01);
    }
  });

  it('accounts for every watt, at every frequency', () => {
    for (const design of [efhwDesign(), { ...efhwDesign(), compensationPf: 120 }, guanella4Design(), chokeDesign()]) {
      for (const p of analyse(design, mix43).points) {
        expect(p.loadW + p.coreW + p.copperW).toBeCloseTo(p.acceptedW, 9);
        expect(p.coreW).toBeGreaterThanOrEqual(-1e-12);
        expect(p.copperW).toBeGreaterThanOrEqual(-1e-12);
        expect(p.acceptedW).toBeLessThanOrEqual(design.powerW + 1e-9);
      }
    }
  });

  it('runs cooler on the low bands with more turns on the input', () => {
    const two = analyse({ ...efhwDesign(), steps: [wind(2), tap(), wind(12)] }, mix43).points[0]!;
    const three = analyse({ ...efhwDesign(), steps: [wind(3), tap(), wind(18)] }, mix43).points[0]!;
    expect(two.fMHz).toBeCloseTo(1.8, 9);
    // Same 49:1, but 9/4 the magnetising impedance across the radio.
    expect(three.coreW).toBeLessThan(two.coreW);
    expect(cAbs(three.zCore) / cAbs(two.zCore)).toBeCloseTo(9 / 4, 9);
    expect(three.fluxMt).toBeLessThan(two.fluxMt);
  });

  it('is loaded by its own capacitance at the top of the band, which a crossover helps', () => {
    // A small core wound all the way round, so the two ends of the winding meet.
    const full: Design = { ...efhwDesign(), coreId: 'FT50', conductor: { kind: 'wire', wireId: 'awg20-enamel' }, steps: [wind(3), tap(), wind(19)] };
    const crossed: Design = { ...full, steps: [wind(3), tap(), wind(8), crossover(), wind(11)] };
    expect(checkDesign(full).filter((i) => i.severity === 'error')).toEqual([]);
    expect(windingCapacitanceF(crossed)).toBeLessThan(windingCapacitanceF(full));
    // On a core the winding only part-fills, the ends never meet and it makes no difference.
    const sparse = efhwDesign();
    const sparseStraight = { ...sparse, steps: [wind(2), tap(), wind(12)] };
    expect(windingCapacitanceF(sparse)).toBeCloseTo(windingCapacitanceF(sparseStraight), 18);
  });

  it('treats a nickel-zinc core as the dielectric it is, and a manganese-zinc one as a conductor', () => {
    // Through a conducting core every turn couples to every other; through a dielectric
    // one the path has to cross the ferrite as well, which is a capacitance in series.
    const nizn = windingCapacitanceF(efhwDesign(), 'NiZn');
    const mnzn = windingCapacitanceF(efhwDesign(), 'MnZn');
    expect(nizn).toBeLessThan(mnzn / 2);
    expect(nizn * 1e12).toBeGreaterThan(0.2);
    expect(mnzn * 1e12).toBeLessThan(10);
  });

  it('lets a capacitor across the input help at the top of the band, as it does on the bench', () => {
    // Anyone who has built a 49:1 knows this. A model in which the capacitor only ever
    // makes things worse has its strays wrong - which is how an earlier version of this
    // one was caught treating #43 as a conductor.
    const top = (pf: number) =>
      analyse({ ...efhwDesign(), compensationPf: pf, sweep: { startMHz: 28.5, stopMHz: 28.6, points: 2 } }, mix43).points[0]!.swr;
    const best = Math.min(...[10, 22, 33, 47].map(top));
    expect(best).toBeLessThan(top(0));
    // ...and too much of it is worse than none, which is equally true on the bench.
    expect(top(330)).toBeGreaterThan(top(0));
  });

  it('lets a measurement replace an estimate', () => {
    const measured = analyse({ ...efhwDesign(), overrides: { leakageUh: 0.25, windingPf: 9 } }, mix43);
    expect(measured.strays.leakageUh).toBeCloseTo(0.25, 12);
    expect(measured.strays.windingPf).toBeCloseTo(9, 12);
  });
});

describe('a current balun', () => {
  it('passes a matched line straight through, whatever its length', () => {
    // 50-ohm coax into 50 ohms: only the copper shows.
    for (const p of analyse(chokeDesign(), mix43).points) {
      expect(p.swr).toBeLessThan(1.02);
      expect(p.lossDb).toBeLessThan(0.2);
      expect(p.coreW).toBe(0); // no common-mode voltage, so the core does no work
    }
  });

  it('chokes four times as hard with twice the turns, below its resonance', () => {
    const six = analyse({ ...chokeDesign(), steps: [wind(6)], overrides: { windingPf: 0 } }, mix43).points[0]!;
    const twelve = analyse({ ...chokeDesign(), steps: [wind(12)], overrides: { windingPf: 0 } }, mix43).points[0]!;
    expect(cAbs(twelve.zCore) / cAbs(six.zCore)).toBeCloseTo(4, 9);
  });

  it('resonates with its own capacitance, and is capacitive above that', () => {
    const points = analyse({ ...chokeDesign(), overrides: { windingPf: 8 } }, mix43).points;
    expect(points[0]!.zCore.im).toBeGreaterThan(0);
    expect(points[points.length - 1]!.zCore.im).toBeLessThan(0);
  });
});

describe('a 1:4 Guanella', () => {
  const matched: Design = { ...guanella4Design(), overrides: { lineZ0: 100 } };

  it('quarters the load when its lines are half the load impedance', () => {
    expect(analyse(matched, perfect).ratio).toBe(4);
    for (const p of analyse(matched, perfect).points) {
      // Each 100-ohm line sees half of 200 ohms: matched, so length does not matter.
      expect(p.zIn.re).toBeCloseTo(50, 0);
      expect(p.swr).toBeLessThan(1.02);
    }
  });

  it('is worse at the top of the band with the wrong line', () => {
    const top = (d: Design) => analyse(d, perfect).points.at(-1)!.swr;
    expect(top({ ...matched, overrides: { lineZ0: 50 } })).toBeGreaterThan(top(matched));
  });

  it('shares the work between two cores when the load floats, and not when it is earthed', () => {
    const floating = analyse(matched, mix43).points[0]!;
    const earthed = analyse({ ...matched, loadGrounded: true }, mix43).points[0]!;
    // Floating: the two chokes are in series across the input. Earthed: one does it all.
    expect(earthed.coreW).toBeGreaterThan(floating.coreW);
    expect(earthed.fluxMt).toBeGreaterThan(floating.fluxMt);
  });
});

describe('measuring a core', () => {
  const setup = { core: ft240, stack: 1, turns: 8 };
  const g = toroidGeometry(ft240.odMm, ft240.idMm, ft240.heightMm);
  const truth = (fMHz: number) => debyePermeability(800, 7, fMHz);
  const sweep = (strayPf: number) =>
    Array.from({ length: 40 }, (_, i) => {
      const fMHz = 1 * 30 ** (i / 39);
      const zCore = coreImpedance(g, 8, truth(fMHz), fMHz);
      // Put the stray across it, as a real winding has.
      const w = 2 * Math.PI * fMHz * 1e6;
      const yr = zCore.re / (zCore.re ** 2 + zCore.im ** 2);
      const yi = -zCore.im / (zCore.re ** 2 + zCore.im ** 2) + w * strayPf * 1e-12;
      const z = { re: yr / (yr * yr + yi * yi), im: -yi / (yr * yr + yi * yi) };
      return { fMHz, z, gamma: { re: 0, im: 0 } };
    });

  it('reads back the permeability that made the impedance', () => {
    for (const p of permeabilityCurve(sweep(0), setup)) {
      expect(p.real).toBeCloseTo(truth(p.fMHz).real, 6);
      expect(p.loss).toBeCloseTo(truth(p.fMHz).loss, 6);
    }
  });

  it('takes a known winding capacitance back out', () => {
    for (const p of permeabilityCurve(sweep(15), { ...setup, strayPf: 15 })) {
      expect(p.real).toBeCloseTo(truth(p.fMHz).real, 5);
      expect(p.loss).toBeCloseTo(truth(p.fMHz).loss, 5);
    }
  });

  it('says where a reading stops being the core and becomes the winding', () => {
    // A bare lossy core: its reactance peaks and FALLS above the relaxation frequency,
    // all by itself. That is the material, not a fault, and must not be flagged.
    const bare = sweep(0);
    const peakAt = bare.reduce((best, p) => (p.z.im > best.z.im ? p : best)).fMHz;
    expect(peakAt).toBeGreaterThan(5);
    expect(peakAt).toBeLessThan(9); // about the 7 MHz relaxation, well inside the sweep
    expect(trustworthyUpToMHz(bare)).toBeUndefined();

    // With capacitance across it the winding resonates, goes capacitive, and is flagged
    // at a third of that frequency - where the reading is already an eighth out.
    const loaded = sweep(40);
    const resonance = loaded.find((p) => p.z.im <= 0)!.fMHz;
    expect(resonance).toBeGreaterThan(1);
    expect(resonance).toBeLessThan(30);
    expect(trustworthyUpToMHz(loaded)).toBeCloseTo(resonance / 3, 12);
  });

  it('becomes a core profile that the engine uses instead of the estimate', () => {
    const profile = makeProfile({
      name: 'My FT240',
      size: ft240,
      family: 'NiZn',
      mix: '#43',
      setup: { turns: 8, strayPf: 0, stack: 1 },
      sweep: sweep(0).map((p) => ({ fMHz: p.fMHz, r: p.z.re, x: p.z.im })),
    });
    const material = profileMaterial(profile);
    expect(material.muInitial).toBeGreaterThan(700);
    expect(material.id).toBe(`core:${profile.id}`);
    const analysis = analyse(efhwDesign(), material);
    expect(analysis.measuredMaterial).toBe(true);
    expect(analyse(efhwDesign(), mix43).measuredMaterial).toBe(false);
  });
});

describe('copper at radio frequency', () => {
  it('is plain resistance until the skin is thinner than the wire, then rises', () => {
    const dc = 1.68e-8 / ((Math.PI * 0.001 ** 2) / 4);
    expect(copperOhmsPerM(1, 0.0001)).toBeCloseTo(dc, 9);
    expect(copperOhmsPerM(1, 30)).toBeGreaterThan(copperOhmsPerM(1, 3.5));
    expect(copperOhmsPerM(1, 3.5)).toBeGreaterThan(dc);
  });
});
