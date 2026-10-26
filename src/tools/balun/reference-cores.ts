// Cores measured by ZR1JT and given to EMWS: real #31, #43 and #77 curves, shipped with
// the site. measured-cores.json is in the core-profile export format (sweeps thinned to
// about 200 points on a log axis; provenance in the file and in each core's notes), so it
// is read by the same importer as a file you bring in, and the curves are worked out from
// the sweeps on load like any other profile. Public domain (CC0), like every piece of data
// in EMWS.
//
// Two uses. The guess compares a measurement against them as well as against the built-in
// pictures - a real #77 against a real #77 is how ZR1JT's second #77 was recognised - and
// any of them can be added to your own cores and designed on.

import file from './measured-cores.json';
import { type CoreProfile, importProfiles, newProfileId } from './profiles';

export const REFERENCE_PREFIX = 'ref:';
export const isReference = (id: string): boolean => id.startsWith(REFERENCE_PREFIX);

let cache: CoreProfile[] | undefined;

/** The shipped cores, as profiles with stable ids. */
export function referenceCores(): CoreProfile[] {
  if (!cache) cache = importProfiles(JSON.stringify(file)).map((p, i) => ({ ...p, id: `${REFERENCE_PREFIX}${i + 1}` }));
  return cache;
}

/** A copy of a shipped core as one of your own: a fresh id, everything else kept. */
export function copyOfReference(profile: CoreProfile): CoreProfile {
  return { ...profile, id: newProfileId() };
}
