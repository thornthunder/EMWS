// The VNA bridge, end to end in Node: a scripted FieldFox on a socket, the real bridge
// program in front of it, and the page's BridgeInstrument talking HTTP to the bridge -
// the same three pieces a bench measurement goes through, with the instrument replaced
// by arithmetic the answers can be checked against.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldFox, createBridge, knows, normaliseHeader, parseAddress, parseArgs, parseHeaders, parseNumbers, shortForm, splitReply, validateSweep } from '../services/emws-vna-bridge/bridge.mjs';
import { antennaGamma, lowPassS21, splitCommands, startFakeFieldFox } from '../services/emws-vna-bridge/fake-fieldfox.mjs';
import { BridgeInstrument, modelFromIdn, probeBridge } from '../src/lib/vna/bridge';

let fake: Awaited<ReturnType<typeof startFakeFieldFox>>;
let uncalibrated: Awaited<ReturnType<typeof startFakeFieldFox>>;
let bridge: Awaited<ReturnType<typeof createBridge>>;

beforeAll(async () => {
  fake = await startFakeFieldFox({ port: 0 });
  uncalibrated = await startFakeFieldFox({ port: 0, correction: false });
  bridge = await createBridge({
    port: 0,
    instruments: [
      new FieldFox({ id: 'ff', name: 'Bench FieldFox', host: '127.0.0.1', port: fake.port }),
      new FieldFox({ id: 'raw', name: 'Uncalibrated one', host: '127.0.0.1', port: uncalibrated.port }),
      new FieldFox({ id: 'gone', name: 'Switched off', host: '127.0.0.1', port: 1 }),
    ],
  });
});

afterAll(async () => {
  await bridge.close();
  await fake.close();
  await uncalibrated.close();
});

