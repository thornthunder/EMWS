// Your cores: the ones on your bench, measured, kept.
//
// A profile is a core you own, not a mix. It carries the size, what it is (as far as you
// know), and the VNA sweep you took of it - and from that, the permeability curve the
// simulator uses instead of the built-in estimate. It is the shape of a fact about one
// physical object: "this FT240, the one with the chipped edge, does this".
//
// Profiles live in this browser's storage and nowhere else, and can be exported as a small
// JSON file to keep, to move to another machine, or to give to someone else. The sweep is
// kept in full so a profile can always be re-derived (with a corrected stray capacitance,
// say) and so anyone handed the file can see exactly what was measured.

import { type FerriteFamily, type PermeabilityPoint } from '../../lib/ferrite';
import type { CoreSize, Material } from './catalog';
import { permeabilityCurve, trustworthyUpToMHz } from './measure';

export interface SweepPoint {
  fMHz: number;
  r: number;
  x: number;
}

export interface CoreProfile {
  id: string;
  name: string;
  size: CoreSize;
  family: FerriteFamily;
  /** What the core is believed to be: "#43", "unknown", "salvaged from a monitor lead". */
  mix: string;
  /** ISO date of the measurement. */
  measuredAt: string;
  setup: { turns: number; strayPf: number; stack: number };
  /** The VNA sweep, as opened. Kept in full, so the curve can be re-derived and inspected. */
  sweep: SweepPoint[];
  /** The permeability the sweep implies. */
  curve: PermeabilityPoint[];
  /** Where the winding resonated, if it did: above a third of this the curve is not the core. */
  trustworthyUpToMHz?: number;
  sourceFile?: string;
  notes?: string;
}

/** What one profile, or a set of them, looks like on disk. */
export interface ProfileFile {
  emws: 'core-profiles';
  version: 1;
  profiles: CoreProfile[];
}

export const PROFILE_MATERIAL_PREFIX = 'core:';

const STORAGE_KEY = 'emws.balun.cores.v1';

let counter = 0;
export function newProfileId(): string {
  counter += 1;
  return `core-${Date.now().toString(36)}-${counter}`;
}

export function makeProfile(
  input: Omit<CoreProfile, 'id' | 'curve' | 'trustworthyUpToMHz' | 'measuredAt'> & { measuredAt?: string },
): CoreProfile {
  const points = input.sweep.map((p) => ({ fMHz: p.fMHz, z: { re: p.r, im: p.x }, gamma: { re: 0, im: 0 } }));
  const setup = { core: input.size, stack: input.setup.stack, turns: input.setup.turns, strayPf: input.setup.strayPf, family: input.family };
  return {
    ...input,
    id: newProfileId(),
    measuredAt: input.measuredAt ?? new Date().toISOString(),
    curve: permeabilityCurve(points, setup),
    trustworthyUpToMHz: trustworthyUpToMHz(points),
  };
}

/** Re-derives the curve after the setup has been corrected - a stray capacitance, say. */
export function rederive(profile: CoreProfile, setup: Partial<CoreProfile['setup']>): CoreProfile {
  return { ...makeProfile({ ...profile, setup: { ...profile.setup, ...setup } }), id: profile.id, measuredAt: profile.measuredAt };
}

/** The lowest frequency measured is the nearest thing to the initial permeability. */
export function initialPermeability(profile: CoreProfile): number {
  return Math.max(1, Math.round(profile.curve[0]?.real ?? 1));
}

/** A profile, as the engine sees it: a material with a measured curve. */
export function profileMaterial(profile: CoreProfile): Material {
  return {
    id: `${PROFILE_MATERIAL_PREFIX}${profile.id}`,
    name: profile.name,
    family: profile.family,
    muInitial: initialPermeability(profile),
    curve: profile.curve,
    note: `${profile.mix}, measured ${new Date(profile.measuredAt).toLocaleDateString()}`,
  };
}

export function profileIdOfMaterial(materialId: string): string | undefined {
  return materialId.startsWith(PROFILE_MATERIAL_PREFIX) ? materialId.slice(PROFILE_MATERIAL_PREFIX.length) : undefined;
}

// ---- storage ----

/**
 * The sweep and the setup are the truth; the curve is only ever derived from them. So a
 * profile is re-derived whenever it is loaded, and a stored curve that is stale, empty or
 * edited can never reach the simulator. (An early version trusted the stored curve, and a
 * profile with none ran the whole tool on an air core - SWR in the hundreds of thousands.)
 */
export function loadProfiles(): CoreProfile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isProfile).map((p) => rederive(p, {})) : [];
  } catch {
    return []; // storage can be blocked, or hold something from an older version
  }
}

export function saveProfiles(profiles: readonly CoreProfile[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // see loadProfiles()
  }
}

// ---- files ----

export function exportProfiles(profiles: readonly CoreProfile[]): string {
  const file: ProfileFile = { emws: 'core-profiles', version: 1, profiles: [...profiles] };
  return JSON.stringify(file, null, 2);
}

export class ProfileFileError extends Error {}

/**
 * Reads a profile file. Anything not shaped like one is refused with a reason rather
 * than half-loaded; the curve is re-derived from the sweep rather than trusted, so a
 * file that was edited by hand still says what its measurements say.
 */
export function importProfiles(text: string): CoreProfile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProfileFileError('That is not a JSON file.');
  }
  const file = parsed as Partial<ProfileFile>;
  if (file?.emws !== 'core-profiles' || !Array.isArray(file.profiles)) {
    throw new ProfileFileError('That is not an EMWS core profile file.');
  }
  if (file.version !== 1) throw new ProfileFileError(`This file is version ${String(file.version)}; this EMWS reads version 1.`);
  const good = file.profiles.filter(isProfile);
  if (good.length === 0) throw new ProfileFileError('The file has no usable core profiles in it.');
  // Fresh ids, so an import never silently overwrites a core already here.
  return good.map((p) => ({ ...makeProfile({ ...p, measuredAt: p.measuredAt }), id: newProfileId() }));
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function isProfile(value: unknown): value is CoreProfile {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<CoreProfile>;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.size === 'object' &&
    p.size !== null &&
    finite(p.size.odMm) &&
    finite(p.size.idMm) &&
    finite(p.size.heightMm) &&
    p.size.odMm > p.size.idMm &&
    (p.family === 'NiZn' || p.family === 'MnZn') &&
    typeof p.mix === 'string' &&
    typeof p.measuredAt === 'string' &&
    typeof p.setup === 'object' &&
    p.setup !== null &&
    finite(p.setup.turns) &&
    p.setup.turns >= 1 &&
    Array.isArray(p.sweep) &&
    p.sweep.length >= 2 &&
    p.sweep.every((s) => finite(s?.fMHz) && finite(s?.r) && finite(s?.x)) &&
    Array.isArray(p.curve)
  );
}

/** A file name that says what is in it. */
export function suggestedFileName(profiles: readonly CoreProfile[]): string {
  const stem = profiles.length === 1 ? profiles[0]!.name : `${profiles.length} cores`;
  return `${stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cores'}.emws-cores.json`;
}
