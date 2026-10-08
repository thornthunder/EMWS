#!/usr/bin/env node
// EMWS VNA bridge: a bench or handheld VNA on the LAN, offered to the EMWS page.
//
// A web page cannot open a TCP socket, and a Keysight FieldFox speaks SCPI over one
// (port 5025). This program sits between them on the same machine as the browser: it
// talks SCPI to the instrument and answers plain HTTP on 127.0.0.1, in the shape the
// page's NanoVNA drivers already produce, so every "Measure it" button in EMWS can offer
// the FieldFox beside a NanoVNA. Like the solver service, it is optional by construction:
// without it, EMWS is exactly what it was.
//
//   node bridge.mjs --fieldfox 192.168.0.50            one FieldFox, SCPI port 5025
//   node bridge.mjs --fieldfox lab-ff:5025 --port 8075  (the HTTP port defaults to 8075)
//   node bridge.mjs --simulate                          a simulated FieldFox, to try the page
//
//   GET  /health -> { service, version, kinds: ['vna'], instruments: [...] }
//   POST /sweep  { instrument, parameter: 'S11' | 'S21', startHz, stopHz, points, ifbwHz? }
//             -> { instrument, parameter, frequenciesHz, real, imag, corrected, method }
//
// The commands are the ones in Keysight's FieldFox programming guide (NA mode): INST "NA"
// with *OPC? because a mode switch is overlapped; CALC:PAR1:DEF / :SEL; SENS:FREQ:STAR /
// STOP, SENS:SWE:POIN, SENS:BWID; FORM ASC,0; INIT:CONT 0 then INIT:IMM;*OPC? ("always
// single-sweep when programming", the guide says); SENS:FREQ:DATA? for the x axis and
// CALC:DATA:SDATA? for the trace as real,imag pairs, corrected when correction is on.
// Nothing here has met a real FieldFox yet; it has met the scripted one in
// fake-fieldfox.mjs, which answers the way the guide says the instrument does.
//
// Listens on 127.0.0.1 only. No dependencies. Public domain (The Unlicense). By ZR1JT.

import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';
export const DEFAULT_HTTP_PORT = 8075;
export const SCPI_PORT = 5025;
/** The most points a FieldFox will take; the instrument is the final judge. */
export const MAX_POINTS = 10001;

// ---- SCPI over a socket ----

/** One instrument's socket: commands out, lines back, one exchange at a time. */
export class ScpiSocket {
  /** @param {string} host @param {number} port @param {(line: string) => void} [log] every command and reply */
  constructor(host, port, log) {
    this.host = host;
    this.port = port;
    this.log = log;
    /** @type {import('node:net').Socket | undefined} */
    this.socket = undefined;
    this.buffer = '';
    /** @type {{ resolve: (line: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; block: boolean } | undefined} */
    this.pending = undefined;
  }

  /** @param {number} timeoutMs */
  open(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`No answer from ${this.host}:${this.port} within ${timeoutMs} ms.`));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        this.socket = socket;
        resolve(undefined);
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${this.host}:${this.port}: ${e.message}`));
      });
      socket.on('data', (chunk) => {
        this.buffer += chunk.toString('latin1');
        this.deliver();
      });
      socket.on('close', () => {
        this.socket = undefined;
        this.pending?.reject(new Error(`${this.host}:${this.port} closed the connection.`));
        this.pending = undefined;
      });
    });
  }

  deliver() {
    const p = this.pending;
    if (!p) return;
    let reply;
    if (p.block && this.buffer.startsWith('#')) {
      // An IEEE 488.2 definite-length block: #, one digit giving the length's digit count,
      // the length, then that many bytes - which may hold newlines - then the terminator.
      const digits = Number(this.buffer[1]);
      if (!(digits >= 1) || this.buffer.length < 2 + digits) return;
      const length = Number(this.buffer.slice(2, 2 + digits));
      const total = 2 + digits + length;
      if (this.buffer.length < total) return;
      reply = this.buffer.slice(2 + digits, total);
      this.buffer = this.buffer.slice(total).replace(/^\r?\n/, '');
    } else {
      const at = this.buffer.indexOf('\n');
      if (at < 0) return;
      reply = this.buffer.slice(0, at).replace(/\r$/, '');
      this.buffer = this.buffer.slice(at + 1);
    }
    this.pending = undefined;
    clearTimeout(p.timer);
    this.log?.(`< ${reply.length > 100 ? `${reply.slice(0, 100).replace(/\n/g, '⏎')}… (${reply.length} chars)` : reply}`);
    p.resolve(reply);
  }

  /** A command that answers nothing. @param {string} command */
  write(command) {
    if (!this.socket) throw new Error('Not connected.');
    this.log?.(`> ${command}`);
    this.socket.write(`${command}\n`);
  }

  /**
   * A query: the command, then one line back - or, with `block`, a definite-length block
   * if that is what comes (SYST:HELP:HEAD? answers with one), else a line.
   * @param {string} command @param {number} timeoutMs @param {{ block?: boolean }} [options]
   */
  query(command, timeoutMs = 5000, options = {}) {
    if (!this.socket) return Promise.reject(new Error('Not connected.'));
    if (this.pending) return Promise.reject(new Error('A query is already waiting.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error(`No reply to ${command} within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending = { resolve, reject, timer, block: options.block ?? false };
      this.log?.(`> ${command}`);
      this.socket?.write(`${command}\n`);
      this.deliver();
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = undefined;
  }
}

