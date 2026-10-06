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
          wave between them. <em>One pulse, open space</em> is the plainest view of how it works.
        </li>
        <li>
          Pick <strong>Brewster's angle</strong>. A plane wave comes down at a slant onto a ground, and above the ground there is
          only the incoming wave: nothing comes back. Now change <em>Polarisation</em> to <strong>Ez</strong>. Same ground,
          same angle, the other polarisation - and a standing wave of blobs forms above the ground, because this time a good
          part of the wave is reflected.
        </li>
        <li>
          Choose <em>Probe</em> and click a point above the ground, then another point just over it. Two charts appear
          under the picture: the field at each probe against time, one trace per probe, and their spectra. The probes are
          numbered on the picture, in the list and in the legend. Drag one to move it, click it to take it away; probes do
          not restart the clock.
        </li>
      </ol>

      <h2>What the world is</h2>
      <p>
        <strong>A cross-section.</strong> The sandbox is two-dimensional, so everything you draw extends infinitely into and
        out of the screen. A dot is a wire seen end-on; a line is a sheet of metal; a rectangle of dielectric is a slab. A
        source here radiates in all directions in the plane, like a long wire does around itself, and its field falls off
        more gently with distance than it would from a real, finite antenna: a cylindrical wave spreads as 1/√r, a spherical
        one as 1/r.
      </p>
      <p>
        <strong>Two polarisations.</strong> <em>Polarisation</em> chooses which field points out of the screen, along those
        endless objects:
      </p>
      <ul>
        <li>
          <strong>Ez</strong>: the electric field points out of the screen, along the wires - the polarisation a wire antenna
          radiates when you look along the wire. Picture the screen as a vertical slice through the world with the ground
          along the bottom, and Ez is <em>horizontal</em> polarisation: a horizontal dipole seen end-on.
        </li>
        <li>
          <strong>Hz</strong>: the magnetic field points out of the screen and the electric field lies in the picture. Over
          a ground along the bottom, that is <em>vertical</em> polarisation. A source here is a magnetic line current - a long
          slot seen end-on - rather than a wire, and a conductor reflects the field the other way up: Hz comes back the same
          sign where Ez comes back reversed.
        </li>
      </ul>
      <p>
        The picture paints whichever field is out of the screen, and the legend and readouts say which.
      </p>
      <p>
        <strong>The frequency sets the scale.</strong> The world is in metres, and the cell size is a chosen fraction of the
        wavelength at the frequency you set, so a 3 m world at 1 GHz is ten wavelengths wide and at 100 MHz it would be
        one - twenty cells across, a blur. So by default the scene <strong>scales with the frequency</strong>: change 1000 MHz
        to 100 and the world becomes 30 × 20 m, every sheet, slab, disc and source grows ten times with it, and the picture is
        the same picture, with the same cells. For conductors and lossless dielectrics that is exact - the physics has no
        size of its own, only sizes in wavelengths. A conductivity in S/m is the exception: it stays as you typed it, and
        a lossy ground means something different at 7 MHz than at 1 GHz. Untick <em>Scale the scene with the frequency</em>
        to hold the metres instead, for a real object at several frequencies; the panel then warns you when the world has
        shrunk to under two wavelengths. The legend under the picture says how many wavelengths the world is.
      </p>
      <p>
        <strong>Every control explains itself.</strong> Rest the pointer on any field, tick box, button or readout and a
        sentence says what it is and what it does.
      </p>
      <p>
        <strong>The edges absorb.</strong> Round the world is an invisible layer (a perfectly matched layer, in the jargon) that
        soaks up whatever reaches it, so a wave leaving the picture is gone rather than reflected back in. It is good but not
        perfect; a very grazing wave can bring a faint echo. Whatever you draw touching the edge of the world runs on through
        that layer, so a ground drawn from edge to edge is an endless ground, not a slab with ends.
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
          phase. Click again for another: there can be as many as you like, and the panel lists them by number - the number
          is drawn beside each on the picture once there are two - with its position, amplitude and phase. Click one in the
          list to edit it. Continuous sources with phase differences make a phased array; the envelope view shows its lobes,
          and a probe at a few points shows the phases adding and cancelling.
        </li>
        <li>
          <strong>Probe</strong>: click a point to watch it, up to six of them, each numbered and in its own colour on the
          picture, in the list and on the charts. The first chart is the field at every probe over the last dozen periods,
          one trace each, so you can see two points of a standing wave swing in step or in opposition; the second is their
          spectra, from DC to three times the world's frequency. With one probe the spectrum is in dB below its own
          strongest point; with several, below the strongest point of any of them, so a probe in a null reads so many dB
          under a probe in a lobe (the fields are relative, so the spectra are too). A lone probe's spectrum is taken over
          everything it has recorded, up to 4096 steps; several probes' spectra are taken over the stretch they have all
          recorded - as far back as the newest one goes - because a wave that arrived partway through a longer recording
          would average weaker than the same wave filling a shorter one. Through a Hann window; it needs two periods
          before it is drawn and sharpens the longer it listens. A continuous source shows one peak at its frequency; a pulse in a box shows the
          box's resonances. Drag a probe to move it, click it to take it away, or use the × in the list; <em>Remove all</em>
          clears them.
        </li>
        <li>
          <strong>Select</strong>: click to pick an object, drag to move it, <em>Delete</em> to remove it; the panel shows its
          properties.
        </li>
      </ul>

      <h2>Plane waves</h2>
      <p>
        Tick <em>A plane wave comes in from outside</em> and the world is lit from one side by a straight wavefront, as from a
        transmitter far away - the proper way to see diffraction and scattering, where a point source's curved waves muddle
        the picture. Choose the side it comes from and a <em>Tilt</em> from square on (up to 85°): from the top, a positive
        tilt leans it to the right; from the left, upwards. A small arrow on the edge shows where it comes in and which way it
        travels. It can be continuous or one pulse, and its amplitude is 1 unless you change it. <em>A mast in a plane
        wave</em> shows what it is for: a standing wave in front of the mast, and a shadow behind it filled in from the edges.
      </p>
      <p>
        The wave is launched along the side it comes from and, when it slants, along the next side too - the side it slants
        in by - so it reaches every corner of the world. It is launched into <strong>empty space only</strong>. Where
        something you drew reaches one of those sides, the wave is left out along that stretch, and the panel says so. The
        usual case is a ground: a wave slanting in over a ground that reaches the side it comes from finds no reflection in a
        wedge near that side, because the ground that would have reflected into the wedge lies outside the world. Look at the
        reflection on the far side of the world, away from the wedge.
      </p>

      <h2>Ground, and Brewster's angle</h2>
      <p>
        Draw a dielectric across the bottom of the world from edge to edge and it is a ground; give it a conductivity and it
        is a lossy one. Two scenes are set up for this:
      </p>
      <ul>
        <li>
          <strong>Brewster's angle</strong>: a lossless ground of εr 4 lit at 63.4° from overhead, where tan θ = √εr. In Hz -
          vertical polarisation - nothing is reflected at this angle. In Ez - horizontal polarisation - about 60 % of the field
          is reflected, and above the ground the incoming and reflected waves stand. Horizontal polarisation has no Brewster
          angle at all: Ez never stops reflecting, whatever the angle.
        </li>
        <li>
          <strong>Average ground on 40 m</strong>: 7.1 MHz over εr 13 and 5 mS/m, the wave arriving 20° above the horizon,
          in a world 300 m wide. In Ez (horizontal) the ground reflects most of the wave, upside down, so the field is nearly
          zero right at the ground and stands in bands above it - switch <em>Show</em> to <em>Its envelope</em> to see them.
          Those bands are the lobes of a horizontal antenna's pattern over ground, and the null at the ground is why a
          horizontal dipole close to the ground radiates poorly at low angles. Switch to Hz (vertical) and the bands fade. Real
          ground has no true Brewster angle, because it is lossy, but vertical polarisation's reflection dips to a minimum at
          the <em>pseudo-Brewster</em> angle - for this ground about 13° above the horizon, where only about a fifth of the
          field comes back. Below it the reflection grows again with its sign reversed, so towards the horizon it cancels the
          direct wave - which is why a vertical over real ground loses its lowest-angle radiation.
        </li>
      </ul>
      <p>
        A lossy ground at HF is mostly conductivity, and a wave inside it is several times shorter than in air - 3.95 times
        for average ground at 7.1 MHz. That is why the 40 m scene uses 40 cells a wavelength: it leaves ten inside the
        ground. If a material in your world is coarser than ten cells a wavelength inside, the panel warns you and says how
        many cells would fix it.
      </p>

      <h2>The honest limits</h2>
      <p>
        <strong>Cells per wavelength.</strong> The grid is a stand-in for continuous space, and it is only a good one when a
        wavelength spans plenty of cells. Below about 10, the grid itself slows the waves and spreads them (numerical
        dispersion); the tool warns you, and 20 is comfortable. More cells cost time: the work goes with the square of the
        number across the world, and the time step shrinks with them too, so doubling the resolution is eight times the work
        for the same stretch of time. The <em>Speed</em> readout says how many steps a second your machine manages.
      </p>
      <p>
        <strong>Inside materials too.</strong> The same rule holds inside a dielectric, where the wavelength is shorter. With
        about five cells a wavelength inside a ground, the sandbox's reflection from it came out ten per cent away from the
        textbook figure; with ten, within a few hundredths.
      </p>
      <p>
        <strong>Two dimensions, and nothing else.</strong> No currents are computed, no impedances, no patterns in dBi. A
        ground here shows how waves reflect from it; it says nothing about the losses of an antenna's own ground system - real
        conductors, wire radii, radials and matching are not here. The sandbox is an illustration of the physics the other
        tools rest on, and a good way to build intuition for them; it is not a substitute for any of them. Edit anything and
        the clock restarts, because the scene <em>is</em> the simulation.
      </p>
      <p>
        <strong>What is checked.</strong> The engine's test suite makes it reproduce the speed of light, the right wavelength on
        the grid, reflection from a conductor with the sign flipped, slowing by √εr in a dielectric (in both polarisations),
        and absorption at the edges to better than one part in ten thousand of the energy. The plane wave is held to fill
        empty space evenly to within 3 % square on and at a slant, at amplitude 1. A conductor must send it back whole (at
        least 0.98 of it: upside down in Ez, the same way up in Hz), and εr 4 must send back a third of it, within 0.02.
        Reflections off a ground are checked against Fresnel's equations, the textbook answer: at Brewster's angle over εr 4,
        vertical polarisation must reflect less than 0.04 of the field and horizontal within 0.03 of Fresnel's 0.60; over
        average ground at 7.1 MHz, at the 40 m scene's own grid, both polarisations within 0.05 of Fresnel, square on and 13°
        above the horizon. The probe's spectrum is checked to find a sine at its own frequency and a pulse at its centre
        frequency, and two probes recording a full and a half-amplitude sine for different lengths of time must read 6.02 dB
        apart. Those are the physics it is held to; anything subtler, take as a picture.
      </p>
    </>
  );
}
