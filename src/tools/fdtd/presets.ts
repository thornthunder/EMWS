// Scenes worth watching, each a classic the first time you see it move.

import { CONDUCTOR, type Scene, type Shape, dielectric, emptyScene, sceneId } from './scene';

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  scene: () => Scene;
}

const line = (x1: number, y1: number, x2: number, y2: number, widthM = 0): Shape => ({ id: sceneId('shape'), geometry: { kind: 'line', x1, y1, x2, y2, widthM }, material: CONDUCTOR });

/** A chain of conductor segments through the points. */
function polyline(points: [number, number][], widthM = 0): Shape[] {
  const shapes: Shape[] = [];
  for (let n = 1; n < points.length; n++) {
    const [x1, y1] = points[n - 1]!;
    const [x2, y2] = points[n]!;
    shapes.push(line(x1, y1, x2, y2, widthM));
  }
  return shapes;
}

const source = (x: number, y: number, kind: 'sine' | 'pulse' = 'sine') => ({ id: sceneId('source'), x, y, kind, amplitude: 1, phaseDeg: 0 });

export const PRESETS: Preset[] = [
  {
    id: 'double-slit',
    name: 'Two slits',
    blurb: 'A wall with two gaps 0.4 wavelengths wide: the two openings radiate as two sources and their waves add and cancel in bands beyond it.',
    scene: () => ({
      ...emptyScene(),
      shapes: [line(1.4, 0, 1.4, 0.78), line(1.4, 0.9, 1.4, 1.1), line(1.4, 1.22, 1.4, 2)],
      sources: [source(0.5, 1.0)],
    }),
  },
  {
    id: 'parabola',
    name: 'Parabolic reflector',
    blurb: 'A source at the focus of a parabola leaves as a beam: the paths from focus to any point of the dish and on to a line across the mouth are all the same length.',
    scene: () => {
      const points: [number, number][] = [];
      for (let y = 0.2; y <= 1.8001; y += 0.1) points.push([Number((0.3 + (y - 1) ** 2 / 1.2).toFixed(4)), Number(y.toFixed(4))]);
      return { ...emptyScene(), shapes: polyline(points), sources: [source(0.6, 1.0)] };
    },
  },
  {
    id: 'corner',
    name: 'Corner reflector',
    blurb: 'Two sheets at a right angle with the source half a wavelength from the apex, as behind a UHF television antenna: most of the power goes one way.',
    scene: () => ({
      ...emptyScene(),
      shapes: [line(2.2, 1.0, 1.5, 1.7), line(2.2, 1.0, 1.5, 0.3)],
      sources: [source(2.05, 1.0)],
    }),
  },
  {
    id: 'slab',
    name: 'Dielectric slab',
    blurb: 'A slab of permittivity 4 (water-ish at the low end, PCB at the high) halves the wavelength inside it and sends part of every wave back, so a standing wave forms in front.',
    scene: () => ({
      ...emptyScene(),
      shapes: [{ id: sceneId('shape'), geometry: { kind: 'rect', x: 1.6, y: 0, w: 0.5, h: 2 }, material: dielectric(4) }],
      sources: [source(0.6, 1.0)],
    }),
  },
  {
    id: 'two-plates',
    name: 'Between two plates',
    blurb: 'Two conducting sheets 1.3 wavelengths apart guide the wave between them, and leak a little from the open ends: the beginning of every waveguide and transmission line.',
    scene: () => ({
      ...emptyScene(),
      shapes: [line(0.8, 0.8, 2.8, 0.8), line(0.8, 1.2, 2.8, 1.2)],
      sources: [source(1.0, 1.0)],
    }),
  },
  {
    id: 'ping',
    name: 'One pulse, open space',
    blurb: 'A single ping spreading out and leaving through the absorbing edges - the plainest view of how the sandbox works.',
    scene: () => ({ ...emptyScene(), sources: [source(1.5, 1.0, 'pulse')] }),
  },
  {
    id: 'mast',
    name: 'A mast in a plane wave',
    blurb:
      'A plane wave meets a conducting cylinder a wavelength across - a mast or a tower seen end-on. In front of it the incoming and reflected waves stand; behind it lies a shadow, filled in from the edges by diffraction.',
    scene: () => ({
      ...emptyScene(),
      planeWave: { side: 'left', angleDeg: 0, kind: 'sine', amplitude: 1 },
      shapes: [{ id: sceneId('shape'), geometry: { kind: 'disc', cx: 1.3, cy: 1.0, r: 0.15 }, material: CONDUCTOR }],
    }),
  },
  {
    id: 'brewster',
    name: "Brewster's angle",
    blurb:
      'Vertical polarisation (Hz out of the screen, so E lies in the picture) coming down at 63.4° from overhead onto a ground of εr 4, where tan θ = √εr. Nothing comes back: the field above is the incoming wave alone. Switch to Ez - horizontal polarisation - and a standing wave appears above the ground.',
    scene: () => ({
      ...emptyScene(),
      polarisation: 'te',
      planeWave: { side: 'top', angleDeg: Number(((Math.atan(2) * 180) / Math.PI).toFixed(1)), kind: 'sine', amplitude: 1 },
      shapes: [{ id: sceneId('shape'), geometry: { kind: 'rect', x: 0, y: 0, w: 3, h: 0.6 }, material: dielectric(4) }],
    }),
  },
  {
    id: 'ground-40m',
    name: 'Average ground on 40 m',
    blurb:
      'Horizontal polarisation (Ez) arriving 20° above the horizon at 7.1 MHz over average ground (εr 13, 5 mS/m). The ground sends most of it back, and the lobes and nulls of a standing wave stand above it - the lobes an antenna pattern over ground is made of. Switch to Hz, vertical polarisation, and the stripes fade: past its pseudo-Brewster angle (about 13° elevation here) real ground hardly reflects vertical polarisation.',
    scene: () => ({
      ...emptyScene(),
      fMHz: 7.1,
      widthM: 300,
      heightM: 150,
      cellsPerWavelength: 40,
      planeWave: { side: 'top', angleDeg: 70, kind: 'sine', amplitude: 1 },
      shapes: [{ id: sceneId('shape'), geometry: { kind: 'rect', x: 0, y: 0, w: 300, h: 30 }, material: dielectric(13, 0.005) }],
    }),
  },
];

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
