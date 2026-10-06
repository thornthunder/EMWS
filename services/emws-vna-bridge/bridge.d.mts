// Types for bridge.mjs, so the TypeScript tests can drive the real bridge.

export const VERSION: string;
export const DEFAULT_HTTP_PORT: number;
export const SCPI_PORT: number;
export const MAX_POINTS: number;

export class ScpiSocket {
  constructor(host: string, port: number);
  open(timeoutMs?: number): Promise<void>;
  write(command: string): void;
  query(command: string, timeoutMs?: number): Promise<string>;
  close(): void;
}

export interface FieldFoxSpec {
  id: string;
  name: string;
  host: string;
  port?: number;
}

export interface SweepRequest {
  parameter: 'S11' | 'S21';
  startHz: number;
  stopHz: number;
  points: number;
  ifbwHz?: number;
}

export interface SweepResult {
  frequenciesHz: number[];
  real: number[];
  imag: number[];
  corrected: boolean;
  method: string;
}

export class FieldFox {
  constructor(spec: FieldFoxSpec);
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly address: string;
  describe(): Promise<{ idn: string; options: string; modes: string[] }>;
  sweep(request: SweepRequest): Promise<SweepResult>;
}

export class InstrumentError extends Error {}

export function parseNumbers(reply: string): number[];
export function validateSweep(body: unknown): string | undefined;
export function parseArgs(argv: string[]): { fieldfox: string[]; port: number; simulate: boolean; help: boolean };
export function parseAddress(address: string): { host: string; port: number };

export function createBridge(options: {
  instruments: FieldFox[];
  port?: number;
  host?: string;
  log?: (line: string) => void;
}): Promise<{ url: string; close: () => Promise<void> }>;
