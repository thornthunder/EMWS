// Your baluns and ununs, kept: a design saved under a name, so another tool can use it.
//
// A saved design is the whole recipe - core, wire, winding, taps, compensation - plus the
// name you gave it. If it was built on one of your measured cores, it carries that
// profile's id, and the profile itself stays in the profile store; the two are looked up
// together when the design is used, so a corrected measurement corrects every design
// wound on that core. This is the first shelf of a component library: the Antenna
// Modeler reads it to show what the radio sees through a balun you actually have.
//
// Public domain (The Unlicense). By ZR1JT.

import { MATERIALS, type Material } from './catalog';
import type { Design } from './model';
import { type CoreProfile, ProfileFileError, exportProfiles, importProfiles, profileMaterial } from './profiles';

export interface SavedBalun {
  id: string;
  name: string;
  savedAt: string;
  /** What it is, in the tool's words at the time: "49:1 · 2 : 14 turns on FT240 in #43". */
  summary: string;
  design: Design;
}

const KEY = 'emws.balun.designs.v1';

let counter = 0;
const session = Date.now().toString(36);

export function newSavedBalunId(): string {
  counter += 1;
  return `b${session}.${counter.toString(36)}`;
}

export function isSavedBalun(value: unknown): value is SavedBalun {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SavedBalun>;
  const d = v.design as Partial<Design> | undefined;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof d === 'object' && d !== null && Array.isArray(d.steps) && typeof d.topology === 'string' && typeof d.materialId === 'string';
}

export function loadSavedBaluns(): SavedBalun[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSavedBalun) : [];
  } catch {
    return [];
  }
}

export function saveSavedBaluns(list: readonly SavedBalun[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage can be blocked; the design still works, it just will not be there next time.
  }
}

/**
 * A saved design as a file - what the club library shares. A design wound on a measured
 * core carries that core with it: without it, on anyone else's machine, the design would
 * only ever be greyed out. On the way in the core is imported like any core file (fresh
 * id, the sweep re-derived) and the design is pointed at it.
 */
export interface BalunFile {
  emws: 'balun-design';
  version: 1;
  balun: SavedBalun;
  /** The core-profiles file of the one core the design is wound on, if it is a measured one. */
  core?: unknown;
}

export function exportSavedBalun(saved: SavedBalun, profiles: readonly CoreProfile[]): string {
  const profile = saved.design.profileId ? profiles.find((p) => p.id === saved.design.profileId) : undefined;
  if (saved.design.profileId && !profile) throw new ProfileFileError(`${saved.name} was wound on a measured core that is no longer here, so it cannot be shared faithfully.`);
  const file: BalunFile = { emws: 'balun-design', version: 1, balun: saved, ...(profile ? { core: JSON.parse(exportProfiles([profile])) as unknown } : {}) };
  return JSON.stringify(file);
}

export function importSavedBalun(text: string): { saved: SavedBalun; core?: CoreProfile } {
  let file: Partial<BalunFile>;
  try {
    file = JSON.parse(text) as Partial<BalunFile>;
  } catch {
    throw new ProfileFileError('This is not a balun design file: it is not JSON.');
  }
  if (file.emws !== 'balun-design' || !isSavedBalun(file.balun)) throw new ProfileFileError('This is not an EMWS balun design.');
  const design = file.balun.design;
  if (!design.profileId) return { saved: { ...file.balun, id: newSavedBalunId() } };
  if (file.core === undefined) throw new ProfileFileError(`${file.balun.name} was wound on a measured core the file does not carry.`);
  const [core] = importProfiles(JSON.stringify(file.core));
  if (!core) throw new ProfileFileError(`The core ${file.balun.name} was wound on could not be read.`);
  return {
    saved: { ...file.balun, id: newSavedBalunId(), design: { ...design, profileId: core.id, materialId: profileMaterial(core).id } },
    core,
  };
}

/**
 * The material a saved design needs: a built-in mix, or one of your measured cores. It
 * is undefined when the design was wound on a profile that has since been deleted - then
 * the design cannot honestly be evaluated, and the caller should say so.
 */
export function materialFor(design: Design, profiles: readonly CoreProfile[]): Material | undefined {
  if (design.profileId) {
    const profile = profiles.find((p) => p.id === design.profileId);
    return profile ? profileMaterial(profile) : undefined;
  }
  return MATERIALS.find((m) => m.id === design.materialId);
}
