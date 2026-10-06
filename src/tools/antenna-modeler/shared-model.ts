// An antenna model as the club library carries it: the NEC deck, in a small JSON envelope
// that also keeps the SWR reference impedance (a Windom is read against 200 Ω, not 50).
// The deck is the payload because a deck is what Open reads: taking a shared model is
// opening a .nec file, through the same import and the same refusals.
//
// Public domain (The Unlicense). By ZR1JT.

export interface SharedModelFile {
  emws: 'antenna-model';
  version: 1;
  deck: string;
  z0?: number;
}

export function packModel(deck: string, z0: number): string {
  const file: SharedModelFile = { emws: 'antenna-model', version: 1, deck, ...(z0 !== 50 ? { z0 } : {}) };
  return JSON.stringify(file);
}

export function unpackModel(payload: string): { deck: string; z0?: number } {
  let file: Partial<SharedModelFile>;
  try {
    file = JSON.parse(payload) as Partial<SharedModelFile>;
  } catch {
    throw new Error('This is not an EMWS antenna model: it is not JSON.');
  }
  if (file.emws !== 'antenna-model' || typeof file.deck !== 'string' || file.deck.length === 0) throw new Error('This is not an EMWS antenna model.');
  const z0 = typeof file.z0 === 'number' && Number.isFinite(file.z0) && file.z0 > 0 ? file.z0 : undefined;
  return { deck: file.deck, ...(z0 !== undefined ? { z0 } : {}) };
}