// ---- The FieldFox ----

/** Keysight's reply to SYST:ERR? when all is well starts with 0 (or +0). */
const noError = (reply) => /^\+?0\b/.test(reply.trim());

/** Strips the quotes SCPI puts round strings. @param {string} s */
const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1');

/**
 * A message with SYST:ERR? on the end answers "<value>;<code>,"<text>"" on one line (IEEE
 * 488.2: one response message, units separated by semicolons). When the first unit was a
 * query the instrument does not know, nothing comes back for it and the whole line is the
 * error. Splits at the last semicolon that precedes something shaped like an error.
 * @param {string} reply
 */
export function splitReply(reply) {
  const m = /^(?:(.*);)?\s*([+-]?\d+\s*,\s*".*")\s*$/s.exec(reply);
  if (!m) return { value: reply.trim(), error: '0,"No error"' };
  return { value: (m[1] ?? '').trim(), error: m[2] };
}

/** The last unit of a compound response: the SYST:ERR? answer. @param {string} reply */
const lastUnit = (reply) => splitReply(reply).error;

/**
 * An instrument's own command list (SYST:HELP:HEADers?) as a set of short-form headers,
 * so the bridge can ask "does this firmware have CALC:PAR at all?" instead of trying
 * spellings. One line of the list looks like `:CALCulate{1:1}[:SELected]:DATA:SDATa` or
 * `[:SENSe{1:1}]:SWEep:TIME` or `*OPC`: the capitals of each mnemonic are its short form,
 * `{…}` is a suffix range, `[…]` an optional node (both forms are entered), and
 * `/qonly/` and `/nquery/` say query-only and command-only.
 * @param {string} block
 */
