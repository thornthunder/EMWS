export function FieldSandboxGuide() {
  return (
    <>
      <p className="lede">
        The field sandbox is the one tool in EMWS that is for looking rather than for building. It solves Maxwell's equations
        directly, cell by cell and tick by tick, in a flat two-dimensional world you draw, and paints the electric field as it
        goes: waves leaving a source, bouncing off a sheet of metal, bending through a dielectric, adding up and cancelling.
        It will not tell you your antenna's impedance - the Antenna Modeler does that - but it will show you why a corner
        reflector works, what a standing wave looks like, and what "half a wavelength" means in space.
      </p>

      <h2>Five minutes with it</h2>
      <ol className="guide-steps">
        <li>
          Open the <a href="#/fdtd">Field sandbox</a>. Under <em>Start from</em> pick <strong>Two slits</strong>. It plays at
          once: a source on the left, a wall with two gaps, and beyond the wall the two openings' waves add and cancel in
          bands. Press <em>Pause</em> (or the space bar) to study a moment.
        </li>
        <li>
          Choose <em>Conductor</em> and drag a line somewhere in the wave's path. The clock restarts and the waves now go round
          your sheet. Ctrl+Z takes it away again; a whole drag is one undo step.
        </li>
        <li>
          Choose <em>Select</em>, click your line, and drag it somewhere else. <em>Delete</em> removes it.
        </li>
        <li>
          Switch <em>Show</em> to <strong>Its envelope</strong>. Instead of the moving wave you see where the field has been
          strong recently - the standing-wave pattern in front of a reflector, the shadow behind it, the lobes of a beam.
        </li>
        <li>
          Try the other scenes: the parabola makes a beam, the corner reflector sends most of the power one way, the
          dielectric slab shortens the wavelength inside itself and reflects part of every wave, and the two plates guide the
          wave between them. The last scene is a single pulse in empty space, the plainest view of how it works.
        </li>
      </ol>

      <h2>What the world is</h2>
      <p>
        <strong>A cross-section.</strong> The sandbox is two-dimensional, so everything you draw extends infinitely into and
        out of the screen. A dot is a wire seen end-on; a line is a sheet of metal; a rectangle of dielectric is a slab. The
        electric field it shows (Ez) points out of the screen, along those infinitely long objects - the polarisation a wire
        antenna radiates when you look along the wire. That is also why a source here radiates in all directions in the plane,
        like a long wire does around itself, and why the field falls off more gently with distance than it would from a real,
        finite antenna: a cylindrical wave spreads as 1/√r, a spherical one as 1/r.
      </p>
      <p>
        <strong>The frequency sets the scale.</strong> The world is in metres, and the cell size is a chosen fraction of the
        wavelength at the frequency you set, so a 3 m world at 1 GHz is ten wavelengths wide and at 100 MHz it is one. Change
        the frequency and the wavelength of a continuous source changes with it; the scenes are drawn for 1 GHz, so at other
        frequencies you will want to redraw them to the new wavelength. The legend under the picture says how many wavelengths
        the world is.
      </p>
      <p>
        <strong>The edges absorb.</strong> Round the world is an invisible layer (a perfectly matched layer, in the jargon) that
        soaks up whatever reaches it, so a wave leaving the picture is gone rather than reflected back in. It is good but not
        perfect; a very grazing wave can bring a faint echo. Nothing you draw can touch it.
      </p>
      <p>
        <strong>Colours.</strong> The field is painted blue for one sign and orange-red for the other through the page colour
        at zero, scaled to the strongest field in the picture at the time; <em>Contrast</em> turns the weak outer waves up. The
        amplitudes are relative to a source of 1, not volts per metre - the sandbox has no notion of your transmitter's power.
        Conductors are drawn in ink and dielectrics tinted.
      </p>

      <h2>What to draw with</h2>
      <ul>
        <li>
          <strong>Conductor</strong>: drag a line. It is a perfect conductor, as NEC's wires are; the field inside it is held
          at zero. A thin line is one cell thick; selecting it lets you give it a thickness.
        </li>
        <li>
          <strong>Dielectric</strong>: drag a rectangle, with the permittivity εr and, if you like, a conductivity σ in S/m for
          a lossy material. Waves inside it travel slower by √εr and are shorter by the same factor, and part of every wave
          reflects at its faces. Air is 1, PTFE about 2.1, FR-4 about 4.4, fresh water about 80 (and very slow to compute
          well: 80 needs nine times the cells per wavelength that air does).
        </li>
        <li>
          <strong>Source</strong>: click. A continuous source at the world's frequency, or one pulse, with an amplitude and a
          phase. Two continuous sources with a phase difference make a phased array; the envelope view shows its lobes.
        </li>
        <li>
          <strong>Select</strong>: click to pick an object, drag to move it, <em>Delete</em> to remove it; the panel shows its
          properties.
        </li>
      </ul>

      <h2>The honest limits</h2>
      <p>
        <strong>Cells per wavelength.</strong> The grid is a stand-in for continuous space, and it is only a good one when a
        wavelength spans plenty of cells. Below about 10, the grid itself slows the waves and spreads them (numerical
        dispersion); the tool warns you, and 20 is comfortable. More cells cost time: the work goes with the square of the
        number across the world, and the time step shrinks with them too, so doubling the resolution is eight times the work
        for the same stretch of time. The <em>Speed</em> readout says how many steps a second your machine manages.
      </p>
      <p>
        <strong>Two dimensions, and nothing else.</strong> No currents are computed, no impedances, no patterns in dBi. Lossy
        ground, real conductors, wire radii, matching - none of it is here. The sandbox is an illustration of the physics the
        other tools rest on, and a good way to build intuition for them; it is not a substitute for any of them. Edit anything
        and the clock restarts, because the scene <em>is</em> the simulation.
      </p>
      <p>
        <strong>What is checked.</strong> The engine's test suite makes it reproduce the speed of light, the right wavelength on
        the grid, reflection from a conductor with the sign flipped, slowing by √εr in a dielectric, and absorption at the edges
        to better than one part in ten thousand of the energy. Those are the physics it is held to; anything subtler, take as a
        picture.
      </p>
    </>
  );
}
