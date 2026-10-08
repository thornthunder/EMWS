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
 * The first real FieldFox the bridge met (2026-10-07): an N9914A on firmware A.07.75. In NA
 * mode it answers everything else and refuses EVERY spelling of "define the parameter" -
 * CALC:PAR1:DEF, CALC:PAR:DEF, and both long forms - with -113 "Undefined header", and it
 * lists one of its modes twice. In `legacy` mode the fake answers as it did, word for word,
 * so the bridge's way round it (sweep the trace shown, and say so) is tested against the
 * real refusals.
 */
const LEGACY_IDN = 'Keysight Technologies,N9914A,MY53104315,A.07.75';
const LEGACY_OPTIONS = '"210,010,310,235,233,211"';
const LEGACY_MODES = '"CPM","CPM","SA","NA","CAT"';
/** Lines from that instrument's own SYST:HELP:HEADers? (2026-10-08), the ones that matter here. */
const LEGACY_HEADERS = [
  ':CALCulate{1:1}[:SELected]:DATA:FDATa',
  ':CALCulate{1:1}[:SELected]:DATA:FMEMory?/qonly/',
  ':CALCulate{1:1}[:SELected]:DATA:SDATa',
  ':CALCulate{1:1}[:SELected]:DATA:SMEMory',
  ':CALCulate{1:1}[:SELected]:MARKer:AOFF/nquery/',
  ':CALCulate{1:1}[:SELected]:TRANsform:TIME:STARt',
  ':DISPlay:WINDow{1:1}:SPLit',
  ':DISPlay:WINDow{1:1}:TRACe{1:4}:Y[:SCALe]:AUTO/nquery/',
  ':FORMat:BORDer',
  ':FORMat[:DATA]',
  ':INSTrument:CATalog?/qonly/',
  ':INSTrument[:SELect]',
  ':MMEMory:STORe:SNP[:DATA]/nquery/',
  '[:SENSe{1:1}]:AVERage:COUNt',
  '[:SENSe{1:1}]:BWID',
  '[:SENSe{1:1}]:CORRection:EXTension:PORT1|PORT',
  '[:SENSe{1:1}]:CORRection:EXTension[:STATe]',
  '[:SENSe{1:1}]:CORRection:IMPedance[:INPut][:MAGNitude]',
  '[:SENSe{1:1}]:FREQuency:CENTer',
  '[:SENSe{1:1}]:FREQuency:DATA?/qonly/',
  '[:SENSe{1:1}]:FREQuency:STARt',
  '[:SENSe{1:1}]:FREQuency:STOP',
  '[:SENSe{1:1}]:SWEep:POINts',
  '[:SENSe{1:1}]:SWEep:TIME',
  ':STATus:OPERation:CONDition?/qonly/',
  ':SYSTem:ERRor[:NEXT]?/qonly/',
  ':SYSTem:HELP:HEADers?/qonly/',
  ':SYSTem:VERSion?/qonly/',
  '*CLS/nquery/',
  '*IDN?/qonly/',
  '*OPC',
  '*OPT?/qonly/',
  '*WAI/nquery/',
];
/** What a current firmware lists, as far as the bridge cares: the legacy set plus what it lacks. */
const CURRENT_HEADERS = [
  ...LEGACY_HEADERS,
  ':CALCulate{1:1}:PARameter{1:4}:DEFine',
  ':CALCulate{1:1}:PARameter{1:4}:SELect/nquery/',
  ':CALCulate{1:1}:PARameter:COUNt',
  ':INITiate:CONTinuous',
  ':INITiate[:IMMediate]/nquery/',
  '[:SENSe{1:1}]:CORRection[:STATe]',
  '[:SENSe{1:1}]:CORRection:USER[:STATe]',
  '[:SENSe{1:1}]:CORRection:COLLect:METHod:TYPE?/qonly/',
  '[:SENSe{1:1}]:SWEep:MTIMe?/qonly/',
];

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
    /** On Hold, the trace never changes; sweeping, its last digit wanders as a real one's does. */
    hold: false,
    /** @type {string[]} */
    errors: [],
    /** Every command received, for tests that check what the bridge sent. */
    log: /** @type {string[]} */ ([]),
  };

  /** @param {string} cmd @returns {string | undefined} */
  const handle = (raw) => {
    // A leading colon means "from the root", which is where every command here starts anyway.
    const cmd = raw.replace(/^:/, '');
    state.log.push(cmd);
    const spelt = cmd.toUpperCase();
    // Long mnemonics mean the same as short ones; the matching below is on the short ones.
    const upper = spelt.replace(/CALCULATE/g, 'CALC').replace(/PARAMETER/g, 'PAR').replace(/DEFINE/g, 'DEF').replace(/SELECT/g, 'SEL').replace(/SYSTEM/g, 'SYST').replace(/VERSION/g, 'VERS');
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
    if (upper === 'SYST:ERR?') return state.errors.shift() ?? (legacy ? '0,"No error"' : '+0,"No error"');
    if (upper === 'SYST:VERS?') return '1999.0';
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
    if (/^CALC:PAR1?:DEF\?$/.test(upper)) {
      if (legacy || state.mode !== 'NA') {
        state.errors.push(`-113,"Undefined header;${spelt}<Err>"`);
        return undefined;
      }
      return state.parameter;
    }
    if (/^CALC:PAR1?:DEF\s/.test(upper)) {
      // SEEN on the N9914A, A.07.75, in NA mode: every spelling refused, with this very
      // text (the header echoed as sent, in capitals).
      if (legacy || state.mode !== 'NA') state.errors.push(`-113,"Undefined header;${spelt.split(' ')[0]}<Err>"`);
      else if (!['S11', 'S21'].includes(arg.toUpperCase())) state.errors.push('-224,"Illegal parameter value"');
      else state.parameter = arg.toUpperCase();
      return undefined;
    }
    if (upper === 'CALC:PAR1:SEL' || upper === 'CALC:PAR:SEL') {
      if (legacy || state.mode !== 'NA') state.errors.push(`-113,"Undefined header;${spelt}<Err>"`);
      return undefined;
    }
    if (upper === 'SENS:FREQ:STAR?') return String(state.startHz);
    if (upper === 'SENS:FREQ:STOP?') return String(state.stopHz);
    if (upper === 'SENS:SWE:POIN?') return String(state.points);
    if (upper === 'SENS:BWID?') return String(state.ifbwHz);
    if (upper === 'FORM?') return state.format;
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
    if (/^INIT/.test(upper)) {
      // SEEN on the N9914A, A.07.75: no INITiate subsystem at all - the marker sits right
      // after INIT. It sweeps continuously on its own.
      if (legacy) {
        state.errors.push('-113,"Undefined header;INIT<Err>"');
        return undefined;
      }
      if (upper === 'INIT:CONT?') return state.continuous ? '1' : '0';
      if (/^INIT:CONT\s/.test(upper)) {
        state.continuous = !/^(0|OFF)$/i.test(arg);
        return undefined;
      }
      if (upper === 'INIT:IMM' || upper === 'INIT') return undefined;
    }
    if (upper === 'SENS:SWE:MTIM?') {
      if (legacy) {
        state.errors.push('-113,"Undefined header;SENS:SWE:MTIM<Err>"');
        return undefined;
      }
      return '0.15';
    }
    // As the real one: 0 means "auto", and the bridge must guess.
    if (upper === 'SENS:SWE:TIME?') return legacy ? '0.000E+00' : '0.15';
    if (upper === 'SENS:FREQ:DATA?') return frequencies().join(',');
    if (upper === 'CALC:DATA:SDATA?') {
      if (state.mode !== 'NA') {
        state.errors.push('-221,"Settings conflict"');
        return '';
      }
      const out = [];
      const noise = () => (state.hold ? 0 : (Math.random() - 0.5) * 2e-9);
      for (const hz of frequencies()) {
        const [re, im] = state.parameter === 'S21' ? lowPassS21(hz) : antennaGamma(hz);
        out.push((re + noise()).toExponential(8), (im + noise()).toExponential(8));
      }
      return out.join(',');
    }
    if (upper === 'SYST:HELP:HEAD?') {
      // A definite-length block, as the real one answers: #, the length's digit count, the
      // length, the bytes. The legacy list is the shape of the N9914A's (A.07.75, 325
      // headers): CALCulate holds DATA, FILTer, MARKer and TRANsform only - no PARameter -
      // and there is no INITiate and no CORRection state.
      const headers = legacy ? LEGACY_HEADERS : CURRENT_HEADERS;
      const body = `${headers.join('\n')}\n`;
      return `#${String(body.length).length}${body.length}${body}`;
    }
    // Correction state: the legacy firmware has no such queries at all.
    if (/^SENS:CORR(:USER)?\?$|^SENS:CORR:COLL:METH:TYPE\?$/.test(upper) && legacy) {
      state.errors.push(`-113,"Undefined header;${spelt.replace(/\?$/, '')}<Err>"`);
      return undefined;
    }
    if (upper === 'SENS:CORR?') return state.correction ? '1' : '0';
    if (upper === 'SENS:CORR:USER?') return state.correction ? '1' : '0';
    if (upper === 'SENS:CORR:COLL:METH:TYPE?') return '"QuickCal"';
    if (upper === 'SENS:CORR:IMP?') return '50';
    state.errors.push(`-113,"Undefined header;${spelt.split(' ')[0]}<Err>"`);
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
        // Several commands may share a line, joined by semicolons outside quotes, and their
        // answers share one line the same way (IEEE 488.2: one response message per
        // program message). A command that is not a query, or not understood, answers nothing.
        const replies = [];
        for (const cmd of splitCommands(line)) {
          const reply = handle(cmd.trim());
          if (reply !== undefined) replies.push(reply);
        }
        if (replies.length) socket.write(`${replies.join(';')}\n`);
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
