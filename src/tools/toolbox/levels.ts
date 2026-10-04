// Levels: the conversions a station lives by - dBm, watts, volts, S-units, dB ratios -
// and what a transmitter radiates and produces at a distance.
//
// The S-meter scale is the IARU Region 1 recommendation (R.1): S9 is -73 dBm at HF
// (50 µV into 50 ohms) and -93 dBm above 30 MHz, with 6 dB per S-unit. Real receivers'
// meters are seldom calibrated to it; the tool says what the scale is, not what a
// particular radio's needle will do. The field strength is the free-space far field, so
// it is an estimate for open ground at a distance, not a figure for a nearby wall.

export function dBmToWatts(dBm: number): number {
  return 10 ** ((dBm - 30) / 10);
}

export function wattsToDbm(watts: number): number {
  return watts > 0 ? 10 * Math.log10(watts) + 30 : -Infinity;
}

/** RMS volts across z for this power. */
export function voltsRms(watts: number, z: number): number {
  return Math.sqrt(Math.max(0, watts) * z);
}

export function wattsFromVoltsRms(volts: number, z: number): number {
  return (volts * volts) / z;
}

/** dB above a microvolt, for the RMS voltage this power makes across z. */
export function dBuV(watts: number, z: number): number {
  const v = voltsRms(watts, z);
  return v > 0 ? 20 * Math.log10(v / 1e-6) : -Infinity;
}

export type SBand = 'hf' | 'vhf';
export const S9_DBM: Record<SBand, number> = { hf: -73, vhf: -93 };
export const S_UNIT_DB = 6;

export interface SMeter {
  /** S-units, fractional: 9 is S9, 7.5 is halfway from S7 to S8. Above 9 it keeps counting. */
  units: number;
  /** dB over S9; negative below it. */
  overS9Db: number;
  /** What a meter would show: "S7", "S9 + 20 dB", "below S1". */
  reading: string;
}

export function sMeter(dBm: number, band: SBand): SMeter {
  const overS9Db = dBm - S9_DBM[band];
  const units = 9 + overS9Db / S_UNIT_DB;
  let reading: string;
  if (overS9Db >= 0.5) reading = `S9 + ${overS9Db.toFixed(0)} dB`;
  else if (units < 0.5) reading = 'below S1';
  else reading = `S${Math.round(units)}`;
  return { units, overS9Db, reading };
}

export const dbToPowerRatio = (dB: number): number => 10 ** (dB / 10);
export const dbToVoltageRatio = (dB: number): number => 10 ** (dB / 20);
export const powerRatioToDb = (ratio: number): number => (ratio > 0 ? 10 * Math.log10(ratio) : -Infinity);
export const voltageRatioToDb = (ratio: number): number => (ratio > 0 ? 20 * Math.log10(ratio) : -Infinity);

/** A half-wave dipole's gain over an isotropic radiator: the dBd to dBi step. */
export const DIPOLE_GAIN_DBI = 2.15;

export interface Radiated {
  eirpW: number;
  erpW: number;
  eirpDbm: number;
}

/** What leaves the antenna: transmitter power less the feeder, times the antenna's gain. */
export function radiatedPower(txW: number, feederLossDb: number, gainDbi: number): Radiated {
  const eirpW = txW * dbToPowerRatio(gainDbi - feederLossDb);
  return { eirpW, erpW: eirpW / dbToPowerRatio(DIPOLE_GAIN_DBI), eirpDbm: wattsToDbm(eirpW) };
}

export interface FieldStrength {
  voltsPerM: number;
  dBuVPerM: number;
  wattsPerM2: number;
}

/** Free-space far field of an EIRP at a distance: E = sqrt(30 P) / d, S = P / 4 pi d^2. */
export function fieldStrength(eirpW: number, distanceM: number): FieldStrength {
  if (!(distanceM > 0) || !(eirpW >= 0)) return { voltsPerM: NaN, dBuVPerM: NaN, wattsPerM2: NaN };
  const voltsPerM = Math.sqrt(30 * eirpW) / distanceM;
  return {
    voltsPerM,
    dBuVPerM: voltsPerM > 0 ? 20 * Math.log10(voltsPerM / 1e-6) : -Infinity,
    wattsPerM2: eirpW / (4 * Math.PI * distanceM * distanceM),
  };
}

/** Roughly where the far field begins: beyond a wavelength, and beyond 2 D^2 / lambda for an antenna D across. */
export function farFieldFromM(fMHz: number, antennaSizeM: number): number {
  const lambda = 299.792458 / fMHz;
  return Math.max(lambda, (2 * antennaSizeM * antennaSizeM) / lambda);
}
