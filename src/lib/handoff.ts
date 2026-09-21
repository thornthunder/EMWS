// Passing a measured or modelled impedance from one EMWS tool to another, through the
// browser's own storage. Nothing leaves the machine.

const KEY = 'emws.handoff.impedance';

export interface ImpedanceHandoff {
  /** Where it came from, for the user to recognise. */
  name: string;
  savedAt: string;
  points: { fMHz: number; r: number; x: number }[];
}

export function saveImpedanceHandoff(handoff: ImpedanceHandoff): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(handoff));
  } catch {
    // Storage can be blocked; the tools still work, they just cannot pass this along.
  }
}

export function loadImpedanceHandoff(): ImpedanceHandoff | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as ImpedanceHandoff;
    if (!Array.isArray(value?.points) || value.points.length === 0) return undefined;
    if (!value.points.every((p) => Number.isFinite(p.fMHz) && Number.isFinite(p.r) && Number.isFinite(p.x))) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}