export function parseHeaders(block) {
  const out = new Set();
  for (const raw of block.split(/\r?\n/)) {
    const h = raw.trim().replace(/\/(qonly|nquery)\//g, '').replace(/\?$/, '').replace(/\{[^}]*\}/g, '');
    if (!h) continue;
    if (h.startsWith('*')) {
      out.add(h.toUpperCase());
      continue;
    }
    const nodes = [];
    const re = /(\[)?:?([A-Za-z0-9|]+)(\])?/g;
    let m;
    while ((m = re.exec(h))) nodes.push({ short: m[2].split('|')[0].replace(/[a-z]/g, '').replace(/\d+$/, ''), optional: Boolean(m[1]) });
    const optional = nodes.filter((n) => n.optional).length;
    for (let mask = 0; mask < 1 << optional; mask++) {
      const parts = [];
      let k = 0;
      for (const n of nodes) {
        if (!n.optional) parts.push(n.short);
        else if (mask & (1 << k++)) parts.push(n.short);
      }
      out.add(parts.join(':'));
    }
  }
  return out;
}

/**
 * SCPI's short form of a mnemonic: the first four letters, the fourth dropped if it is a
 * vowel - FREQuency -> FREQ, PARameter -> PAR, SDATa -> SDAT, DEFine -> DEF - and a
 * mnemonic of four letters or fewer as it is. The list's capitals say the same thing;
 * this is for the commands the bridge sends, which may be long or short.
 * @param {string} mnemonic upper case
 */
export function shortForm(mnemonic) {
  if (mnemonic.length <= 4) return mnemonic;
  const four = mnemonic.slice(0, 4);
  return /[AEIOU]$/.test(four) ? four.slice(0, 3) : four;
}

/** A command header as parseHeaders' set would hold it: upper case, short forms, no suffix digits. @param {string} header */
export function normaliseHeader(header) {
  return header
    .toUpperCase()
    .replace(/\s.*$/, '')
    .replace(/\?$/, '')
    .replace(/^:/, '')
    .split(':')
    .map((node) => (node.startsWith('*') ? node : shortForm(node.replace(/\d+$/, ''))))
    .join(':');
}

/** Whether a firmware's vocabulary has a header, exactly, or (as a prefix) a subsystem. */
export function knows(vocabulary, header, { prefix = false } = {}) {
  const wanted = normaliseHeader(header);
  if (vocabulary.has(wanted)) return true;
  if (!prefix) return false;
  for (const h of vocabulary) if (h.startsWith(`${wanted}:`)) return true;
  return false;
}

/**
 * One FieldFox on the network. Every method opens its own connection and closes it after,
 * so a bridge left running does not hold the instrument's socket, and a FieldFox that was
 * switched off and on again is simply found again next time.
 */
export class FieldFox {
  /** @param {{ id: string; name: string; host: string; port?: number; log?: (line: string) => void }} spec */
  constructor(spec) {
    this.id = spec.id;
    this.name = spec.name;
    this.host = spec.host;
    this.port = spec.port ?? SCPI_PORT;
    this.log = spec.log;
    /** Sweeps queue up behind one another: an instrument sweeps one thing at a time. */
    this.queue = Promise.resolve();
    /**
     * How this instrument's firmware takes a trace's parameter - which of PARAMETER_FORMS
     * worked, or 'none' - learnt on the first sweep. An N9914A on A.07.75 refuses them all
     * with -113 "Undefined header" (see fake-fieldfox.mjs).
     * @type {number | 'none' | undefined}
     */
    this.parameterForm = undefined;
    /**
     * The firmware's own command list, asked once (SYST:HELP:HEADers?) and kept; undefined
     * until asked, null when the firmware cannot say. With it the bridge knows what not to
     * try: an N9914A on A.07.75 lists no CALC:PAR, no INIT and no CORR state at all.
     * @type {Set<string> | null | undefined}
     */
    this.vocabulary = undefined;
  }

  /** The firmware's command list, fetched on first need. @param {ScpiSocket} s */
  async learnVocabulary(s) {
    if (this.vocabulary !== undefined) return this.vocabulary;
    try {
      const block = await s.query('SYST:HELP:HEAD?', 30000, { block: true });
      const err = await s.query('SYST:ERR?');
      if (!noError(err) || !block.includes(':')) throw new Error(err.trim());
      this.vocabulary = parseHeaders(block);
      this.log?.(`  (this firmware lists ${this.vocabulary.size} command forms)`);
    } catch (e) {
      this.log?.(`  (no command list from this firmware: ${e instanceof Error ? e.message : String(e)} - trying things instead)`);
      s.write('*CLS');
      this.vocabulary = null;
    }
    return this.vocabulary;
  }

  /** Whether the firmware has a command, when it has told us; true (worth trying) when it has not. */
  has(header, options) {
    return this.vocabulary ? knows(this.vocabulary, header, options) : true;
  }

  get address() {
    return `${this.host}:${this.port}`;
  }

  /** Runs a task with the socket open, after whatever is already running. @template T @param {(s: ScpiSocket) => Promise<T>} task */
  withSocket(task, connectTimeoutMs = 3000) {
    const run = async () => {
      const socket = new ScpiSocket(this.host, this.port, this.log);
      await socket.open(connectTimeoutMs);
      try {
        return await task(socket);
      } finally {
        socket.close();
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Who it is: identification, options and the modes it has. */
  describe() {
    return this.withSocket(async (s) => {
      const idn = (await s.query('*IDN?')).trim();
      const options = unquote(await s.query('*OPT?'));
      // INST:CAT? answers "CAT","NA","SA": each name in its own quotes (one unit listed a mode twice).
      const modes = [...new Set((await s.query('INST:CAT?')).split(',').map(unquote).filter(Boolean))];
      return { idn, options, modes };
    });
  }

  /**
   * Switches to NA mode if the instrument is not there, and makes sure it got there: a mode
   * switch is overlapped, and *OPC? is meant to wait for it, but an instrument that answers
   * early is still in its old mode, whose command tree has no NA commands in it.
   * @param {ScpiSocket} s
   */
  async enterNaMode(s) {
    const mode = unquote(await s.query('INST?'));
    if (mode === 'NA') return;
    const modes = unquote(await s.query('INST:CAT?'));
    if (!/\bNA\b/.test(modes)) {
      throw new InstrumentError(`This FieldFox has no network-analyser mode (it has ${modes || 'none it will name'}); EMWS needs S-parameters, which NA mode gives.`);
    }
    await this.ask(s, 'INST "NA";*OPC?', 'Switching to NA mode', 15000);
    // A new mode may take a different spelling, or none, and lists different commands: find out again.
    this.parameterForm = undefined;
    this.vocabulary = undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (unquote(await s.query('INST?')) === 'NA') return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new InstrumentError('The FieldFox was asked to switch to NA mode and did not, within ten seconds.');
  }

  /**
   * One setting: the command with SYST:ERR? on the same message, so every message gets one
   * answer, and a refusal names the command refused. The first real FieldFox refused
   * commands it documents when four were sent in a burst as separate lines; a query it does
   * not know gets no reply at all, which this turns into an answer instead of a timeout.
   * @param {ScpiSocket} s @param {string} command @param {string} what
   */
  async set(s, command, what) {
    // The leading colon puts SYST:ERR? at the root whatever path the command left us on.
    const reply = await s.query(`${command};:SYST:ERR?`);
    if (!noError(lastUnit(reply))) throw new InstrumentError(`${what} (${command}): the FieldFox says ${lastUnit(reply).trim()}`);
  }

  /**
   * A query with SYST:ERR? on the same message: the value, or the instrument's reason.
   * @param {ScpiSocket} s @param {string} query @param {string} what @param {number} [timeoutMs]
   */
  async ask(s, query, what, timeoutMs) {
    const reply = await s.query(`${query};:SYST:ERR?`, timeoutMs);
    const { value, error } = splitReply(reply);
    if (!noError(error)) throw new InstrumentError(`${what} (${query}): the FieldFox says ${error.trim()}`);
    return value;
  }

  /**
   * Asks the instrument a battery of harmless questions and reports which it answers: the
   * way to learn a firmware's vocabulary when the guides do not match it. Nothing in the
   * list changes a setting; the define attempts at the end only repeat what a sweep would
   * try. Each line of the report is "command => answer" or "command => REFUSED: reason".
   */
  probe() {
    return this.withSocket(async (s) => {
      const lines = [];
      const one = async (command, timeoutMs = 5000) => {
        try {
          const reply = await s.query(`${command};:SYST:ERR?`, timeoutMs);
          const { value, error } = splitReply(reply);
          const shown = value.length > 120 ? `${value.slice(0, 120)}… (${value.length} chars, ${value.split(',').length} values)` : value;
          lines.push(noError(error) ? `${command} => ${shown}` : `${command} => REFUSED: ${error.trim()}`);
        } catch (e) {
          lines.push(`${command} => NO ANSWER (${e instanceof Error ? e.message : String(e)})`);
        }
        s.write('*CLS');
      };
      await one('*IDN?');
      await one('*OPT?');
      await one('SYST:VERS?');
      await one('INST:CAT?');
      await one('INST?');
      await one('INST:SEL?');
      lines.push('--- is CALCulate there at all, in this mode? ---');
      for (const q of ['CALC:PAR:COUN?', 'CALC:PAR1:DEF?', 'CALC:PAR:DEF?', 'CALC1:PAR1:DEF?', 'CALC1:PAR:DEF?', 'CALC:FORM?', 'CALC:MARK1:STAT?', 'CALC:SMO:STAT?', 'CALC:TRAN:TIME:STAT?']) await one(q);
      lines.push('--- the sweep settings ---');
      for (const q of ['SENS:FREQ:STAR?', 'SENS:FREQ:STOP?', 'SENS:FREQ:CENT?', 'SENS:FREQ:SPAN?', 'SENS:SWE:POIN?', 'SENS:BWID?', 'SENS:BAND?', 'SENS:SWE:TIME?', 'SENS:SWE:MTIM?', 'SENS:AVER:COUN?', 'FORM?', 'FORM:DATA?', 'SOUR:POW?', 'DISP:WIND:SPL?']) await one(q);
      lines.push('--- triggering ---');
      for (const q of ['INIT:CONT?', 'INITiate:CONTinuous?', 'TRIG:SOUR?', 'TRIGger:SOURce?', 'SENS:SWE:MODE?', 'TRIG:SING?', 'ABOR?', 'SENS:SWE:TRIG?', 'STAT:OPER:COND?', 'STAT:OPER:AVER:COND?']) await one(q);
      lines.push('--- the data (lengths only) ---');
      for (const q of TRACE_QUERIES) await one(q, 20000);
      for (const q of ['SENS:FREQ:DATA?', 'CALC:DATA:FDATA?', 'CALC:SEL:DATA:FDATA?', 'TRAC:DATA?', 'TRAC1:DATA?', 'CALC:MEAS:DATA?']) await one(q, 20000);
      lines.push('--- is the trace moving? (two reads, 1.5 s apart) ---');
      try {
        const a = splitReply(await s.query('CALC:DATA:SDATA?;:SYST:ERR?', 20000)).value;
        await new Promise((r) => setTimeout(r, 1500));
        const b = splitReply(await s.query('CALC:DATA:SDATA?;:SYST:ERR?', 20000)).value;
        lines.push(a === b ? 'the trace is IDENTICAL in both reads: the instrument is not sweeping (Hold?), or the trace is a memory' : 'the trace changed between the reads: the instrument is sweeping');
      } catch (e) {
        lines.push(`could not read the trace twice: ${e instanceof Error ? e.message : String(e)}`);
      }
      s.write('*CLS');
      lines.push('--- sweep control, more spellings ---');
      for (const q of ['SENS:SWE:CONT?', 'SENS:SWE:HOLD?', 'SENS:HOLD?', 'SENS:SWE:TYPE?', 'SENS:SWE:GEN?', 'SENS:SWE:DWEL?', 'SENS:SWE:STAT?', 'INIT1?', 'SENS:INIT?', 'SYST:SWE:CONT?', 'SENS:SWE:RUN?', 'DIAG:SWE:MODE?', 'STAT:OPER:COND?']) await one(q);
      lines.push('--- calibration ---');
      for (const q of ['SENS:CORR?', 'SENS:CORR:STAT?', 'SENS:CORR:USER?', 'SENS:CORR:USER:STAT?', 'SENS:CORR:COLL:METH:TYPE?', 'SENS:CORR:CALR:TYPE?', 'SENS:CORR:CSET?', 'SENS:CORR:IMP?', 'SENS:CORR:TYPE?']) await one(q);
      lines.push('--- choosing S11: every spelling a sweep would try, and a few more ---');
      for (const c of ['CALC:PAR1:DEF S11', 'CALC:PAR:DEF S11', 'CALC1:PAR1:DEF S11', 'CALC1:PAR:DEF S11', "CALC:PAR1:DEF 'S11'", 'CALC:PAR1:DEF "S11"', 'CALC:PAR1:SEL', 'CALC:PAR:SEL', 'CALC:MEAS1:DEF S11', 'CALC:MEAS:DEF S11', 'CALC:PAR1:DEF:S11', 'CALC:PAR1:FUNC S11', 'CALC:PAR1:MEAS S11', 'CALC:PAR1 S11', 'SENS:FUNC "S11"', 'CALC:PAR1:CAT?', 'CALC:PAR:CAT?']) await one(c);
      lines.push('--- its own list of commands (SYST:HELP:HEAD?, a definite-length block) ---');
      try {
        const list = await s.query('SYST:HELP:HEAD?', 30000, { block: true });
        const err = await s.query('SYST:ERR?');
        if (!noError(err)) lines.push(`SYST:HELP:HEAD? => REFUSED: ${err.trim()}`);
        else {
          const headers = list.split(/\r?\n/).map((h) => h.trim()).filter(Boolean);
          lines.push(`SYST:HELP:HEAD? => ${headers.length} headers, ${list.length} bytes:`);
          for (const h of headers) lines.push(`    ${h}`);
        }
      } catch (e) {
        lines.push(`SYST:HELP:HEAD? => NO ANSWER (${e instanceof Error ? e.message : String(e)})`);
      }
      s.write('*CLS');
      return lines;
    });
  }

  /**
   * Defines and selects the trace's parameter, in whichever spelling this firmware takes -
   * or, when it takes none of them, says so and leaves the trace as the instrument shows
   * it. An N9914A on A.07.75 refuses every spelling in NA mode while answering everything
   * else, and a sweep of the trace on its screen is worth far more than no sweep: the
   * person selects S11 on the front panel, and the page says the choice was theirs.
   * @param {ScpiSocket} s @param {'S11' | 'S21'} parameter
   * @returns {Promise<{ set: boolean; refusals: string[] }>}
   */
  async defineParameter(s, parameter) {
    const refusals = [];
    if (!this.has('CALC:PAR', { prefix: true })) {
      this.parameterForm = 'none';
      return { set: false, refusals: [], absent: true };
    }
    if (this.parameterForm === 'none') return { set: false, refusals: ['refused on an earlier sweep'] };
    const candidates = this.parameterForm !== undefined ? [this.parameterForm] : PARAMETER_FORMS.map((_, n) => n);
    for (const n of candidates) {
      const form = PARAMETER_FORMS[n];
      s.write('*CLS');
      const reply = lastUnit(await s.query(`${form.define} ${parameter};:SYST:ERR?`));
      if (!noError(reply)) {
        refusals.push(`${form.define}: ${reply.trim()}`);
        continue;
      }
      this.parameterForm = n;
      // Selecting the trace matters only with several; one trace is selected already. A
      // firmware that refuses the select is told so in the log and otherwise left alone.
      const selected = lastUnit(await s.query(`${form.select};:SYST:ERR?`));
      if (!noError(selected)) {
        this.log?.(`  (${form.select} refused: ${selected.trim()} - carrying on with the trace as it is)`);
        s.write('*CLS');
      }
      return { set: true, refusals };
    }
    this.parameterForm = 'none';
    this.log?.(`  (no spelling of "define ${parameter}" is accepted; sweeping the trace the instrument shows)`);
    s.write('*CLS');
    return { set: false, refusals };
  }

  /**
   * One sweep in network-analyser mode.
   * @param {{ parameter: 'S11' | 'S21'; startHz: number; stopHz: number; points: number; ifbwHz?: number }} request
   */
  sweep(request) {
    return this.withSocket(async (s) => {
      await this.set(s, '*CLS', 'Clearing the error queue');
      // Only switch when needed - switching resets the mode's settings, calibration included.
      await this.enterNaMode(s);
      await this.learnVocabulary(s);
      const defined = await this.defineParameter(s, request.parameter);
      await this.set(s, `SENS:FREQ:STAR ${request.startHz}`, 'Start frequency');
      await this.set(s, `SENS:FREQ:STOP ${request.stopHz}`, 'Stop frequency');
      await this.set(s, `SENS:SWE:POIN ${request.points}`, 'Points');
      if (request.ifbwHz) await this.set(s, `SENS:BWID ${request.ifbwHz}`, 'IF bandwidth');
      await this.set(s, 'FORM ASC,0', 'Data format');
      // Single-sweep triggering, as the guide insists - where the firmware has it. An
      // N9914A on A.07.75 has no INITiate subsystem at all; it sweeps on its own, so there
      // the bridge waits out two sweeps at the new settings and reads what it then holds.
      let wasContinuous = false;
      let triggered = false;
      if (this.has('INIT', { prefix: true })) {
        try {
          wasContinuous = (await this.ask(s, 'INIT:CONT?', 'Trigger state')).trim() !== '0';
          await this.set(s, 'INIT:CONT 0', 'Single sweep');
          triggered = true;
        } catch (e) {
          this.log?.(`  (${e instanceof Error ? e.message : String(e)} - no trigger control on this firmware; letting it sweep on its own)`);
          s.write('*CLS');
        }
      }
      try {
        /** @type {{ level: 'info' | 'warning'; text: string }[]} */
        const notes = [];
        if (defined.absent) {
          notes.push({ level: 'info', text: `This instrument's firmware has no command for choosing the measurement over the network, so the trace on its screen is what was read: ${request.parameter} if ${request.parameter} is what it shows.` });
        } else if (!defined.set) {
          notes.push({ level: 'warning', text: `The instrument would not let the bridge choose ${request.parameter} (${defined.refusals.join('; ')}); this is the trace it was showing.` });
        }
        let pairs;
        if (triggered) {
          // A long sweep at a narrow IF bandwidth can take a while: give it two minutes.
          await this.ask(s, 'INIT:IMM;*OPC?', 'Triggering the sweep', 120000);
          pairs = await this.readTrace(s);
        } else {
          // Without trigger control the trace is whatever the instrument holds, and if it
          // is on Hold that is the same trace for ever: a tester's N9914A gave the same 202
          // values to seven figures in every read, minutes apart. Read twice, a sweep apart,
          // and say so when nothing moved - a sweeping instrument's noise digits never repeat.
          await this.waitForSweeps(s, 2);
          const first = await this.readTrace(s);
          await this.waitForSweeps(s, 1);
          pairs = await this.readTrace(s);
          if (first.length === pairs.length && first.every((v, i) => v === pairs[i])) {
            notes.push({ level: 'warning', text: 'The trace did not change between two reads a sweep apart: the instrument is probably on Hold (single sweep), and this firmware gives the bridge no way to trigger one. Set it to continuous sweep on the instrument, then measure again.' });
          }
        }
        const frequenciesHz = await this.readFrequencies(s, request);
        if (pairs.length !== frequenciesHz.length * 2) {
          throw new InstrumentError(`The FieldFox returned ${pairs.length} values for ${frequenciesHz.length} frequencies; expected real and imaginary pairs.`);
        }
        const real = [];
        const imag = [];
        for (let i = 0; i < pairs.length; i += 2) {
          real.push(pairs[i]);
          imag.push(pairs[i + 1]);
        }
        // Whether the readings are corrected is worth knowing but not worth losing a sweep
        // over: a firmware that does not answer these is reported as "not known". Two
        // questions, because a FieldFox with no user calibration is still corrected by
        // CalReady, its factory calibration at its own port: SENS:CORR? says whether any
        // correction is on, SENS:CORR:USER? whether it is the person's own (QuickCal or a
        // kit, at the end of their cable). Reporting only the second once told a tester
        // their readings were uncorrected when they were CalReady-corrected.
        let corrected;
        let method = '';
        if (this.has('SENS:CORR') || this.has('SENS:CORR:STAT')) {
          try {
            corrected = (await this.ask(s, 'SENS:CORR?', 'Correction state')).trim() !== '0';
            if (corrected) {
              const user = (await this.ask(s, 'SENS:CORR:USER?', 'User correction state')).trim() !== '0';
              method = user ? unquote(await this.ask(s, 'SENS:CORR:COLL:METH:TYPE?', 'Calibration method')) : 'CalReady';
            }
          } catch (e) {
            this.log?.(`  (${e instanceof Error ? e.message : String(e)} - correction state not known)`);
            s.write('*CLS');
            corrected = undefined;
            method = '';
          }
        }
        for (const note of notes) this.log?.(`  (${note.text})`);
        return { frequenciesHz, real, imag, corrected, method, parameterSet: defined.set, parameterNote: notes[0]?.text ?? '', notes };
      } finally {
        // Leave the instrument sweeping as it was found.
        if (triggered && wasContinuous) s.write('INIT:CONT 1');
      }
    });
  }

  /**
   * On a firmware with no trigger control: how long one sweep takes, asked of the
   * instrument, or a guess if it will not say; then that many sweeps' worth of waiting.
   * @param {ScpiSocket} s @param {number} sweeps
   */
  async waitForSweeps(s, sweeps) {
    let seconds = 1;
    for (const q of ['SENS:SWE:MTIM?', 'SENS:SWE:TIME?']) {
      if (!this.has(q)) continue;
      try {
        const v = Number(await this.ask(s, q, 'Sweep time'));
        if (Number.isFinite(v) && v > 0) {
          seconds = v;
          break;
        }
      } catch {
        s.write('*CLS');
      }
    }
    const waitMs = Math.min(60000, Math.round((sweeps * seconds + 0.5) * 1000));
    this.log?.(`  (waiting ${waitMs} ms for ${sweeps} sweeps of ${seconds} s)`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  /**
   * The x axis: asked of the instrument, or laid out from the request when the firmware
   * will not say (a linear sweep, which is all the bridge asks for).
   * @param {ScpiSocket} s @param {{ startHz: number; stopHz: number; points: number }} request
   */
  async readFrequencies(s, request) {
    try {
      if (!this.has('SENS:FREQ:DATA')) throw new InstrumentError('SENS:FREQ:DATA? is not in this firmware');
      return parseNumbers(await this.ask(s, 'SENS:FREQ:DATA?', 'Reading the frequencies', 20000));
    } catch (e) {
      this.log?.(`  (${e instanceof Error ? e.message : String(e)} - laying the frequencies out from the request)`);
      s.write('*CLS');
      return Array.from({ length: request.points }, (_, i) => request.startHz + ((request.stopHz - request.startHz) * i) / (request.points - 1));
    }
  }

  /**
   * The trace as real,imag pairs, in whichever spelling the firmware takes; every refusal
   * is named if none does, with the probe as the next step.
   * @param {ScpiSocket} s
   */
  async readTrace(s) {
    const refusals = [];
    const listed = this.vocabulary ? TRACE_QUERIES.filter((q) => this.has(q)) : [];
    for (const q of listed.length ? listed : TRACE_QUERIES) {
      try {
        return parseNumbers(await this.ask(s, q, 'Reading the trace', 20000));
      } catch (e) {
        refusals.push(e instanceof Error ? e.message : String(e));
        s.write('*CLS');
      }
    }
    throw new InstrumentError(`The trace could not be read in any spelling the bridge knows - ${refusals.join('; ')}. Run the bridge with --probe and send the file it writes.`);
  }
}

export class InstrumentError extends Error {}

/**
 * The spellings tried for "measure S11 on trace 1", in order. The first is the guide's;
 * the rest are what an older parser might want instead: no trace number, or the long
 * mnemonics (a short-form table that lacks DEF still has DEFine).
 */
export const PARAMETER_FORMS = [
  { define: 'CALC:PAR1:DEF', select: 'CALC:PAR1:SEL' },
  { define: 'CALC:PAR:DEF', select: 'CALC:PAR:SEL' },
  { define: 'CALCulate:PARameter1:DEFine', select: 'CALCulate:PARameter1:SELect' },
  { define: 'CALCulate:PARameter:DEFine', select: 'CALCulate:PARameter:SELect' },
];

/** The spellings tried for "the trace, unformatted, real and imaginary", in order. */
export const TRACE_QUERIES = ['CALC:DATA:SDATA?', 'CALC:SEL:DATA:SDATA?', 'CALC1:DATA:SDATA?', 'CALCulate:DATA:SDATa?', 'CALC:PAR1:DATA:SDATA?'];

/** A comma-separated SCPI list, as numbers. @param {string} reply */
export function parseNumbers(reply) {
  const trimmed = reply.trim();
  if (trimmed === '') return [];
  return trimmed.split(',').map((t) => {
    const v = Number(t);
    if (!Number.isFinite(v)) throw new InstrumentError(`Not a number in the instrument's reply: "${t.slice(0, 20)}"`);
    return v;
  });
}

// ---- HTTP for the page ----

/**
 * Starts the bridge.
 * @param {{ instruments: FieldFox[]; port?: number; host?: string; log?: (line: string) => void }} options
 * @returns {Promise<{ url: string; close: () => Promise<void> }>}
 */
export function createBridge(options) {
  const { instruments, log = () => {} } = options;
  const byId = new Map(instruments.map((i) => [i.id, i]));
  /** What each instrument said about itself, remembered for a little while. */
  const descriptions = new Map();

  const describeAll = async () => {
    return Promise.all(
      instruments.map(async (i) => {
        const cached = descriptions.get(i.id);
        if (cached && Date.now() - cached.at < 10000) return cached.info;
        let info;
        try {
          const d = await i.describe();
          info = { id: i.id, name: i.name, address: i.address, status: 'ok', ...d };
        } catch (e) {
          info = { id: i.id, name: i.name, address: i.address, status: 'unreachable', error: e instanceof Error ? e.message : String(e) };
        }
        descriptions.set(i.id, { at: Date.now(), info });
        return info;
      }),
    );
  };

  const cors = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chromium asks a loopback service for leave before a page from the internet may call it.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Cache-Control', 'no-store');
  };
  const json = (res, status, body) => {
    cors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'OPTIONS') {
        cors(res);
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        json(res, 200, { service: 'emws-vna-bridge', version: VERSION, kinds: ['vna'], instruments: await describeAll() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/sweep') {
        const body = await readJson(req);
        const problem = validateSweep(body);
        if (problem) {
          json(res, 400, { error: problem });
          return;
        }
        const instrument = byId.get(body.instrument);
        if (!instrument) {
          json(res, 404, { error: `No instrument called "${body.instrument}" here.` });
          return;
        }
        log(`sweep ${body.parameter} ${body.startHz}-${body.stopHz} Hz, ${body.points} points on ${instrument.name}`);
        const result = await instrument.sweep({ parameter: body.parameter, startHz: body.startHz, stopHz: body.stopHz, points: body.points, ifbwHz: body.ifbwHz });
        json(res, 200, { instrument: instrument.id, parameter: body.parameter, ...result });
        return;
      }
      json(res, 404, { error: 'Not here. The bridge answers GET /health and POST /sweep.' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`error: ${message}`);
      // Whatever went wrong went wrong on the instrument's side of the bridge.
      json(res, 502, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_HTTP_PORT, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      });
    });
  });
}

/** @param {unknown} body */
export function validateSweep(body) {
  if (!body || typeof body !== 'object') return 'The request must be a JSON object.';
  const b = /** @type {Record<string, unknown>} */ (body);
  if (typeof b.instrument !== 'string') return 'Say which instrument: "instrument".';
  if (b.parameter !== 'S11' && b.parameter !== 'S21') return 'parameter must be "S11" or "S21".';
  for (const key of ['startHz', 'stopHz', 'points']) {
    if (typeof b[key] !== 'number' || !Number.isFinite(b[key])) return `${key} must be a number.`;
  }
  if (b.startHz <= 0 || b.stopHz <= b.startHz) return 'startHz must be above zero and stopHz above startHz.';
  if (!Number.isInteger(b.points) || b.points < 2 || b.points > MAX_POINTS) return `points must be a whole number from 2 to ${MAX_POINTS}.`;
  if (b.ifbwHz !== undefined && (typeof b.ifbwHz !== 'number' || !(b.ifbwHz > 0))) return 'ifbwHz, if given, must be above zero.';
  return undefined;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 64 * 1024) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new Error('The request body is not JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// ---- command line ----

/** @param {string[]} argv */
export function parseArgs(argv) {
  const spec = { fieldfox: /** @type {string[]} */ ([]), port: DEFAULT_HTTP_PORT, simulate: false, log: false, probe: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fieldfox') spec.fieldfox.push(argv[++i] ?? '');
    else if (a === '--port') spec.port = Number(argv[++i]);
    else if (a === '--simulate') spec.simulate = true;
    else if (a === '--log') spec.log = true;
    else if (a === '--probe') spec.probe = true;
    else if (a === '--help' || a === '-h') spec.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return spec;
}

/** "host", "host:port" or "[v6]:port" -> { host, port }. @param {string} address */
export function parseAddress(address) {
  const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(address.trim());
  if (!m) throw new Error(`Not an address: "${address}". Use host or host:port.`);
  return { host: m[1] ?? m[2], port: m[3] ? Number(m[3]) : SCPI_PORT };
}

async function main() {
  const spec = parseArgs(process.argv.slice(2));
  if (spec.help || (spec.fieldfox.length === 0 && !spec.simulate)) {
    console.log(
      'EMWS VNA bridge\n\n  node bridge.mjs --fieldfox <host[:port]> [--fieldfox ...] [--port 8075] [--log]\n  node bridge.mjs --fieldfox <host[:port]> --probe\n  node bridge.mjs --simulate\n\n' +
        'Then open EMWS; its "Measure it" buttons offer the instrument. --log prints every command and reply;\n' +
        '--probe asks the instrument which commands it knows, writes the answers to a file, and stops.',
    );
    process.exit(spec.help ? 0 : 2);
  }
  const scpiLog = spec.log ? (line) => console.log(`  ${line}`) : undefined;
  const instruments = spec.fieldfox.map((address, n) => {
    const { host, port } = parseAddress(address);
    return new FieldFox({ id: `fieldfox-${n + 1}`, name: spec.fieldfox.length > 1 ? `FieldFox ${n + 1}` : 'FieldFox', host, port, log: scpiLog });
  });
  if (spec.simulate) {
    const { startFakeFieldFox } = await import('./fake-fieldfox.mjs');
    const fake = await startFakeFieldFox({ port: 0 });
    instruments.push(new FieldFox({ id: 'simulated', name: 'Simulated FieldFox', host: '127.0.0.1', port: fake.port, log: scpiLog }));
    console.log(`simulated FieldFox on 127.0.0.1:${fake.port} (75 ohm + 0.5 uH on port 1; a 145 MHz low-pass to port 2)`);
  }
  if (spec.probe) {
    const { writeFileSync } = await import('node:fs');
    for (const instrument of instruments) {
      console.log(`probing ${instrument.name} at ${instrument.address}…`);
      const lines = await instrument.probe();
      const file = `probe-${instrument.id}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
      writeFileSync(file, `${lines.join('\n')}\n`);
      for (const line of lines) console.log(`  ${line}`);
      console.log(`written to ${file} - please send that file.`);
    }
    process.exit(0);
  }
  const bridge = await createBridge({ instruments, port: spec.port, log: (line) => console.log(line) });
  console.log(`EMWS VNA bridge ${VERSION} at ${bridge.url} - ${instruments.map((i) => `${i.name} (${i.address})`).join(', ')}`);
  console.log('Open EMWS; its "Measure it" buttons offer the instrument. Ctrl+C stops the bridge.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
