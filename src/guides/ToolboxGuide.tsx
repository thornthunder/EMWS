export function ToolboxGuide() {
  return (
    <>
      <p className="lede">
        The RF toolbox is the back of the envelope: how long a wire, how much a run of coax eats, what resistors make a 10 dB
        pad, what −73 dBm is in microvolts, what an SWR of 2 reflects. Nothing in it solves anything - that is what the other
        tools are for - but every figure shows its working, and where a figure is an estimate rather than arithmetic the page
        says so and points at the tool that does it properly.
      </p>

      <h2>Five minutes in the toolbox</h2>
      <ol className="guide-steps">
        <li>
          Open the <a href="#/toolbox">RF toolbox</a>. The <em>Wavelength &amp; wire</em> tab shows 20 m: press a band button or
          type a frequency, and read the wavelength, the half and quarter wave, and three answers for a dipole's length.
        </li>
        <li>
          Go to <em>Coax loss</em>. Pick RG-58, 30 m, 28.5 MHz and an SWR of 2 at the antenna, and read what reaches the antenna
          of 100 W. Then pick <em>From its datasheet…</em> and type two lines from your cable's attenuation table.
        </li>
        <li>
          Go to <em>Attenuators</em>: a 10 dB Pi pad at 50 Ω. Tick <em>Round to E24 values</em> and see what the pad you can
          actually build does - its real attenuation and its match.
        </li>
        <li>
          On <em>dB, watts &amp; S-units</em>, −73 dBm reads as S9, 50 µV. Change the band to VHF and watch S9 move 20 dB.
        </li>
      </ol>

      <h2>Wavelength and wire</h2>
      <p>
        The wavelength is c / f, nothing more. The <strong>electrical length</strong> of a piece of line is its physical length
        divided by the wavelength <em>in that line</em>, which is shorter by the velocity factor: 0.66 for solid-polyethylene
        coax, about 0.8 for foam, close to 1 for open wire. The degrees figure is what the Smith chart tool's line element wants.
      </p>
      <p>
        The dipole table gives <strong>three lengths on purpose</strong>. A free-space half wave is the physics; a dipole cut to
        it is a little inductive because current does not stop dead at the ends. How much shorter it must be depends on the
        wire's thickness and what is near it. The middle row is a measurement with this suite's own engine: a 2 mm wire in free
        space is resonant at 145.5 / f metres (10.247 m at 14.2 MHz). The last row is the handbook's 468 / f feet, which
        comes out at 142.6 / f metres and assumes a wire a few metres above ground. None of them is <em>your</em> antenna: draw
        it in the Antenna Modeler and press <em>Tune it for me</em>, which finds the resonant length for your wire at your
        height by solving it.
      </p>

      <h2>Coax loss, and why the catalogue says "at least"</h2>
      <p>
        EMWS is public domain, and a maker's attenuation table is not, so the catalogue copies none. Instead each cable is its
        <strong>nominal dimensions</strong> - centre conductor, diameter over the dielectric, the dielectric itself - and its loss
        is <strong>calculated</strong>: the skin-effect resistance of the two conductors as if they were smooth solid copper,
        plus the dielectric's loss tangent. That calculation is a <em>floor</em>. A real cable has a braided shield and usually a
        stranded centre, both lossier than the smooth surfaces in the formula, and the figure on the datasheet is higher by an
        amount the geometry cannot tell you. So the catalogue figures are labelled "at least", and the honest way to get your
        cable's real loss is <em>From its datasheet…</em>: type the attenuation at two frequencies, one low and one high, and
        the tool fits the usual law (a √f part for the conductors and an f part for the dielectric) through them exactly, then
        reads it at your frequency. Datasheets in dB per 100 ft: multiply by 3.28.
      </p>
      <p>
        With the matched loss known, the <strong>SWR at the antenna</strong> adds to it by the classic formula for a lossy line
        with a reflected wave on it, and the same arithmetic gives the <strong>SWR at the radio</strong>, which is always better
        than at the antenna because the reflection has made the round trip through the loss. Everything that goes in and does not
        reach the antenna is heat in the cable, and the card says how many watts. If you have run the antenna in the Antenna
        Modeler, one button takes its SWR at the nearest solved frequency, against the cable's Z0.
      </p>
      <p>
        Two cautions. The chart's frequency axis runs to 1 GHz, but the catalogue dimensions are nominal and the dielectric
        figures generic, so above a few hundred MHz the floor is a rough one. And a very lossy run hides a bad antenna: a radio
        reading 1.3 : 1 through 40 m of thin cable on 70 cm says little about the antenna, which the SWR-at-the-radio figure
        makes plain.
      </p>

      <h2>Attenuators</h2>
      <p>
        A <strong>Pi</strong> pad is a shunt resistor, a series one and a shunt one; a <strong>T</strong> is series, shunt,
        series. Both are designed from the closed forms for any attenuation and any pair of impedances, and the table gives the
        exact values. Between two <em>different</em> impedances a resistive pad cannot lose less than a certain amount - 5.72 dB
        between 75 and 50 Ω - and at exactly that figure one resistor disappears and the pad is the <strong>minimum-loss L
        pad</strong>, which the third shape gives you directly. Ask for less than the minimum and the tool says so rather than
        inventing a pad.
      </p>
      <p>
        Nobody owns a 96.25 Ω resistor. Tick <em>Round to E24 values</em> and the table adds the nearest preferred values, and
        the figures below the table change to what <em>that</em> pad does: the tool analyses the circuit as built, so the
        attenuation, the input and output match (as return loss) and the heat in each resistor are for the parts you will
        solder, not for the ideal. The figures in the <em>Dissipates</em> column are for the power you typed; rate each resistor
        at about twice its share, because a resistor at its full rating runs hot and drifts.
      </p>

      <h2>dB, watts and S-units</h2>
      <p>
        dBm is power relative to a milliwatt: 0 dBm is 1 mW, 30 dBm is 1 W, 50 dBm is 100 W. Volts follow from power and
        impedance (V = √PR), and dBµV is those volts relative to a microvolt - at 50 Ω, dBµV is dBm + 107. The
        <strong>S-meter</strong> line uses the IARU Region 1 scale: S9 is −73 dBm (50 µV) at HF and −93 dBm above 30 MHz, with
        6 dB per S-unit, so S1 is 48 dB below S9. Your radio's meter almost certainly disagrees - few are calibrated to the
        recommendation - so treat this as what the scale means, not what your needle will show.
      </p>
      <p>
        <strong>EIRP</strong> is transmitter power, less the feeder, times the antenna's gain over an isotropic radiator;
        <strong>ERP</strong> is the same relative to a dipole, 2.15 dB less. The Antenna Modeler's gain figures are dBi, so they
        go straight into the gain box. The <strong>field strength</strong> at a distance is the free-space far-field figure,
        E = √(30 P) / d, with the power density beside it. It is an estimate for comparing against your regulator's exposure
        limits, which this page deliberately does not state because they differ by country and change. Two honest limits on it:
        it holds only in the far field, beyond the distance the card gives, and the ground can reflect the wave so that the
        field at a point is up to twice the free-space figure. For where the energy actually goes, the Antenna Modeler's pattern
        is the answer; for the field at a nearby point, a measurement is.
      </p>

      <h2>SWR and return loss</h2>
      <p>
        One quantity in four costumes. SWR, the reflection coefficient |Γ|, return loss and mismatch loss all say how much of a
        wave is reflected: SWR 2 is |Γ| = 1/3, which is 11 % of the power reflected, a return loss of 9.5 dB and a mismatch
        loss of 0.5 dB. The second card turns a directional wattmeter's two readings into an SWR (|Γ| = √(reflected / forward))
        and the third does the same for an impedance R + jX in a system of any Z0, which is the number the Antenna Modeler's
        feed-impedance card gives you.
      </p>
      <p>
        <strong>Mismatch loss is not power lost.</strong> It is what the reflection would cost if nothing sent it back; in a
        real station the transmitter or tuner re-reflects it and it makes another trip down the cable, where the real cost is the
        extra cable loss - which is the <em>Added by the SWR</em> line on the Coax tab. A 2 : 1 SWR into a short run of good
        cable costs almost nothing; the same SWR at the end of a long thin one costs plenty.
      </p>

      <h2>What this tool does not do</h2>
      <ul>
        <li>It does not solve an antenna, a match or a filter; the Antenna Modeler, the Smith chart and Coils, traps and filters do.</li>
        <li>It does not know your cable's real loss unless you type it from the datasheet; the catalogue is a floor.</li>
        <li>It states no regulatory limits, exposure or otherwise, and no component voltage ratings.</li>
        <li>Everything it remembers (the last figures on each tab) stays in this browser.</li>
      </ul>
    </>
  );
}
