# EMWS VNA bridge – installing it and testing it with your FieldFox

Thank you for trying this. The bridge lets EMWS (the web app) measure with your Keysight
FieldFox over the network, the way it already measures with a NanoVNA over USB. It is a
small program that runs on your PC, talks to the FieldFox, and hands the readings to the
web page.

Nobody has run this against a real FieldFox yet. It was written from Keysight's own
programming guide and tested against a pretend instrument that answers the way the guide
says a FieldFox does. Your test is the first real one, so the notes at the end on what to
send back matter as much as the result.

Everything here is public domain, like the rest of EMWS.

## What you need

- A Windows PC on the same network as the FieldFox (a Mac or Linux box works the same;
  only the commands look a little different).
- **Node.js**, version 20 or newer. Free, from <https://nodejs.org> – take the "LTS"
  download, run the installer, accept the defaults. Nothing else gets installed.
- The folder you were sent: `emws-vna-bridge`, with `bridge.mjs`, `fake-fieldfox.mjs`
  and these notes in it. Put it anywhere, for example `C:\emws-vna-bridge`.
- A FieldFox with the **network analyser** mode (option 303 on an N9912A; 210 or 211 on
  the N991xA combination analysers). The bridge measures in NA mode because that is the
  mode that gives true S-parameters. Step 4 shows what your unit has; a unit with only the
  cable-and-antenna mode will be reported as such, and that is a useful result too.
- Chrome or Edge for the web page.

## Step 1 – check Node is installed

Open a PowerShell window (Start menu, type `powershell`) and run

```powershell
node --version
```

You should see something like `v22.11.0`. Anything that starts with v20 or higher is fine.

## Step 2 – try the bridge with the pretend FieldFox first

This proves the bridge and the web page work on your PC before the instrument is
involved. In the same PowerShell window:

```powershell
cd C:\emws-vna-bridge
node bridge.mjs --simulate
```

It prints something like

```
simulated FieldFox on 127.0.0.1:52341 (75 ohm + 0.5 uH on port 1; a 145 MHz low-pass to port 2)
EMWS VNA bridge 1.0.0 at http://127.0.0.1:8075 - Simulated FieldFox (127.0.0.1:52341)
Open EMWS; its "Measure it" buttons offer the instrument. Ctrl+C stops the bridge.
```

Leave that window open – the bridge runs for as long as it is open.

Now open EMWS in Chrome or Edge, go to the **Smith Chart**, and look under *The load*.
Where it offers to measure, there should now be a button **Connect to Simulated FieldFox
(bridge)…** and a line saying *EMWS VNA bridge found at http://127.0.0.1:8075*.

- If the line says *No EMWS VNA bridge at http://127.0.0.1:8075* instead, the page is
  looking and not finding it: check the bridge window is still open and shows no error.
- If the browser asks whether the site may connect to devices on your local network,
  allow it. That is the browser asking on the bridge's behalf.
- If there is no such line at all, the EMWS you are looking at is older than the bridge.
  Ask for the address of the current one.

Press **Connect to Simulated FieldFox (bridge)…**, then **Measure the load**. The chart
should take a load of about **75 Ω** with a little inductive reactance, named *Simulated
FieldFox (N9912A)*. That is the pretend instrument's 75 Ω resistor and coil, and it means
the whole chain works. Press Ctrl+C in the PowerShell window to stop the bridge.

## Step 3 – put the FieldFox on the network

