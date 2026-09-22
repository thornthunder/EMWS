export function AntennaModelerGuide() {
  return (
    <>
      <p className="lede">
        The Antenna Modeler works out what a wire antenna will do before you climb the mast: its feed
        impedance, SWR, gain and radiation pattern. It runs NEC-2, the same solver behind EZNEC, 4nec2 and
        MMANA, right inside your browser.
      </p>

      <h2>Five minutes to your first model</h2>
      <ol className="guide-steps">
        <li>
          Open the <a href="#/antenna">Antenna Modeler</a> and pick <em>Dipole, 20 m, free space</em> from the
          Examples list.
        </li>
        <li>
          Look at the four views. The wire runs along the Y axis, so you see it full length from above (Top)
          and end-on as a dot from the front.
        </li>
        <li>
          Read the cards below the views: about 72 Ω, an SWR near 1.4, and 2.14 dBi of gain. That is a
          half-wave dipole behaving exactly as the textbooks say.
        </li>
        <li>
          Now drag one end of the wire in the Top view. Everything re-solves in a fraction of a second, and you
          can watch the impedance run away from 50 Ω as the antenna stops being resonant.
        </li>
        <li>
          Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> to put it back.
        </li>
      </ol>

      <h2>The four views</h2>
      <p>
        The three flat views are laid out in <strong>first-angle projection</strong>, the ISO and SANS drawing
        convention: the view from the left is drawn to the <em>right</em> of the front view, and the view from
        above is drawn <em>below</em> it. All three share one scale and centre, so heights line up across a
        row and left-right positions line up down a column, just like a drawing board. The fourth panel is a
        3-D view you can drag to turn.
      </p>
      <table className="key-table">
        <caption>Which way is which</caption>
        <thead>
          <tr>
            <th scope="col">View</th>
            <th scope="col">You are looking</th>
            <th scope="col">Across</th>
            <th scope="col">Up</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Front</td>
            <td>along +Y</td>
            <td>X</td>
            <td>Z</td>
          </tr>
          <tr>
            <td>Left</td>
            <td>along +X, from the left</td>
            <td>Y (pointing left)</td>
            <td>Z</td>
          </tr>
          <tr>
            <td>Top</td>
            <td>straight down</td>
            <td>X</td>
            <td>Y</td>
          </tr>
        </tbody>
      </table>
      <p>
        <strong>Z is height</strong> and Z = 0 is the ground, so a dipole 10 m up has both ends at Z = 10.
        Everything is in metres. A wire pointing at you in a particular view is drawn as a dot; that is normal,
        and you can still drag the dot to move the whole wire.
      </p>

      <h2>Drawing and changing wires</h2>
      <ul>
        <li>
          <strong>Draw:</strong> press <em>Draw wires</em>, click where the wire starts, click where it ends.
          It keeps going from there, so you can walk round a loop in a few clicks. <kbd>Esc</kbd> stops.
        </li>
        <li>
          <strong>Move:</strong> drag a wire to move all of it, or drag the small circle at either end to move
          just that end.
        </li>
        <li>
          <strong>Joins:</strong> wire ends that sit on the same point are electrically joined, and they move
          together, so an inverted V keeps its apex when you drag it. Hold <kbd>Shift</kbd> while you drag to
          break a join.
        </li>
        <li>
          <strong>Snapping:</strong> points snap to the grid, and to other wire ends when you get close, which
          is how you make a solid join. Hold <kbd>Alt</kbd> to place something exactly where the pointer is.
        </li>
        <li>
          <strong>Right-click a wire</strong> to feed it, split it, duplicate it or delete it. Right-click
          empty space to start a new wire there.
        </li>
        <li>
          <strong>Exact numbers:</strong> select a wire and type its end coordinates, diameter and segment
          count in the panel on the left. That is usually easier than dragging for a final dimension.
        </li>
      </ul>

      <h2>Feed points</h2>
      <p>
        An antenna does nothing until something drives it. Right-click a wire and choose <em>Feed here</em>, or
        select the wire and press <em>Feed at centre</em>. The feed is the orange ring; drag it along the wire
        to move it.
      </p>

      <h3>Putting the feed at an exact spot</h3>
      <p>
        Dragging is fine for a centre feed, but an off-centre-fed dipole is specified as a distance, not a
        gesture. Under <em>Feed points</em> each feed has two boxes: <strong>From end 1</strong> in metres, and{' '}
        <strong>Along the wire</strong> as a percentage. Type either one and the feed goes there. End 1 is the
        end you drew first — it is the one whose coordinates appear first in the wire's properties.
      </p>
      <p>
        NEC-2 can only drive the <em>middle of a segment</em>, so the positions actually available are the
        segment centres and nothing in between. If what you asked for falls between two of them, EMWS says how
        far off it landed and offers a segment count that gets closer — one click, and the feed sits where you
        wanted it.
      </p>
      <p>
        This is also why a centre-fed dipole wants an <strong>odd</strong> number of segments: with an even
        count there is no segment in the middle, and the feed ends up half a segment off. Auto-segment always
        picks odd numbers for that reason.
      </p>
      <p>
        The <em>Off-centre-fed dipole (Windom)</em> example shows the idea: 41.1 m of wire fed 13.79 m from one
        end, about a third along. That is 131 − j24 Ω on 40 m, which is hopeless on 50 Ω coax but a comfortable
        1.6:1 through a 4:1 balun — the whole reason the design exists. Try it on 10.1 or 21.2 MHz to see the
        bands where an OCF gives up: the feed lands on a current minimum and the impedance runs to thousands of
        ohms.
      </p>
      <h3>Baluns, ununs and anything else between the wire and the radio</h3>
      <p>
        <strong>NEC-2 models the antenna, and nothing bolted to it.</strong> It reports the impedance at the
        feed point itself — no balun, no coax, no tuner. The Windom example above is fed straight from the
        source; its 4:1 balun exists in the description, not in the calculation.
      </p>
      <p>
        The honest way to account for one is the <em>reference impedance</em> box beside the SWR. A 4:1 balun
        makes the radio see a quarter of the antenna's impedance, so asking for SWR against 4 × 50 = 200 Ω
        gives exactly the figure the radio sees. That is why the Windom example loads with 200 Ω already set,
        and reads 1.6:1 rather than the 2.7:1 the bare antenna gives on 50 Ω. Put it back to 50 and you see the
        antenna alone.
      </p>
      <p>
        For anything more involved — a balun <em>and</em> a length of coax, or a matching network — send the
        impedance to the <a href="#/smith">Smith chart</a> with the button under the results. It has a
        transformer component, so you can build the real chain piece by piece. Both it and the reference-impedance
        trick assume an <strong>ideal, lossless</strong> transformer; a real 4:1 current balun costs you a
        little, and will not hold exactly 4:1 on every band an OCF is used on.
      </p>
      <p>
        You can add several feed points, each with its own voltage and phase, which is how you model a phased
        array. With more than one feed, a table appears under the results showing what each one sees.
      </p>

      <h2>Frequency, ground and segments</h2>
      <h3>Frequency</h3>
      <p>
        Either a single frequency, or a sweep. The band list sets a sweep across an amateur band in one click
        (IARU Region 1 edges — check your own licence conditions). A sweep gives you the SWR curve, and
        clicking any point on that curve shows the full results at that frequency.
      </p>
      <p>
        <strong>Points</strong> is how many frequencies to solve, and there is no meaningful ceiling: NEC-2
        does not care, so neither does EMWS. What a long sweep costs is time and memory, and both are checked
        before you run. Every point is a complete solve, so the time is the single-frequency time multiplied by
        the point count — a small antenna will take thousands of points without noticing, while a 2000-segment
        model at a few hundred is a coffee break. Memory matters too: each frequency keeps a current reading
        for every segment, so it is <em>segments × points</em> that fills the browser, and EMWS says so in the
        design checks before it happens rather than losing your model to a crash.
      </p>
      <h3>Ground</h3>
      <p>
        <em>Free space</em> is the honest choice for comparing designs. <em>Perfect ground</em> is a useful
        idealisation for a ground-mounted vertical. <em>Real ground</em> uses the Sommerfeld-Norton method,
        which is the accurate one; average ground is about εr 13 and 0.005 S/m. Ground changes everything about
        the elevation pattern, so model it before you believe a gain figure.
      </p>
      <h3>Segments</h3>
      <p>
        NEC-2 chops each wire into segments and solves for the current in each one. The <em>Auto-segment</em>{' '}
        button applies the usual rule of thumb: about twenty segments per wavelength, and an odd number per wire
        so there is a segment in the middle to feed. If you are unsure, use it.
      </p>
      <p>
        <strong>More is not better, and it is much slower.</strong> NEC-2 builds a table of how every segment
        affects every other one and then solves it, so the work grows with the <em>cube</em> of the segment
        count: double the segments and you wait eight times as long — for each frequency in a sweep. A 40 m wire
        swept at 30 frequencies, on one core, takes about a third of a second at 81 segments, ten seconds at
        600, and over four minutes at 2000. Past the λ/20 rule the answer barely moves, so the wait buys
        nothing.
      </p>
      <p>
        EMWS warns you before a long run and puts the estimate on the Run button, and it stops auto-run from
        firing while a model is that heavy. If a solve is running you can always press Cancel; it stops there
        and then.
      </p>
      <p>
        A <strong>sweep is shared out across your processor's cores</strong>, because each frequency is a
        separate calculation. You will see it counting the frequencies off as they come in. On a four-core
        laptop that makes a sweep roughly two and a half to three times quicker; the answers are identical
        either way, which the test suite checks frequency by frequency.
      </p>
      <p>
        EMWS also carries two builds of the engine and quietly picks the quicker one your browser can run —
        worth about a third on a large model. Browsers from 2021 onwards get it (2023 on Apple devices); older
        ones get the other build and exactly the same answers, just less quickly. There is nothing to choose or
        switch on.
      </p>
      <p>
        The exception worth knowing: at frequencies where the feed lands on a current minimum — a wire that is a
        full wavelength or more — the impedance is thousands of ohms and genuinely sensitive to segmentation.
        There it is worth stepping the segment count up and watching whether the answer settles. Everywhere else
        it will not change.
      </p>

      <h2>Where the solving happens</h2>
      <p>
        By default your models are solved <strong>in this browser</strong>, by the same NEC-2 engine compiled to
        WebAssembly. Nothing leaves your machine, and it works offline. For most antennas that is the right
        answer and you can ignore this section entirely.
      </p>
      <p>
        A big model is a different matter. Because the work grows with the cube of the segment count, a heavy
        sweep can tie a laptop up for minutes. The <em>Solve with</em> box lets you hand that work to a NEC
        service instead:
      </p>
      <table className="key-table">
        <caption>The three choices</caption>
        <tbody>
          <tr>
            <th scope="row">This browser</th>
            <td>
              The default. Sweeps are shared across your cores; nothing is sent anywhere. Choose this if you are
              not sure.
            </td>
          </tr>
          <tr>
            <th scope="row">This site's solver</th>
            <td>
              Only appears to work if whoever runs this site has set one up. The page asks the web server, and
              the server passes the model on to a NEC service on its own network — which may be a much larger
              machine than yours. Your browser never sees that machine's address.
            </td>
          </tr>
          <tr>
            <th scope="row">A solver on this machine</th>
            <td>
              A NEC service you are running yourself, at an address like{' '}
              <code>http://127.0.0.1:8073</code>. Only <code>localhost</code> and <code>127.0.0.1</code> are
              accepted here; anything further afield has to go through the site's own solver. That rule is
              deliberate — it means a page can never be talked into posting your antenna to a stranger's server.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Whichever you pick is remembered in this browser. When you choose a service, EMWS asks it what it is and
        shows the answer — engine, version, whether it works in single or double precision, and which machine it
        is on. Read that line: <strong>a single-precision solver will not give quite the same numbers</strong> as
        the one in your browser, and it is polite of the service to admit it. A service can host more than one
        kind of engine, so if the one you have named cannot do NEC-2 at all, it says so at once rather than
        letting you wait for a failure.
      </p>
      <p>
        If the service stops answering mid-session, the run does not fail: EMWS solves it here instead and says
        so above the Run button. And whatever solves your model, only nec2c's own report comes back — EMWS reads
        it on this side, exactly as it reads a local run — so a remote solver cannot quietly change what a result
        means.
      </p>
      <p className="muted">
        Sending a model to a service means sending the geometry of your antenna to whoever runs it. On a home
        network that is nobody but you. On someone else's site, treat it as you would any upload.
      </p>

      <h2>Reading the results</h2>
      <table className="key-table">
        <caption>What the cards mean</caption>
        <tbody>
          <tr>
            <th scope="row">Feed impedance</th>
            <td>
              What the antenna looks like to your coax, in ohms: resistance plus reactance. A positive
              reactance means it is too long (inductive) at that frequency, negative means too short.
              Resonance is where the reactance passes through zero.
            </td>
          </tr>
          <tr>
            <th scope="row">SWR</th>
            <td>
              Standing wave ratio against the reference impedance in the box (50 Ω by default; change it to 75
              for TV coax or 450 for window line). Return loss is the same information in decibels.
            </td>
          </tr>
          <tr>
            <th scope="row">Peak gain</th>
            <td>
              In dBi: decibels over an isotropic radiator. A half-wave dipole in free space is 2.14 dBi. If you
              are used to dBd, subtract 2.14. The direction of the peak is given as azimuth and elevation.
            </td>
          </tr>
          <tr>
            <th scope="row">Front / back</th>
            <td>How much less it radiates behind the main lobe. A figure for beams; a dipole shows 0 dB.</td>
          </tr>
          <tr>
            <th scope="row">Efficiency</th>
            <td>
              Conductor loss only. It reads 100 % unless you give the wires a resistance, and it never includes
              ground loss, so do not read it as system efficiency.
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        The two polar plots are cuts through the pattern: one horizontal (azimuth) and one vertical
        (elevation), both taken through the direction of strongest radiation. The rings are the ARRL
        log-periodic scale used in the ARRL Antenna Book, where the outer ring is the peak and each ring in is
        a few decibels down; it keeps the main lobe readable while still showing small side lobes.
      </p>

      <h2>Compare with the real antenna</h2>
      <p>
        A model is a claim about a piece of wire. The way to find out how good a claim is to build the antenna,
        measure it, and hold the two side by side — which is what the <em>Compare with the real antenna</em>{' '}
        panel under the results is for. Give it a measurement, from a NanoVNA plugged in by USB (
        <em>Connect a NanoVNA…</em>, then <em>Measure the antenna</em>) or from a <code>.s1p</code> it saved,
        and:
      </p>
      <ul>
        <li>
          the measured SWR is drawn over the modelled curve, dashed, so a shifted resonance or a mismatch the
          model did not predict is visible at a glance;
        </li>
        <li>
          at whichever frequency you are looking at, the modelled and measured impedance and SWR are put in a
          table, one above the other.
        </li>
      </ul>
      <p>
        Where they part company is where the model is wrong, and the usual suspects are worth knowing. Insulated
        wire is electrically a few percent longer than bare, which the model does not know unless you shorten
        it. Real ground is rarely as kind as "average". And a measurement taken at the shack end of the coax is
        of the antenna <em>plus</em> the coax, which the model never saw — measure at the feed point, or send the
        model's impedance to the Smith chart and add the coax there before comparing.
      </p>
      <p>
        The live route needs a secure page (https:// or localhost) and a desktop Chromium browser; the Smith
        chart guide explains, and what a NanoVNA-V2 needs before it will measure anything.
      </p>

      <h2>The design checks</h2>
      <p>
        Warnings appear under the views as you work. They are NEC-2's rules, not opinions: ignore them and the
        numbers may be confidently wrong.
      </p>
      <table className="key-table">
        <tbody>
          <tr>
            <th scope="row">Segments too long</th>
            <td>Over about a tenth of a wavelength. Add segments, or press Auto-segment.</td>
          </tr>
          <tr>
            <th scope="row">Segments short against the radius</th>
            <td>
              Fat wire, short segments: NEC-2's thin-wire approximation breaks down. Use fewer segments or
              thinner wire.
            </td>
          </tr>
          <tr>
            <th scope="row">Ends almost meet</th>
            <td>
              Two ends within a whisker of each other are <em>not</em> joined. Drag one onto the other so they
              snap together.
            </td>
          </tr>
          <tr>
            <th scope="row">A wire ends part-way along another</th>
            <td>
              NEC-2 only joins wires at their ends. Right-click the wire being touched and choose{' '}
              <em>Split wire here</em>: then both ends meet at a shared point and the junction is real.
            </td>
          </tr>
          <tr>
            <th scope="row">Wires cross</th>
            <td>Two wires passing through each other is not something NEC-2 can solve meaningfully.</td>
          </tr>
          <tr>
            <th scope="row">Below ground</th>
            <td>NEC-2 cannot model buried wire. Ground radials have to sit on or above the surface.</td>
          </tr>
        </tbody>
      </table>

      <h2>Worked example: a 20 m dipole from scratch</h2>
      <ol className="guide-steps">
        <li>
          Press <em>New</em>. Set the frequency to 14.2 MHz.
        </li>
        <li>
          A half wave is about 300 / 14.2 / 2 ≈ 10.6 m, and real wire ends up a few per cent shorter, so aim
          for 10.3 m. Press <em>Draw wires</em> and click twice in the Top view to draw a rough horizontal
          wire.
        </li>
        <li>
          Select it and type the ends exactly: end 1 at X 0, Y −5.15, Z 0 and end 2 at X 0, Y 5.15, Z 0. Set
          the diameter to 2 mm and the segments to 21.
        </li>
        <li>
          Press <em>Feed at centre</em>. The results appear: a little inductive, around 70 Ω.
        </li>
        <li>
          Trim for resonance the way you would in the garden: shorten both ends slightly until the reactance
          passes through zero. Switch the frequency to a 20 m band sweep to see the whole SWR curve.
        </li>
        <li>
          Now give it some height: set both ends to Z 10, and set Ground to <em>Real ground</em>. Watch the
          elevation pattern change completely — that is the ground reflection, and it is why height matters
          more than wire.
        </li>
      </ol>

      <h2>Working with .nec files</h2>
      <p>
        <em>Open</em> reads standard NEC-2 card decks from other programs, and <em>Save</em> writes one out, so
        your model travels to EZNEC, 4nec2 or a friend's shack. The <em>Card deck</em> tab shows the cards for
        what you have drawn; edit them there and press Apply, and the drawing follows.
      </p>
      <p>
        Some decks use features the visual editor cannot draw yet — arcs, helices, copied structures, tapered
        wires. Those still run exactly as written; the views simply become read-only until you go back to a
        model it can draw.
      </p>

      <h2>Honest limits</h2>
      <ul>
        <li>NEC-2 wants wires of a single diameter, and does not model buried radials.</li>
        <li>
          Keep horizontal wires at least about a fifth of a wavelength above real ground for trustworthy
          results.
        </li>
        <li>
          A model is a model. Feed impedance is sensitive to everything nearby — your roof, the gutters, the
          feedline — so treat the numbers as a very good starting point, then measure.
        </li>
      </ul>

      <h2>Mouse and keyboard</h2>
      <table className="key-table">
        <tbody>
          <tr>
            <th scope="row">Drag a wire or an end</th>
            <td>Move it</td>
          </tr>
          <tr>
            <th scope="row">
              <kbd>Shift</kbd> + drag
            </th>
            <td>Detach from the wires it is joined to</td>
          </tr>
          <tr>
            <th scope="row">
              <kbd>Alt</kbd> + drag
            </th>
            <td>No snapping</td>
          </tr>
          <tr>
            <th scope="row">Right-click</th>
            <td>Feed, split, duplicate, delete, add a wire</td>
          </tr>
          <tr>
            <th scope="row">Wheel / drag the background</th>
            <td>Zoom / pan, in all three flat views together</td>
          </tr>
          <tr>
            <th scope="row">
              <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>
            </th>
            <td>Undo / redo</td>
          </tr>
          <tr>
            <th scope="row">
              <kbd>Del</kbd>
            </th>
            <td>Delete the selected wire</td>
          </tr>
          <tr>
            <th scope="row">
              <kbd>Esc</kbd>
            </th>
            <td>Stop drawing, or deselect</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
