// A FieldFox that is not there: a SCPI server on a socket, answering the way Keysight's
// programming guide says an N9912A in network-analyser mode does. It measures a fixed
// "antenna" on port 1 - 75 ohms with half a microhenry in series, the same one the smoke
// test's simulated NanoVNAs see - and a first-order 145 MHz low-pass from port 1 to
// port 2, so a sweep through the bridge can be checked against arithmetic.
//
// It is what the bridge and the page are tested against until a real FieldFox is on the
// bench, and what `bridge.mjs --simulate` offers. It is deliberately strict: an unknown
// command or a value out of range goes into its error queue, as the instrument's would,
// and the bridge's SYST:ERR? checks must find it.
//
// Public domain (The Unlicense). By ZR1JT.

import { createServer } from 'node:net';

const IDN = 'Keysight Technologies,N9912A,MY00000000,A.12.95';
const OPTIONS = '"104,110,303,230"';
const MODES = '"CAT","NA","SA"';
/**
 * The first real FieldFox the bridge met (2026-10-07): an N9914A on firmware A.07.75, which
 * refused CALC:PAR1:DEF with -113 "Undefined header" - the trace-numbered form the current
 * guide gives - and listed one of its modes twice. In `legacy` mode the fake answers as it
 * did, so the bridge's fallback is tested against the real refusal, word for word.
 */
const LEGACY_IDN = 'Keysight Technologies,N9914A,MY53104315,A.07.75';
const LEGACY_OPTIONS = '"210,010,310,235,233,211"';
const LEGACY_MODES = '"CPM","CPM","SA","NA","CAT"';

/** S11 of 75 ohms + 0.5 uH against 50 ohms. @param {number} hz */
export function antennaGamma(hz) {
  const r = 75;
  const x = 2 * Math.PI * hz * 0.5e-6;
  const d = (r + 50) ** 2 + x * x;
  return [((r - 50) * (r + 50) + x * x) / d, (x * (r + 50) - (r - 50) * x) / d];
}

/** S21 of a first-order low-pass with its 3 dB point at 145 MHz. @param {number} hz */
export function lowPassS21(hz) {
  const x = hz / 145e6;
  return [1 / (1 + x * x), -x / (1 + x * x)];
}

/**
 * @param {{ port?: number; correction?: boolean; legacy?: boolean }} options
 * @returns {Promise<{ port: number; close: () => Promise<void>; state: Record<string, unknown> }>}
 */
