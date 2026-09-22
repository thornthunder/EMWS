export function BalunGuide() {
  return (
    <>
      <p className="lede">
        The balun tool lets you choose a ferrite core, wind it turn by turn, and see what it will do — the match,
        the loss, and how hot it gets — before you cut any wire. It will also tell you plainly which of its answers
        you can lean on and which are educated guesses.
      </p>

      <h2>Five minutes to your first transformer</h2>
      <p>
        The tool opens on the 49:1 that feeds an end-fed half-wave: an FT240-43 with two turns, a tap, five more,
        across to the far side of the core, and seven more. Fourteen turns in all with the radio on the second, so
        the turns ratio is 1:7 and the impedance ratio is its square, 49:1.
      </p>
      <ol>
        <li>
          Look at the <strong>band buttons</strong> above the readout. Press <em>80 m</em>, then <em>10 m</em>, and
          watch the loss and the heat change. That is the whole story of this transformer in two clicks.
        </li>
        <li>
          In the <strong>Core</strong> grid, click the FT240 under a different mix — or drag it onto the pad. The
          same winding, a different ferrite.
        </li>
        <li>
          Set <strong>Compare with</strong> to a second mix. Every chart now draws both, solid and dashed, and the
          band table shows the second in brackets. This is the quickest way to settle a #43-or-#52 argument.
        </li>
        <li>
          On the pad, <strong>drag the orange dot</strong> round the core to wind or unwind turns, and watch the
          numbers follow.
        </li>
      </ol>

      <h2>What you can build</h2>
      <table className="key-table">
        <caption>The three kinds</caption>
        <tbody>
          <tr>
            <th scope="row">Tapped</th>
            <td>
              One winding with a tap part-way along: the radio across the bottom few turns, the antenna across all
              of them. Strictly an <em>autotransformer</em>, and strictly a <em>unun</em> — both sides are
              unbalanced. This is the 49:1 and 64:1 for end-fed wires and the 9:1 for random wires.
            </td>
          </tr>
          <tr>
            <th scope="row">1:1 current</th>
            <td>
              A transmission line — coax, or a pair of wires — wound on a core. The signal travels <em>inside</em>{' '}
              the line and hardly notices the core; what the core does is refuse to let current flow along the
              outside. This is the common-mode choke, and the <strong>Guanella 1:1</strong> balun.
            </td>
          </tr>
          <tr>
            <th scope="row">1:4 Guanella</th>
            <td>
              Two such lines, connected in parallel at the radio and in series at the load, so the voltages add:
              50 Ω becomes 200 Ω. Named for Gustav Guanella, who described it in 1944.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Winding on the pad</h2>
      <p>
        The pad shows the core from above. Windings start at the bottom left and go clockwise. The colours are the
        two stretches of a tapped winding: the turns the radio is across, and the rest.
      </p>
      <ul>
        <li>
          <strong>Drag the dot</strong> at the free end of the wire round the ring. It winds when you go forwards
          and unwinds when you go back — but never back past a tap or a crossover, because those are decisions,
          and overshooting with the mouse should not undo one.
        </li>
        <li>
          <strong>Drop a core</strong> from the list onto the pad to change it. Drop the <em>same</em> one again
          and it stacks: two cores side by side behave as one twice as tall, with twice the inductance per turn.
        </li>
        <li>
          The caption counts your turns against how many the core will take in a single layer. The tool will not
          analyse a winding that cannot be wound.
        </li>
      </ul>
      <p>
        Everything the pad does, the <strong>Winding</strong> list beside it does too: <em>+ Wind</em>,{' '}
        <em>+ Tap</em>, <em>+ Cross over</em>, and a number box on every stretch. Use whichever you like — on a
        phone or a keyboard the list is the easier one. <em>Undo</em> and <em>Redo</em> cover both.
      </p>
      <h3>Why cross over?</h3>
      <p>
        Wind all the way round a core and the first and last turns end up next to each other, with the whole
        output voltage between them. That is capacitance straight across the winding, and it hurts at the top of
        the HF range. Crossing over — winding half, passing through the middle, and winding the other half up the
        far side — puts the two ends at opposite corners. It also puts your two connectors at opposite ends of the
        box, which is reason enough for many people.
      </p>
      <p>
        The tool only charges you for that capacitance when the winding really does go most of the way round. On a
        big core with a few turns the ends never meet, and crossing over changes nothing — which is what the
        numbers will show.
      </p>

      <h2>Reading the results</h2>
      <table className="key-table">
        <caption>What the figures mean</caption>
        <tbody>
          <tr>
            <th scope="row">Radio sees, SWR</th>
            <td>The impedance at the input, and the SWR against your radio's impedance.</td>
          </tr>
          <tr>
            <th scope="row">Lost inside</th>
            <td>
              Of the power that gets into the transformer, how much never comes out. 1 dB is a fifth of your power;
              0.5 dB is a tenth. It does not include what the mismatch reflects — the SWR tells you that.
            </td>
          </tr>
          <tr>
            <th scope="row">Heat in the core</th>
            <td>
              Watts turned to heat in the ferrite at the power you entered. This, not the loss in decibels, is what
              cracks cores and melts enclosures.
            </td>
          </tr>
          <tr>
            <th scope="row">Core warms by</th>
            <td>
              A rough steady temperature rise in still air, from a long-standing rule of thumb. It uses the{' '}
              <em>How much of the time</em> setting: FT8 and RTTY are key-down the whole time and will cook a
              transformer that SSB never troubles.
            </td>
          </tr>
          <tr>
            <th scope="row">Flux density</th>
            <td>
              How hard the core is being driven, against the point where ferrite saturates. At HF you will nearly
              always run out of cooling long before you run out of flux.
            </td>
          </tr>
          <tr>
            <th scope="row">Across the radio</th>
            <td>
              For a tapped winding: the impedance of the input turns, which sits straight across your radio. The
              old advice is to make it at least four or five times the radio's impedance. When it is only twice,
              a lot of current flows through a lossy core — see below.
            </td>
          </tr>
          <tr>
            <th scope="row">Chokes with</th>
            <td>
              For a current balun: the impedance it puts in the way of current on the <em>outside</em> of the
              line. This is its whole job. Bigger is better, and a <em>resistive</em> choke is better than a
              reactive one, because a reactance can be cancelled by the feedline it is attached to and a
              resistance cannot.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Worked example: two turns or three?</h2>
      <p>
        Open the tool fresh and press <em>80 m</em>. The 2 : 14 winding on an FT240-43 loses about a decibel, and
        at 100 W key-down something like 20 W of that is heat in the core. The reason is in <em>Across the
        radio</em>: two turns give only about twice the radio's impedance at 3.6 MHz, so a large share of the
        input current goes round the core instead of on to the antenna, and #43 is lossy down there.
      </p>
      <p>
        Now change the winding to <strong>3</strong>, tap, <strong>8</strong>, cross over, <strong>10</strong>.
        Still 49:1 — 3 : 21 — but three turns have nine-quarters the inductance of two. The loss on 80 m roughly
        halves and so does the heat. That is why three-turn primaries are the usual advice for 80 m.
      </p>
      <p>
        Then press <em>10 m</em>. The longer winding still loses less, but its <em>match</em> is now the worse of
        the two: more wire means more leakage and more capacitance, and those are what count at the top of the
        range. There is no free lunch in a 49:1, and the tool's job is to show you the trade rather than hide it.
      </p>

      <h2>What to trust, and what to measure</h2>
      <p>
        <strong>On firm ground:</strong> everything that comes from the core. What a turn is worth follows exactly
        from the core's three dimensions — EMWS calculates it rather than looking it up, and shows you the
        A<sub>L</sub> it got so you can hold it against a datasheet. Loss, heat and magnetising impedance all come
        from the ferrite's permeability. This is what decides the <em>bottom</em> of the range: how many turns,
        which mix, how hot on 80 m.
      </p>
      <p>
        <strong>Educated guesses:</strong> the <em>Strays</em> — leakage inductance and the capacitance of the
        winding. They depend on how tightly you wind and how you dress the leads, and the tool can only estimate
        them from geometry. They decide the <em>top</em> of the range. If the tool and your NanoVNA disagree about
        10 m, the strays are why, and you can type measured values over the estimates:
      </p>
      <ul>
        <li>
          <strong>Leakage inductance:</strong> short the output with the shortest link you can, and measure the
          inductance at the input around 1 MHz.
        </li>
        <li>
          <strong>Winding capacitance:</strong> measure where the whole winding self-resonates, take its
          inductance from well below that, and C = 1 / ((2πf)² L).
        </li>
        <li>
          <strong>Line impedance</strong> of a wire pair: a NanoVNA and a known length will give it to you. For a
          1:4 Guanella from 50 Ω it should be 100 Ω, and it matters.
        </li>
      </ul>
      <p>
        <strong>The built-in ferrite mixes are estimates too.</strong> EMWS does not copy manufacturers' curves —
        it would not be public domain if it did. Each mix is described by its initial permeability and family, and
        how that changes with frequency is worked out from Snoek's law. It is a first approximation: good for
        seeing which way a change pushes things, not for the last half-decibel. The permeability chart at the
        bottom shows exactly what is being assumed.
      </p>
      <p>
        <strong>One thing the estimate cannot do is rank two mixes of the same family on loss.</strong> Describing
        a ferrite by two numbers makes its loss look like a fixed resistance across the radio, and Snoek's law
        makes that resistance the same for every nickel-zinc mix. So #43, #52 and #61 come out with the same
        loss and differ only in how much reactance they offer. In reality the low-permeability mixes lose a good
        deal less low down. Comparing built-in mixes tells you truthfully about the <em>match</em>; for the{' '}
        <em>loss</em> you need to measure the cores, and the tool says so when you try.
      </p>

      <h2>Measure the core in your hand</h2>
      <p>
        This is the accurate way, and it is better than any datasheet, because ferrite varies by a fifth or so
        from batch to batch and the core on your bench is the one you are going to use.
      </p>
      <ol>
        <li>Choose the core's size in the grid, so the tool knows its shape.</li>
        <li>
          Wind <strong>a few turns</strong> on it — five to ten on a big core, spread out, short leads. Few turns
          keeps the winding's own resonance out of the way.
        </li>
        <li>Sweep it with a NanoVNA across the range you care about, and save the <code>.s1p</code>.</li>
        <li>
          Open <em>Measure the core in your hand</em>, enter the turns, give it a name, and open the file.
        </li>
      </ol>
      <p>
        The impedance you measured <em>is</em> the permeability, scaled by the shape and the turns: the resistance
        is the loss and the reactance is the inductance. Your core appears in the grid under a ★ and the whole
        tool now runs on it. If the winding resonated inside your sweep the tool says so, and how far up to trust
        the curve.
      </p>
      <p className="muted">
        One thing that looks like a fault and is not: the reactance of a winding on #43 peaks and then{' '}
        <em>falls</em> in the low megahertz. That is the ferrite running out of permeability, which it does all by
        itself. A winding has only hit its own resonance when the reactance goes <em>negative</em>.
      </p>

      <h2>Working with the other tools</h2>
      <p>
        Model your antenna in the <a href="#/antenna">Antenna Modeler</a> — an end-fed half-wave, a few thousand
        ohms — then come here and press <em>Use … as the load</em>. The transformer is now feeding your real
        antenna across the band rather than a tidy resistor.
      </p>
      <p>
        <em>Send what the radio sees to the Smith chart</em> passes the input impedance on, so you can add the
        coax, or see what a tuner would have to do.
      </p>

      <h2>The 1:4 Guanella trap</h2>
      <p>
        A 1:4 Guanella is properly built on <strong>two cores</strong>, one per line. It can be wound on one —
        but only into a load that floats, such as a balanced antenna. If one side of the load is earthed, the two
        windings need different voltages along them, and a single core cannot give two windings different volts
        per turn. The tool refuses that combination and says why. With two cores it works either way, though into
        an earthed load one core does all the work and the other merely keeps the delays equal.
      </p>

      <h2>Honest limits</h2>
      <ul>
        <li>
          <strong>Nothing here has been checked against a bench yet.</strong> The engine is held to conservation
          of energy and to exact limiting cases, so its arithmetic is sound; whether the ferrite and the strays
          match your transformer is something only a measurement can say. Compare, and trust your VNA.
        </li>
        <li>
          Core loss is worked out from <em>small-signal</em> permeability. Driven hard, ferrite loses more than
          that, so at high flux density the real heat is higher than shown.
        </li>
        <li>
          The baluns are assumed ideal in one respect: a 1:1 current balun is shown with no heat in its core,
          which is true into a balanced load. How much common-mode voltage your installation puts across it is
          something no tool can know.
        </li>
        <li>The exact position of each turn is drawn for the eye. The analysis uses the count, the taps, the crossover and the fit.</li>
        <li>
          The temperature figure is a rule of thumb for a bare core in still air. In a sealed box in the sun it
          will be hotter.
        </li>
      </ul>
    </>
  );
}