describe('the bridge, asked what it has', () => {
  it('names each instrument, says which answer, and tells the page it is the bridge', async () => {
    const info = await probeBridge(bridge.url);
    expect(info).toBeDefined();
    expect(info!.instruments.map((i) => [i.id, i.status])).toEqual([
      ['ff', 'ok'],
      ['raw', 'ok'],
      ['gone', 'unreachable'],
    ]);
    const ff = info!.instruments[0]!;
    expect(ff.idn).toContain('N9912A');
    expect(ff.options).toBe('104,110,303,230');
    expect(ff.modes).toEqual(['CAT', 'NA', 'SA']);
    expect(info!.instruments[2]!.error).toMatch(/connect/i);
    expect(modelFromIdn(ff.idn)).toBe('N9912A');
  });

  it('is not mistaken for something else, and nothing is found where nothing runs', async () => {
    expect(await probeBridge('http://127.0.0.1:1', 500)).toBeUndefined();
    // A server that answers 200 with something else is not a bridge either.
    const response = await fetch(`${bridge.url}/nowhere`);
    expect(response.status).toBe(404);
    const preflight = await fetch(`${bridge.url}/sweep`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
  });
});

describe('a sweep through the bridge', () => {
  it('reads S11 as the FieldFox reports it, and turns it into the impedance on the port', async () => {
    const info = (await probeBridge(bridge.url))!.instruments[0]!;
    const vna = new BridgeInstrument(bridge.url, info);
    expect(vna.name).toBe('Bench FieldFox (N9912A)');
    expect(vna.kind).toBe('bridge');
    const progress: [number, number][] = [];
    const points = await vna.sweep({ startMHz: 1, stopMHz: 30, points: 30, onProgress: (d, t) => progress.push([d, t]) });
    expect(points).toHaveLength(30);
    expect(points[0]!.fMHz).toBe(1);
    expect(points[29]!.fMHz).toBe(30);
    // 75 ohms + 0.5 uH: at 1 MHz, 75 + j3.14; at 30 MHz, 75 + j94.2.
    expect(points[0]!.z.re).toBeCloseTo(75, 4);
    expect(points[0]!.z.im).toBeCloseTo(2 * Math.PI * 1e6 * 0.5e-6, 4);
    expect(points[29]!.z.im).toBeCloseTo(2 * Math.PI * 30e6 * 0.5e-6, 3);
    const [re, im] = antennaGamma(10e6);
    const at10 = points.find((p) => Math.abs(p.fMHz - 10) < 1e-9)!;
    expect(at10.gamma.re).toBeCloseTo(re, 6);
    expect(at10.gamma.im).toBeCloseTo(im, 6);
    expect(progress.at(-1)).toEqual([1, 1]);
    expect(vna.lastCorrection).toEqual({ corrected: true, method: 'QuickCal' });
  });

  it('drives the instrument the way the programming guide says, and leaves it as it found it', async () => {
    fake.state.log.length = 0;
    fake.state.continuous = true;
    fake.state.mode = 'CAT';
    const info = (await probeBridge(bridge.url))!.instruments[0]!;
    await new BridgeInstrument(bridge.url, info).sweep({ startMHz: 7, stopMHz: 7.3, points: 11 });
    const log = fake.state.log;
    // NA mode is entered (the instrument was in CAT), with *OPC? because the switch is overlapped.
    expect(log).toContain('INST "NA"');
    expect(log[log.indexOf('INST "NA"') + 1]).toBe('*OPC?');
    expect(log).toContain('CALC:PAR1:DEF S11');
    expect(log).toContain('SENS:FREQ:STAR 7000000');
    expect(log).toContain('SENS:FREQ:STOP 7300000');
    expect(log).toContain('SENS:SWE:POIN 11');
    expect(log).toContain('FORM ASC,0');
    // Every setting travels with SYST:ERR? on the same message, so each gets one answer.
    expect(log[log.indexOf('SENS:SWE:POIN 11') + 1]).toBe('SYST:ERR?');
    // Single-sweep triggering, then the x axis and the complex trace, then back to continuous.
    const trigger = log.indexOf('INIT:IMM');
    expect(log[trigger - 2]).toBe('INIT:CONT 0');
    expect(log[trigger + 1]).toBe('*OPC?');
    expect(log.indexOf('SENS:FREQ:DATA?')).toBeGreaterThan(trigger);
    expect(log.indexOf('CALC:DATA:SDATA?')).toBeGreaterThan(trigger);
    expect(log.at(-1)).toBe('INIT:CONT 1');
    expect(fake.state.continuous).toBe(true);
    expect(fake.state.mode).toBe('NA');
    // Already in NA mode now: the next sweep must not switch (switching would drop the calibration).
    fake.state.log.length = 0;
    await new BridgeInstrument(bridge.url, info).sweep({ startMHz: 7, stopMHz: 7.3, points: 11 });
    expect(fake.state.log).not.toContain('INST "NA"');
  });

  it('reads S21 for a through measurement', async () => {
    const info = (await probeBridge(bridge.url))!.instruments[0]!;
    const points = await new BridgeInstrument(bridge.url, info).sweepTransmission({ startMHz: 45, stopMHz: 245, points: 3 });
    expect(points.map((p) => p.fMHz)).toEqual([45, 145, 245]);
    const [re, im] = lowPassS21(145e6);
    expect(points[1]!.s21.re).toBeCloseTo(re, 6);
    expect(points[1]!.s21.im).toBeCloseTo(im, 6);
    expect(Math.hypot(re, im)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(fake.state.log).toContain('CALC:PAR1:DEF S21');
  });

  it('says so when the instrument has its correction off, and names CalReady when that is all there is', async () => {
    const info = (await probeBridge(bridge.url))!.instruments[1]!;
    const vna = new BridgeInstrument(bridge.url, info);
    await vna.sweep({ startMHz: 1, stopMHz: 2, points: 2 });
    expect(vna.lastCorrection).toEqual({ corrected: false, method: '' });
    expect(fake.state.log.filter((c) => c.startsWith('SENS:CORR')).slice(-3)).toEqual(['SENS:CORR?', 'SENS:CORR:USER?', 'SENS:CORR:COLL:METH:TYPE?']);
  });

  it('turns the instrument\'s error queue and a dead instrument into readable errors', async () => {
    const all = (await probeBridge(bridge.url))!.instruments;
    // Too many points: the fake queues -222, and the bridge's SYST:ERR? check must find it.
    await expect(new BridgeInstrument(bridge.url, all[0]!).sweep({ startMHz: 1, stopMHz: 2, points: 10001 })).resolves.toHaveLength(10001);
    const tooMany = fetch(`${bridge.url}/sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instrument: 'ff', parameter: 'S11', startHz: 1e6, stopHz: 2e6, points: 20000 }),
    });
    expect((await tooMany).status).toBe(400);
    await expect(new BridgeInstrument(bridge.url, all[2]!).sweep({ startMHz: 1, stopMHz: 2, points: 3 })).rejects.toThrow(/connect/i);
    await expect(new BridgeInstrument(bridge.url, { ...all[0]!, id: 'nobody' }).sweep({ startMHz: 1, stopMHz: 2, points: 3 })).rejects.toThrow(/No instrument called "nobody"/);
    await expect(new BridgeInstrument('http://127.0.0.1:1', all[0]!).sweep({ startMHz: 1, stopMHz: 2, points: 3 })).rejects.toThrow(/could not be reached/);
  });

  it('one sweep at a time per instrument, so two tools asking at once both get whole answers', async () => {
    const info = (await probeBridge(bridge.url))!.instruments[0]!;
    const vna = new BridgeInstrument(bridge.url, info);
    const [a, b] = await Promise.all([vna.sweep({ startMHz: 1, stopMHz: 2, points: 5 }), vna.sweep({ startMHz: 10, stopMHz: 20, points: 7 })]);
    expect(a.map((p) => p.fMHz)).toEqual([1, 1.25, 1.5, 1.75, 2]);
    expect(b).toHaveLength(7);
    expect(b[0]!.fMHz).toBe(10);
  });
});

describe('the first real FieldFox: an N9914A on firmware A.07.75', () => {
  // Reported 2026-10-07 by its owner: found and identified, then refused CALC:PAR1:DEF with
  // -113 "Undefined header;CALC:PAR1:DEF<Err>" at "Measure the load". The legacy fake
  // answers exactly so, and finishes a mode switch only after it has answered *OPC?.
  let legacy: Awaited<ReturnType<typeof startFakeFieldFox>>;
  let old: Awaited<ReturnType<typeof createBridge>>;
  const exchange: string[] = [];
  let fieldfox: FieldFox;

  beforeAll(async () => {
    legacy = await startFakeFieldFox({ port: 0, legacy: true });
    fieldfox = new FieldFox({ id: 'n9914a', name: 'FieldFox', host: '127.0.0.1', port: legacy.port, log: (line) => exchange.push(line) });
    old = await createBridge({ port: 0, instruments: [fieldfox] });
  });
  afterAll(async () => {
    await old.close();
    await legacy.close();
  });

  it('is identified as reported, with its duplicated mode listed once', async () => {
    const info = (await probeBridge(old.url))!.instruments[0]!;
    expect(info.idn).toBe('Keysight Technologies,N9914A,MY53104315,A.07.75');
    expect(info.options).toBe('210,010,310,235,233,211');
    expect(info.modes).toEqual(['CPM', 'SA', 'NA', 'CAT']);
    expect(modelFromIdn(info.idn)).toBe('N9914A');
  });

  it('asks the firmware for its command list first, and then tries nothing the list rules out', async () => {
    const info = (await probeBridge(old.url))!.instruments[0]!;
    const vna = new BridgeInstrument(old.url, info);
    exchange.length = 0;
    const points = await vna.sweep({ startMHz: 140, stopMHz: 150, points: 101 });
    expect(points).toHaveLength(101);
    expect(points[0]!.z.re).toBeCloseTo(75, 3);
    const sent = exchange.filter((l) => l.startsWith('> ')).map((l) => l.slice(2));
    // The switch was confirmed by asking, not assumed from *OPC?: INST? was asked again after it.
    const switched = sent.indexOf('INST "NA";*OPC?;:SYST:ERR?');
    expect(switched).toBeGreaterThan(-1);
    expect(sent.slice(switched + 1)).toContain('INST?');
    expect(legacy.state.mode).toBe('NA');
    // Then the command list, once; it lists no CALC:PAR, no INIT, no CORR state, no MTIM.
    expect(sent.filter((l) => l === 'SYST:HELP:HEAD?')).toHaveLength(1);
    expect(fieldfox.vocabulary?.size).toBeGreaterThan(30);
    expect(sent.some((l) => /DEF/i.test(l))).toBe(false);
    expect(sent.some((l) => l.startsWith('INIT'))).toBe(false);
    expect(sent.some((l) => l.startsWith('SENS:CORR'))).toBe(false);
    expect(sent.some((l) => l.startsWith('SENS:SWE:MTIM'))).toBe(false);
    expect(fieldfox.parameterForm).toBe('none');
    // What it does do: set the sweep, wait it out (0 s = auto, so a second a sweep), read the trace twice.
    expect(sent.some((l) => l.startsWith('SENS:FREQ:STAR 140000000'))).toBe(true);
    expect(sent.some((l) => l.startsWith('SENS:SWE:TIME?'))).toBe(true);
    expect(exchange.some((l) => /waiting 2500 ms for 2 sweeps of 1 s/.test(l))).toBe(true);
    expect(sent.filter((l) => l.startsWith('CALC:DATA:SDATA?'))).toHaveLength(2);
    // The page is told, calmly: this is how the firmware is, not a fault.
    expect(vna.lastNotes).toEqual([{ level: 'info', text: expect.stringMatching(/no command for choosing the measurement .* S11 if S11 is what it shows/) }]);
    expect(vna.lastCorrection).toEqual({ corrected: undefined, method: '' });
    // Next time: no list, no switch, straight to the sweep.
    exchange.length = 0;
    await vna.sweepTransmission({ startMHz: 140, stopMHz: 150, points: 11 });
    const again = exchange.filter((l) => l.startsWith('> ')).map((l) => l.slice(2));
    expect(again).not.toContain('SYST:HELP:HEAD?');
    expect(again.some((l) => l.startsWith('INST "NA"'))).toBe(false);
    expect(vna.lastNotes[0]!.text).toMatch(/S21/);
  }, 40_000);

  it('notices a trace that does not move, as a unit on Hold gives, and reads its command list as a block', async () => {
    legacy.state.hold = true;
    const info = (await probeBridge(old.url))!.instruments[0]!;
    const vna = new BridgeInstrument(old.url, info);
    await vna.sweep({ startMHz: 140, stopMHz: 150, points: 11 });
    expect(vna.lastNotes.map((n) => n.level)).toEqual(['info', 'warning']);
    expect(vna.lastNotes[1]!.text).toMatch(/did not change between two reads .* probably on Hold/);
    legacy.state.hold = false;
    const lines = await fieldfox.probe();
    expect(lines).toContain('the trace changed between the reads: the instrument is sweeping');
    const at = lines.findIndex((l) => l.startsWith('SYST:HELP:HEAD? => '));
    expect(lines[at]).toMatch(/^SYST:HELP:HEAD\? => \d+ headers, \d+ bytes:$/);
    expect(lines.slice(at + 1)).toContain('    [:SENSe{1:1}]:FREQuency:STARt');
    expect(lines.slice(at + 1)).toContain('    :CALCulate{1:1}[:SELected]:DATA:SDATa');
  }, 40_000);

  it('reads a command list the way the instrument writes it', () => {
    const vocabulary = parseHeaders(
      [':CALCulate{1:1}[:SELected]:DATA:SDATa', '[:SENSe{1:1}]:FREQuency:DATA?/qonly/', '[:SENSe{1:1}]:CORRection:EXTension:PORT1|PORT', ':INSTrument[:SELect]', '*OPC', ':SYSTem:ERRor[:NEXT]?/qonly/'].join('\n'),
    );
    // Optional nodes are in both forms; suffix ranges go; the capitals are the short form.
    expect(vocabulary.has('CALC:DATA:SDAT')).toBe(true);
    expect(vocabulary.has('CALC:SEL:DATA:SDAT')).toBe(true);
    expect(vocabulary.has('FREQ:DATA')).toBe(true);
    expect(vocabulary.has('SENS:FREQ:DATA')).toBe(true);
    expect(vocabulary.has('INST')).toBe(true);
    expect(vocabulary.has('INST:SEL')).toBe(true);
    expect(vocabulary.has('*OPC')).toBe(true);
    expect(vocabulary.has('SYST:ERR:NEXT')).toBe(true);
    // What the bridge sends, in long or short form, with or without a trace number, matches.
    expect(normaliseHeader('CALCulate:DATA:SDATa?')).toBe('CALC:DATA:SDAT');
    expect(normaliseHeader('CALC1:DATA:SDATA?')).toBe('CALC:DATA:SDAT');
    expect(normaliseHeader('SENS:FREQ:STAR 140000000')).toBe('SENS:FREQ:STAR');
    expect(normaliseHeader('CALC:PAR1:DEF S11')).toBe('CALC:PAR:DEF');
    expect(shortForm('FREQUENCY')).toBe('FREQ');
    expect(shortForm('PARAMETER')).toBe('PAR');
    expect(shortForm('DEFINE')).toBe('DEF');
    expect(shortForm('STOP')).toBe('STOP');
    expect(shortForm('AUTO')).toBe('AUTO');
    expect(knows(vocabulary, 'CALC:DATA:SDATA?')).toBe(true);
    expect(knows(vocabulary, 'CALC:SEL:DATA:SDATA?')).toBe(true);
    expect(knows(vocabulary, 'CALC:PAR', { prefix: true })).toBe(false);
    expect(knows(vocabulary, 'INIT', { prefix: true })).toBe(false);
    expect(knows(vocabulary, 'SENS:CORR')).toBe(false);
    expect(knows(vocabulary, 'SENS:CORR', { prefix: true })).toBe(true);
    expect(knows(vocabulary, 'SENS:FREQ:DATA')).toBe(true);
  });

  it('can be asked what it knows, for the next report', async () => {
    const lines = await fieldfox.probe();
    expect(lines.find((l) => l.startsWith('*IDN?'))).toBe('*IDN? => Keysight Technologies,N9914A,MY53104315,A.07.75');
    expect(lines.find((l) => l.startsWith('SYST:VERS?'))).toBe('SYST:VERS? => 1999.0');
    expect(lines.find((l) => l.startsWith('CALC:PAR1:DEF?'))).toMatch(/REFUSED: -113/);
    expect(lines.find((l) => l.startsWith('INIT:CONT?'))).toMatch(/REFUSED: -113,"Undefined header;INIT<Err>"/);
    expect(lines.find((l) => l.startsWith('SENS:CORR:IMP?'))).toBe('SENS:CORR:IMP? => 50');
    expect(lines.find((l) => l.startsWith('SENS:SWE:POIN?'))).toMatch(/=> \d+$/);
    expect(lines.find((l) => l.startsWith('CALC:DATA:SDATA?'))).toMatch(/values\)$/);
    expect(lines.find((l) => l.startsWith('CALC:MEAS1:DEF S11'))).toMatch(/REFUSED/);
    expect(lines.some((l) => l.includes('NO ANSWER'))).toBe(false);
    expect(lines.some((l) => l.includes('could not read the trace twice'))).toBe(false);
  });

  it('a query the firmware does not know is an answer, not a twenty-second silence', async () => {
    // Compound replies: the value and the error share one line; an unknown query leaves only the error.
    expect(splitReply('1;+0,"No error"')).toEqual({ value: '1', error: '+0,"No error"' });
    expect(splitReply('1.0E+08,2.0E+08;0,"No error"')).toEqual({ value: '1.0E+08,2.0E+08', error: '0,"No error"' });
    expect(splitReply('-113,"Undefined header;SENS:CORR:USER?<Err>"')).toEqual({ value: '', error: '-113,"Undefined header;SENS:CORR:USER?<Err>"' });
    expect(splitReply('"NA"')).toEqual({ value: '"NA"', error: '0,"No error"' });
  });
});

describe('the bridge\'s small parsers', () => {
  it('reads SCPI lists, addresses and arguments', () => {
    expect(parseNumbers(' 1.5E+06,2,-3e-1 \n')).toEqual([1.5e6, 2, -0.3]);
    expect(parseNumbers('')).toEqual([]);
    expect(() => parseNumbers('1,abc')).toThrow(/Not a number/);
    expect(parseAddress('192.168.0.50')).toEqual({ host: '192.168.0.50', port: 5025 });
    expect(parseAddress('lab-ff:5026')).toEqual({ host: 'lab-ff', port: 5026 });
    expect(parseAddress('[fe80::1]:5025')).toEqual({ host: 'fe80::1', port: 5025 });
    expect(parseArgs(['--fieldfox', 'a', '--fieldfox', 'b:1', '--port', '9000', '--log'])).toEqual({ fieldfox: ['a', 'b:1'], port: 9000, simulate: false, log: true, probe: false, help: false });
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(validateSweep({ instrument: 'x', parameter: 'S11', startHz: 1e6, stopHz: 2e6, points: 101 })).toBeUndefined();
    expect(validateSweep({ instrument: 'x', parameter: 'S12', startHz: 1e6, stopHz: 2e6, points: 101 })).toMatch(/S11/);
    expect(validateSweep({ instrument: 'x', parameter: 'S11', startHz: 2e6, stopHz: 1e6, points: 101 })).toMatch(/stopHz/);
    expect(splitCommands('INST "NA;SA";*OPC?')).toEqual(['INST "NA;SA"', '*OPC?']);
  });
});