export function startFakeFieldFox(options = {}) {
  const legacy = options.legacy ?? false;
  const state = {
    mode: 'CAT',
    startHz: 2e6,
    stopHz: 4e9,
    points: 201,
    ifbwHz: 30000,
    parameter: 'S11',
    continuous: true,
    correction: options.correction ?? true,
    format: 'ASC,0',
    /** @type {string[]} */
    errors: [],
    /** Every command received, for tests that check what the bridge sent. */
    log: /** @type {string[]} */ ([]),
  };

  /** @param {string} cmd @returns {string | undefined} */
  const handle = (cmd) => {
    state.log.push(cmd);
    const upper = cmd.toUpperCase();
    const arg = cmd.replace(/^\S+\s*/, '').trim();
    const number = () => {
      const v = Number(arg);
      if (!Number.isFinite(v)) state.errors.push('-104,"Data type error"');
      return v;
    };
    if (upper === '*IDN?') return legacy ? LEGACY_IDN : IDN;
    if (upper === '*OPT?') return legacy ? LEGACY_OPTIONS : OPTIONS;
    if (upper === '*CLS') {
      state.errors = [];
      return undefined;
    }
    if (upper === '*OPC?') return '1';
    if (upper === 'SYST:ERR?') return state.errors.shift() ?? '+0,"No error"';
    if (upper === 'INST:CAT?') return legacy ? LEGACY_MODES : MODES;
    if (upper === 'INST?' || upper === 'INST:SEL?') return `"${state.mode}"`;
    if (/^INST(:SEL)?\s/.test(upper)) {
      const mode = arg.replace(/"/g, '');
      if (!['CAT', 'NA', 'SA', 'CPM'].includes(mode)) state.errors.push('-224,"Illegal parameter value"');
      // The switch is overlapped: a legacy unit answers *OPC? at once and gets there later.
      else if (legacy) setTimeout(() => (state.mode = mode), 400);
      else state.mode = mode;
      return undefined;
    }
    if (/^CALC:PAR1?:DEF\s/.test(upper)) {
      const numbered = /^CALC:PAR1:/.test(upper);
      if (legacy && numbered) state.errors.push(`-113,"Undefined header;${cmd.split(' ')[0]}<Err>"`);
      else if (state.mode !== 'NA') state.errors.push(`-113,"Undefined header;${cmd.split(' ')[0]}<Err>"`);
      else if (!['S11', 'S21'].includes(arg.toUpperCase())) state.errors.push('-224,"Illegal parameter value"');
      else state.parameter = arg.toUpperCase();
      return undefined;
    }
    if (upper === 'CALC:PAR1:SEL' || upper === 'CALC:PAR:SEL') {
      if ((legacy && upper === 'CALC:PAR1:SEL') || state.mode !== 'NA') state.errors.push(`-113,"Undefined header;${cmd}<Err>"`);
      return undefined;
    }
    if (/^SENS:FREQ:STAR\s/.test(upper)) {
      state.startHz = number();
      return undefined;
    }
    if (/^SENS:FREQ:STOP\s/.test(upper)) {
      state.stopHz = number();
      return undefined;
    }
    if (/^SENS:SWE:POIN\s/.test(upper)) {
      const n = number();
      if (n < 2 || n > 10001) state.errors.push('-222,"Data out of range"');
      else state.points = n;
      return undefined;
    }
    if (/^SENS:BWID\s/.test(upper)) {
      state.ifbwHz = number();
      return undefined;
    }
    if (/^FORM\s/.test(upper)) {
      state.format = arg.toUpperCase().replace(/\s/g, '');
      return undefined;
    }
    if (upper === 'INIT:CONT?') return state.continuous ? '1' : '0';
    if (/^INIT:CONT\s/.test(upper)) {
      state.continuous = !/^(0|OFF)$/i.test(arg);
      return undefined;
    }
    if (upper === 'INIT:IMM' || upper === 'INIT') return undefined;
    if (upper === 'SENS:FREQ:DATA?') return frequencies().join(',');
    if (upper === 'CALC:DATA:SDATA?') {
      if (state.mode !== 'NA') {
        state.errors.push('-221,"Settings conflict"');
        return '';
      }
      const out = [];
      for (const hz of frequencies()) {
        const [re, im] = state.parameter === 'S21' ? lowPassS21(hz) : antennaGamma(hz);
        out.push(re.toExponential(8), im.toExponential(8));
      }
      return out.join(',');
    }
    if (upper === 'SENS:CORR:USER?') return state.correction ? '1' : '0';
    if (upper === 'SENS:CORR:COLL:METH:TYPE?') return '"QuickCal"';
    state.errors.push('-113,"Undefined header"');
    return undefined;
  };

  const frequencies = () => Array.from({ length: state.points }, (_, i) => state.startHz + ((state.stopHz - state.startHz) * i) / (state.points - 1));

  const server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        // Several commands may share a line, joined by semicolons outside quotes.
        for (const cmd of splitCommands(line)) {
          const reply = handle(cmd.trim());
          if (reply !== undefined) socket.write(`${reply}\n`);
        }
      }
    });
    socket.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => new Promise((done) => server.close(() => done(undefined))),
        state,
      });
    });
  });
}

/** @param {string} line */
export function splitCommands(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  if (current.trim() !== '') out.push(current);
  return out;
}
