// Types for fake-fieldfox.mjs.

export function antennaGamma(hz: number): [number, number];
export function lowPassS21(hz: number): [number, number];
export function splitCommands(line: string): string[];

export interface FakeFieldFoxState {
  mode: string;
  startHz: number;
  stopHz: number;
  points: number;
  ifbwHz: number;
  parameter: string;
  continuous: boolean;
  correction: boolean;
  format: string;
  hold: boolean;
  errors: string[];
  log: string[];
}

export function startFakeFieldFox(options?: { port?: number; correction?: boolean; legacy?: boolean }): Promise<{
  port: number;
  close: () => Promise<void>;
  state: FakeFieldFoxState;
}>;