Give the FieldFox an address on your network, either from your router (DHCP) or a fixed
one, and read the address off the instrument: it is in the System settings under the LAN
or network entry (the FieldFox user's guide has the exact screen for your model). Write
it down – say `192.168.0.50`.

From the PC, check it can be reached. In PowerShell:

```powershell
Test-NetConnection 192.168.0.50 -Port 5025
```

The last lines should say `TcpTestSucceeded : True`. Port 5025 is the one the FieldFox
takes commands on. If it says False, the PC and the FieldFox are not on the same network,
or something between them is blocking it – the bridge cannot help until that says True.

## Step 4 – run the bridge against the FieldFox

```powershell
cd C:\emws-vna-bridge
node bridge.mjs --fieldfox 192.168.0.50 --log
```

(with your instrument's address). It prints the bridge's address as before, and
`FieldFox (192.168.0.50:5025)`. The `--log` makes it print every command it sends the
FieldFox and every answer it gets back, which is the most useful thing to send with a
report; leave it off for everyday use.

Now the most useful single check: in the browser, open

```
http://127.0.0.1:8075/health
```

That asks the bridge to ask the FieldFox who it is. You should see a page of text with
your instrument's identification in it, for example

```
"idn":"Keysight Technologies,N9912A,MY12345678,A.12.95"
"options":"104,110,303"
"modes":["CAT","NA","SA"]
"status":"ok"
```

**Please copy that whole page into your report** – the options and the modes are what
decide whether the rest can work. If it says `"status":"unreachable"`, the text after
`"error"` says why, and that goes in the report too.

## Step 5 – measure

On the FieldFox, calibrate as you normally would for the measurement – QuickCal, CalReady
or a cal kit, at the end of the cable you will measure through. The bridge hands on the
instrument's own corrected readings; it does nothing to them, and the page will say so if
the instrument reports that its correction is switched off.

Put something known on port 1 – a 50 Ω load, a 75 Ω load, a dummy load, an antenna – and
in EMWS, on the Smith Chart, press **Connect to FieldFox (bridge)…** and then **Measure
the load**. The sweep range and the number of points are the fields just above the
button; the page starts with the frequencies the tool is set to.

What to look for:

- The load that lands on the chart is what you put on the port. A 50 Ω load should sit at
  the centre; a 75 Ω load at 75 Ω.
- The PowerShell window prints one line per sweep, such as
  `sweep S11 14000000-14350000 Hz, 201 points on FieldFox`.
- If the page shows an error, it is worded as the FieldFox reported it – for example
  *the FieldFox says -222,"Data out of range"*. Copy it exactly, together with the lines
  the PowerShell window printed just before it (`--log` above): those show which command
  the instrument objected to.
- Older firmware does not have every command the current manuals list. An N9914A on
  firmware A.07.75 taught the bridge that it cannot choose S11 on such a unit at all, so
  on one of those the bridge sweeps **whatever trace the instrument is showing** and the
  page says so in orange. Put S11 on trace 1 on the instrument's own screen before you
  measure (and S21 for a through measurement), and the sweep is yours.

## Step 6 – if it still will not measure: ask the instrument what it knows

Run the bridge once more with `--probe` instead of `--log`:

```powershell
node bridge.mjs --fieldfox 192.168.0.50 --probe
```

It does not start the bridge. It asks the FieldFox about sixty harmless questions – which
commands it knows, what its sweep is set to, whether it can read a trace – changes nothing,
prints the answers, writes them to a file called `probe-fieldfox-1-<date>.txt` in the same
folder, and stops. **That file is the report.** It tells us the firmware's own vocabulary,
which is what the fix has to be written in.

Then, if you have two cables and something to measure through – a filter, an attenuator
– go to **Coils & Filters → Stubs & cavities**, open *Measure the filter you built*, and
measure S21 through the bridge the same way.

## When you are done

Ctrl+C in the PowerShell window stops the bridge. It holds nothing on the FieldFox between
sweeps – each sweep opens its own connection and closes it – so the instrument is free to
use normally the moment you stop. The bridge only ever listens on your own PC
(`127.0.0.1`); nothing on the network can reach it.

## If something goes wrong

| What you see | What it usually means |
|---|---|
| `node` is not recognised | Node.js is not installed, or PowerShell was open before it was installed – open a new window. |
| *No EMWS VNA bridge at http://127.0.0.1:8075* under the measure button | The bridge is not running, or it is running on another port (`--port`). *Look elsewhere* on that line lets you type the address it printed. |
| `Test-NetConnection` says False | Wrong address, different network, or the FieldFox's LAN is off. The bridge cannot do anything until this is True. |
| `/health` shows `"status":"unreachable"` | The bridge could not connect on port 5025; the `error` text says more. |
| `/health` shows modes without `NA` | The instrument has no network-analyser option. The bridge cannot measure with it as it stands – that is a result worth reporting. |
| *the FieldFox says …* | The instrument refused a command. Copy the text exactly; it tells us which command and why. Then run step 6. |
| An orange note that the bridge could not choose S11 | Your firmware has no command for it. Select S11 (or S21) on the instrument itself and measure again; the readings are what the screen shows. |
| The reading is wrong in a way you can describe | Say what was on the port, what the FieldFox's own screen showed, and what EMWS showed. |

## What to send back

1. The whole text of `http://127.0.0.1:8075/health`.
2. What was on the port, and what the FieldFox's own screen showed for it.
3. What EMWS showed – a screenshot of the Smith chart after *Measure the load* is ideal.
4. Any error text, copied exactly, and the lines the PowerShell window printed – with
   `--log`, that is the whole conversation with the instrument, which is ideal.
5. Your firmware version, which is the last part of the `idn` line.
6. If measuring failed, the `probe-…txt` file from step 6.

That is enough to fix anything that needs fixing. Thanks again – 73.
