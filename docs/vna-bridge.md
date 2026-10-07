# The EMWS VNA bridge

A bench or handheld vector network analyser - a Keysight FieldFox, say - speaks SCPI over
a TCP socket, and a web page cannot open one. The bridge is a small program that runs on
the computer the browser is on, talks SCPI to the instrument, and answers plain HTTP on
`127.0.0.1` in the shape EMWS's NanoVNA drivers already produce. Every *Measure it* button
in EMWS then offers the instrument beside a NanoVNA.

Like the solver service, it is optional by construction: not running, and EMWS is exactly
what it was. It lives in `services/emws-vna-bridge/`, is public domain like the rest, and
has no dependencies beyond Node 20 or later.

## Running it

```sh
npm run vna-bridge -- --fieldfox 192.168.0.50          # one FieldFox, SCPI on port 5025
npm run vna-bridge -- --fieldfox lab-ff:5025 --port 8075
npm run vna-bridge -- --simulate                       # a pretend FieldFox, to try the page
```

Then open EMWS. Under the measuring buttons (Smith chart load, balun core, antenna
comparison, filter S21) a line says the bridge was found, and *Connect to FieldFox
(bridge)…* appears. The page looks for the bridge at `http://127.0.0.1:8075`; *Look
elsewhere* on that line points it at another address, remembered in the browser.

The bridge listens on `127.0.0.1` only. A loopback address counts as trustworthy to a
browser, so an `https://` page may call it; Chromium's private-network rule is met by the
`Access-Control-Allow-Private-Network` header the bridge sends on its preflight answer.

## What the instrument needs

- Network-analyser mode. The bridge uses NA mode for S11 and S21, because that is what
  gives complex S-parameters; a unit with only cable-and-antenna mode (an N9912A without
  option 303) is reported as such. `*OPT?` and `INST:CAT?` from a telnet session on port
  5024 tell you what a unit has.
- Its own calibration. The FieldFox corrects its readings on board (QuickCal, CalReady or a
  cal kit); the bridge reports whether correction is on, and the page says so when it is
  not. No correction is done on the EMWS side for a bridged instrument.
- Switching into NA mode resets that mode's settings, calibration included, so the bridge
  switches only when the instrument is not already there.

## Protocol

```
GET  /health
  -> { service: "emws-vna-bridge", version, kinds: ["vna"],
       instruments: [{ id, name, address, status: "ok" | "unreachable",
                       idn?, options?, modes?, error? }] }

POST /sweep   { instrument, parameter: "S11" | "S21", startHz, stopHz, points, ifbwHz? }
  -> { instrument, parameter, frequenciesHz: [...], real: [...], imag: [...],
       corrected: boolean, method: string }
```

Errors come back as `{ error }` with 400 (a bad request), 404 (no such instrument) or
502 (the instrument side failed, with the instrument's own `SYST:ERR?` text where there is
one). One sweep runs at a time per instrument; others queue.

## What it sends the FieldFox

From Keysight's FieldFox programming guide, NA mode:

```
*CLS
INST?                         only switch when not already in NA mode:
INST "NA";*OPC?               a mode switch is overlapped, *OPC? waits for it...
INST?                         ...or does not: asked again until it answers "NA" (10 s)
*CLS
CALC:PAR1:DEF S11             or S21 - the current guide's trace-numbered form;
CALC:PAR1:SEL                 if SYST:ERR? refuses it (-113 on an N9914A, A.07.75):
CALC:PAR:DEF S11              the plain form, remembered for the rest of the session
CALC:PAR:SEL
SENS:FREQ:STAR <Hz>
SENS:FREQ:STOP <Hz>
SENS:SWE:POIN <n>
SENS:BWID <Hz>                only if asked for
FORM ASC,0
SYST:ERR?                     must be 0
INIT:CONT?                    remembered, restored at the end
INIT:CONT 0
INIT:IMM;*OPC?                single sweep, as the guide insists
SENS:FREQ:DATA?               the x axis
CALC:DATA:SDATA?              real,imag pairs; corrected when correction is on
SENS:CORR:USER?               correction state
SENS:CORR:COLL:METH:TYPE?     which calibration
SYST:ERR?
INIT:CONT 1                   if it was sweeping when found
```

Each sweep opens its own connection and closes it after, so a bridge left running holds
no socket on the instrument.

`--log` prints every command and reply; a report with that in it is a report that can be
acted on.

## Standing

Written from the published command reference and tested, end to end, against
`fake-fieldfox.mjs`: a SCPI server that answers as the guide says an N9912A does,
measuring 75 Ω + 0.5 µH on port 1 and a 145 MHz low-pass to port 2, with an error queue
that a wrong command lands in. `tests/vna-bridge.test.ts` drives the real bridge against
it; `npm run smoke -- --vna` does the same through the browser.

**First real instrument, 2026-10-07:** an N9914A on firmware A.07.75 (options 210, 010,
310, 235, 233, 211; modes CPM, SA, NA, CAT). The bridge found and identified it, and the
sweep failed at `CALC:PAR1:DEF` with `-113,"Undefined header;CALC:PAR1:DEF<Err>"` - the
trace-numbered form in the current guide, which that firmware does not have (its mode
list also named one mode twice). The bridge now confirms the mode switch landed by asking
`INST?` again, tries the plain `CALC:PAR:DEF` when the numbered form is refused, and the
fake's `legacy` mode replays that instrument word for word in the tests. The second real
run is what proves the rest of the sequence on that firmware.
