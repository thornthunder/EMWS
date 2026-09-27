export function CoilsGuide() {
  return (
    <>
      <p className="lede">
        Coils, traps and filters are the parts of a station you wind and solder yourself, and the ones most often built
        by folklore. This tool works them out instead: what a coil of so many turns on such a former really is, what a
        coil across a capacitor does when it is cut into an antenna wire, and what a few of each in a row do to a
        transmitter's harmonics. Where the working is only an estimate, it says so, and it takes a measurement instead.
      </p>

      <h2>Five minutes to your first coil</h2>
      <ol className="guide-steps">
        <li>
          Open <a href="#/lc">Coils, traps and filters</a>. The <em>A coil</em> tab shows a coil already: 12 turns of 1 mm
          wire on a 25 mm former, close-wound.
        </li>
        <li>
          Read the card at the top: its inductance, how long the winding is, and how much wire it takes. Change the turns
          or the former and watch it follow.
        </li>
        <li>
          Under <em>Wind it to a value</em>, type <strong>8</strong> µH and press <em>Find the turns</em>. The turns change
          to the nearest half that gives 8 µH on that former and wire.
        </li>
        <li>
          Now look at the Q line. It gives two numbers, and the honest reading of them is in the next section.
        </li>
      </ol>

      <h2>What the coil tab tells you</h2>
      <p>
        <strong>Inductance</strong> is Wheeler's formula for a single-layer coil, good for any shape from a short fat coil
        to a long thin one, and it is what every coil calculator uses underneath. It treats the winding as a sheet of
        current, so a coil of very few turns of thin wire can come out a few percent either way; the tool warns you when
        that applies.
      </p>
      <p>
        <strong>Q</strong> is where coil calculators quietly lie, so this one gives you a range. The upper figure is the
        best the wire can do: its resistance at that frequency with the current crowded into the skin, and nothing else.
        A real coil does worse, because every turn also crowds the current in its neighbours. In a long, close-wound coil
        that multiplies the resistance by about 3.4 (Medhurst measured it in 1947), and that gives the lower figure. Spacing
        the turns by a wire diameter or more recovers most of the difference. Thicker wire on a fatter former raises both
        numbers. If you have measured the coil, type its Q into <em>Measured Q</em> and the trap and filter tabs use that.
      </p>
      <p>
        <strong>Self-resonance</strong> is given as a ceiling, not a value. A coil is also a capacitor, between its own
        turns, and above some frequency it stops being a coil at all. That frequency can be no higher than the one where
        the wire in it is half a wavelength long, which is the figure shown; a short fat coil resonates well below it. Keep
        your working frequency under a third of the ceiling, and if the tool warns you otherwise, measure.
      </p>

      <h3>Measure the coil in your hand</h3>
      <p>
        Under <em>Measure it</em>, sweep the coil on its own: with a NanoVNA plugged in by USB (<em>Connect a NanoVNA…</em>,
        then <em>Measure the coil</em>), or from an <code>.s1p</code> it saved. The tool reads off the inductance and Q nearest
        your frequency and finds where the reactance goes through zero, which is the real self-resonance. <em>Use this Q</em>{' '}
        puts the measured figure where the other two tabs will find it. The live route needs a secure page (https:// or
        localhost) and a desktop Chromium browser; the Smith chart guide has the details, including what a NanoVNA-V2 needs
        first. Measure the coil with short leads, away from metal: what the NanoVNA sees is the coil <em>plus</em> whatever
        it is near.
      </p>

      <h2>A trap for a multiband wire</h2>
      <p>
        A trap is a coil and a capacitor in parallel, cut into an antenna wire. At its own resonance it is a very high
        impedance, so the wire beyond it might as well not be there, and the inner part is a complete antenna on that band.
        On a lower band the trap is just a coil, and the outer wire is still connected, only electrically longer than it
        looks, so the whole thing resonates lower with less wire than a full-size dipole would need. That is the trick a
        trap dipole plays.
      </p>
      <ol className="guide-steps">
        <li>
          On the <em>A trap</em> tab press <strong>40 m</strong>. Start from <em>the coil I have</em>, 8 µH with a Q of
          200, and the tool gives the capacitor: about 63 pF.
        </li>
        <li>
          Read <em>Impedance at resonance</em>: Q times the coil's reactance, around 70 kΩ. That is what isolates the far
          wire. A poor coil, Q 50, gives a quarter of it, and the band you meant to isolate shows it as loss.
        </li>
        <li>
          <em>Wind the coil</em> says how many turns that is on the coil tab's former and wire; <em>Design that coil</em> takes
          you there to check its Q and self-resonance.
        </li>
        <li>
          The table <em>On the other bands</em> says what the trap amounts to elsewhere: on 80 m, a loading coil of so many
          microhenries in the wire; on 20 m, a capacitor. Those are the numbers you need to make sense of the rest of the
          antenna.
        </li>
      </ol>
      <p>
        Two things to know before you build one. The capacitor sees the full voltage across the trap, and on the trap's
        own band that is close to the antenna's end voltage, because the trap sits at a current node. That is far more
        than an ordinary ceramic disc is rated for at transmitting power: use transmitting mica, or a length of coax as
        the capacitor. And a trap's resonance is what you measure, not what you calculated; the
        coil's self-capacitance and the leads move it by a few percent, so build it slightly high and spread turns to bring
        it down, with the NanoVNA on it.
      </p>
      <p>
        What the trap does to a particular antenna, its resonances, its pattern and how much of your power the coil turns
        into heat, is a job for the <a href="#/antenna">Antenna Modeler</a>. Press <em>Put this trap in an antenna</em>: it
        opens the modeller, which offers the trap as a load on the selected wire; put it there, drag it along the wire to
        where the trap goes, and NEC solves the antenna with it in. The coil tab has the same button for a loading coil.
        The <em>Trap dipole, 40 and 80 m</em> example there was built exactly this way, and its efficiency reading is the
        honest cost of the traps.
      </p>

      <h2>A low-pass filter after a transmitter</h2>
      <p>
        A home-built transmitter puts out harmonics, and your licence conditions say how far below the carrier they must
        be: the figure most administrations use on HF follows the ITU's guidance, and yours is in your regulator's rules,
        so look it up. A low-pass filter between the final and the antenna is what gets you there. The classical design method
        is what this tab does: pick a shape, an order and a cutoff, and the parts follow from closed formulas.
      </p>
      <ol className="guide-steps">
        <li>
          On the <em>A filter</em> tab choose <em>Low-pass</em>, <em>Chebyshev</em>, order <strong>7</strong>, 0.1 dB ripple,
          cutoff <strong>32</strong> MHz, for a transmitter that covers everything to 10 m.
        </li>
        <li>
          The parts table lists the ladder from the source end: capacitor, coil, capacitor… with each coil translated into
          turns on the coil tab's former, and each capacitor's nearest E24 value.
        </li>
        <li>
          Read <em>Second harmonic</em> and <em>Third harmonic</em>: how far down the filter puts 64 and 96 MHz. Add the
          transmitter's own harmonic suppression and compare with what your licence requires.
        </li>
        <li>
          Read the passband loss at 25.6 MHz, which is what the coils' Q costs you. Press <em>From the coil tab</em> to use
          the Q of the coil you actually intend to wind, and watch it change.
        </li>
        <li>
          Tick <em>Round the capacitors to E24</em> and see what standard values do to the curve. Usually not much; if it
          is much, a different order or cutoff lands nearer standard values.
        </li>
      </ol>
      <p>
        <strong>Butterworth or Chebyshev?</strong> Butterworth is flat in the passband and gentle beyond it; Chebyshev buys a
        steeper skirt with a small ripple in the passband, and the more ripple you allow the steeper it gets. For a
        transmitter filter a little ripple costs nothing, so Chebyshev is the usual choice. An <em>even</em> order Chebyshev
        wants unequal source and load impedances; the tool warns you, draws the response both ways, and the answer is
        normally to use an odd order.
      </p>
      <p>
        <strong>Which element first?</strong> A low-pass can start with a shunt capacitor or a series coil. Shunt-first uses
        fewer coils, which are the parts that cost Q and effort, and puts a capacitor across the transmitter output, which
        is usually welcome. The response is the same either way.
      </p>

      <h2>A high-pass in front of a receiver</h2>
      <p>
        The same tab, set to <em>High-pass</em>, designs the classic broadcast-band filter: a cutoff around 1.7 MHz keeps
        medium-wave broadcasters out of an HF receiver's front end while letting 160 m through. Read the figures at a half
        and a third of cutoff to see how much rejection the broadcast band gets.
      </p>

      <h2>Working with the other tools</h2>
      <ul>
        <li>
          The <a href="#/smith">Smith chart</a> works in the same coils and capacitors: when it tells you a match needs 1.2 µH,
          the coil tab tells you how to wind it, and what Q to expect.
        </li>
        <li>
          The <a href="#/balun">balun tool</a> is for coils on ferrite. This tab is air-cored only: a ferrite core multiplies
          the inductance and changes with frequency, and belongs there.
        </li>
      </ul>

      <h2>Honest limits</h2>
      <ul>
        <li>
          <strong>Q is an estimate unless you measured it.</strong> The range shown brackets a real coil in free air. A
          shield can, a nearby chassis or a former that is not a good insulator all lower it, and none of that is modelled.
        </li>
        <li>
          <strong>Filters are ideal ladders.</strong> Each part is the value and Q you gave it, and nothing else: no lead
          inductance, no stray capacitance across a coil, no coupling between adjacent coils. Those are what make a built
          filter differ from the curve above 30 MHz or so, and a NanoVNA across the finished filter is how you find out.
        </li>
        <li>
          <strong>Ratings are not worked out.</strong> The tool does not know your power, so it says nothing about the
          voltage a trap capacitor sees or the current a filter coil carries. The trap section above says how to think about
          the first. The Antenna Modeler does show what a trap or coil <em>costs</em>, as efficiency, once it is in a wire.
        </li>
        <li>
          <strong>Not yet here:</strong> band-pass filters, traps made from coax, and multi-layer or toroidal air coils.
        </li>
      </ul>
    </>
  );
}
