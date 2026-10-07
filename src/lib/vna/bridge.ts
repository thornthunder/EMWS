// A VNA reached through the EMWS VNA bridge (services/emws-vna-bridge): a Keysight
// FieldFox on the LAN, say, which speaks SCPI over a socket no web page can open. The
// bridge runs on the same machine as the browser and answers HTTP on 127.0.0.1; from here
// it looks like any other Instrument, and the tools never know the difference.
//
//   GET  <bridge>/health -> { service: 'emws-vna-bridge', instruments: [...] }
//   POST <bridge>/sweep  { instrument, parameter, startHz, stopHz, points }
//                        -> { frequenciesHz, real, imag, corrected, method }
//
// The bridge is optional by construction, like the solver service: not running, not
// there, and EMWS is exactly what it was. A loopback address is "potentially trustworthy"
// to a browser, so an https page may call it; Chromium's private-network rule is met by
// the header the bridge sends on its preflight answer.
//
// Public domain (The Unlicense). By ZR1JT.

import { type MeasuredPoint, impedanceFromGamma } from '../touchstone';
import type { Instrument, SweepRequest } from './instrument';
import { VnaError } from './link';
import type { TransmissionPoint } from './transmission';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8075';
const STORAGE_KEY = 'emws.vna.bridge.v1';
const PROBE_TIMEOUT_MS = 2500;
/** The FieldFox takes up to 10001 points; the bridge refuses more before asking it. */
export const BRIDGE_MAX_POINTS = 10001;

export interface BridgeInstrumentInfo {
  id: string;
  name: string;
  address: string;
  status: 'ok' | 'unreachable';
  /** The *IDN? reply, when it answered. */
  idn?: string;
  options?: string;
  modes?: string[];
  error?: string;
}

export interface BridgeInfo {
  url: string;
  version: string;
  instruments: BridgeInstrumentInfo[];
}

/** Where the bridge is looked for: the default, or an address the person set. */
export function bridgeUrl(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && /^https?:\/\//.test(stored)) return stored.replace(/\/+$/, '');
  } catch {
    // no storage: the default
  }
  return DEFAULT_BRIDGE_URL;
}

export function setBridgeUrl(url: string): void {
  try {
    const trimmed = url.trim().replace(/\/+$/, '');
    if (trimmed === '' || trimmed === DEFAULT_BRIDGE_URL) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // no storage: nothing to remember
  }
}

/** Asks the bridge what it has. Undefined when nothing is there - the usual case. */
export async function probeBridge(url = bridgeUrl(), timeoutMs = PROBE_TIMEOUT_MS): Promise<BridgeInfo | undefined> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { service?: unknown; version?: unknown; instruments?: unknown };
    if (body.service !== 'emws-vna-bridge' || !Array.isArray(body.instruments)) return undefined;
    const instruments: BridgeInstrumentInfo[] = [];
    for (const raw of body.instruments) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
      instruments.push({
        id: r.id,
        name: r.name,
        address: typeof r.address === 'string' ? r.address : '',
        status: r.status === 'ok' ? 'ok' : 'unreachable',
        idn: typeof r.idn === 'string' ? r.idn : undefined,
        options: typeof r.options === 'string' ? r.options : undefined,
        modes: Array.isArray(r.modes) ? r.modes.filter((m): m is string => typeof m === 'string') : undefined,
        error: typeof r.error === 'string' ? r.error : undefined,
      });
    }
    return { url, version: typeof body.version === 'string' ? body.version : '', instruments };
  } catch {
    return undefined;
  }
}

interface SweepReply {
  frequenciesHz: number[];
  real: number[];
  imag: number[];
  /** Absent when the instrument would not say. */
  corrected?: boolean;
  method: string;
  /** False when the instrument would not let the bridge choose the parameter: the trace it showed was swept. */
  parameterSet?: boolean;
  parameterNote?: string;
}

/** The instrument's model, from its *IDN? reply: "Keysight Technologies,N9912A,MY...,A.12.95" -> "N9912A". */
export function modelFromIdn(idn: string | undefined): string | undefined {
  const parts = (idn ?? '').split(',').map((p) => p.trim());
  return parts.length >= 2 && parts[1] ? parts[1] : undefined;
}

export class BridgeInstrument implements Instrument {
  readonly kind = 'bridge' as const;
  readonly name: string;
  readonly maxPoints = BRIDGE_MAX_POINTS;
  /** What the instrument said about its correction on the last sweep; undefined before one, `corrected` undefined when it would not say. */
  lastCorrection: { corrected: boolean | undefined; method: string } | undefined;
  /** Set after a sweep in which the bridge could not choose S11/S21 and swept the trace shown instead. */
  lastParameterNote: string | undefined;

  constructor(
    readonly url: string,
    readonly info: BridgeInstrumentInfo,
  ) {
    const model = modelFromIdn(info.idn);
    this.name = model ? `${info.name} (${model})` : info.name;
  }

  async describe(): Promise<string> {
    return this.info.idn ?? this.name;
  }

  async sweep(request: SweepRequest): Promise<MeasuredPoint[]> {
    const reply = await this.post('S11', request);
    return reply.frequenciesHz.map((hz, i) => {
      const gamma = { re: reply.real[i]!, im: reply.imag[i]! };
      return { fMHz: hz / 1e6, gamma, z: impedanceFromGamma(gamma, 50) };
    });
  }

  async sweepTransmission(request: SweepRequest): Promise<TransmissionPoint[]> {
    const reply = await this.post('S21', request);
    return reply.frequenciesHz.map((hz, i) => ({ fMHz: hz / 1e6, s21: { re: reply.real[i]!, im: reply.imag[i]! } }));
  }

  async close(): Promise<void> {
    // Nothing is held open: the bridge connects to the instrument per sweep.
  }

  private async post(parameter: 'S11' | 'S21', request: SweepRequest): Promise<SweepReply> {
    request.onProgress?.(0, 1);
    let response: Response;
    try {
      response = await fetch(`${this.url}/sweep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrument: this.info.id,
          parameter,
          startHz: Math.round(request.startMHz * 1e6),
          stopHz: Math.round(request.stopMHz * 1e6),
          points: request.points,
        }),
        cache: 'no-store',
      });
    } catch (e) {
      throw new VnaError(`The VNA bridge at ${this.url} could not be reached${e instanceof Error && e.message ? ` (${e.message})` : ''}. Is it still running?`);
    }
    if (!response.ok) {
      let detail = '';
      try {
        detail = ((await response.json()) as { error?: string }).error ?? '';
      } catch {
        // no detail
      }
      throw new VnaError(detail || `The VNA bridge answered ${response.status}.`);
    }
    const body = (await response.json()) as Partial<SweepReply>;
    const ok =
      Array.isArray(body.frequenciesHz) &&
      Array.isArray(body.real) &&
      Array.isArray(body.imag) &&
      body.real.length === body.frequenciesHz.length &&
      body.imag.length === body.frequenciesHz.length &&
      body.frequenciesHz.every((v) => typeof v === 'number' && Number.isFinite(v));
    if (!ok) throw new VnaError('The VNA bridge answered, but not with a sweep.');
    this.lastCorrection = { corrected: typeof body.corrected === 'boolean' ? body.corrected : undefined, method: typeof body.method === 'string' ? body.method : '' };
    this.lastParameterNote = body.parameterSet === false ? body.parameterNote || `The instrument would not let the bridge choose ${parameter}; this is the trace it was showing.` : undefined;
    request.onProgress?.(1, 1);
    return body as SweepReply;
  }
}
