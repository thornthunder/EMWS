// What every VNA looks like to the rest of EMWS.
//
// One method that matters: sweep a range and hand back measured points in the same shape
// the .s1p import produces, so the Smith chart, the balun tool and the antenna modeller
// take a live instrument and a saved file the same way, and never know which they got.
//
// Public domain (The Unlicense). By ZR1JT.

import type { MeasuredPoint } from '../touchstone';
import type { TransmissionPoint } from './transmission';

export interface SweepRequest {
  startMHz: number;
  stopMHz: number;
  points: number;
  onProgress?: (done: number, total: number) => void;
}

export interface Instrument {
  readonly kind: 'nanovna' | 'nanovna-v2';
  /** What it turned out to be, once asked. */
  readonly name: string;
  describe(): Promise<string>;
  /**
   * Sweeps, and returns S11 and impedance at each frequency. For a classic NanoVNA these
   * carry the instrument's own calibration; for a V2 they are raw until calibrated on
   * this side (see calibration.ts).
   */
  sweep(request: SweepRequest): Promise<MeasuredPoint[]>;
  /**
   * Sweeps port 1 to port 2: S21 at each frequency. Calibrated by the instrument on a
   * classic NanoVNA; raw on a V2, for a thru calibration (transmission.ts) to correct.
   */
  sweepTransmission(request: SweepRequest): Promise<TransmissionPoint[]>;
  close(): Promise<void>;
}
