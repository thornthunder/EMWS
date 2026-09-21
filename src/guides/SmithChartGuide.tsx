export function SmithChartGuide() {
  return (
    <>
      <p className="lede">
        The Smith chart tool answers one question: what will my radio see, and what do I have to put between it
        and the antenna to make it happy? You build the network component by component and watch the match move.
      </p>

      <h2>The chart in one minute</h2>
      <p>
        A Smith chart is a map of every possible impedance, squashed into a circle. The centre is a perfect
        match — 50 Ω, no reactance. The further out you are, the worse the SWR, and the dashed rings mark 2:1
        and 3:1. The top half is inductive, the bottom half capacitive. The horizontal line through the middle
        is pure resistance, labelled in ohms.
      </p>
      <p>
        Everything a matching component does is a slide along one of the chart's circles. That is the whole
        trick: a series component slides you along a circle of constant resistance, and a component across the
        line slides you along a circle of constant conductance. Put two of those together and you can get from
        anywhere to the middle.
      </p>

      <h2>Setting up your load</h2>
      <p>There are three ways to tell the tool what your antenna looks like:</p>
      <ul>
        <li>
          <strong>Type R + jX.</strong> Say what you measured and at what frequency. Leave it on{' '}
          <em>reactance follows frequency</em> and the tool treats the reactance as the inductor or capacitor it
          really is, so a sweep means something.
        </li>
        <li>
          <strong>Open a .s1p file.</strong> That is what a NanoVNA writes when you save a sweep. The whole
          measured band comes in.
        </li>
        <li>
          <strong>Take it from the Antenna Modeler.</strong> Model an antenna there, come here, and a button
          appears offering that antenna's impedance across the frequencies you swept.
        </li>
      </ul>

      <h2>Building the network</h2>
      <p>
        Components are listed in the order you meet them walking from the antenna back towards the radio. Add
        one and it appears on the chart in its own colour, with a numbered dot where it leaves the impedance.
      </p>
      <table className="key-table">
        <caption>What each component is for</caption>
        <tbody>
          <tr>
            <th scope="row">Series L or C</th>
            <td>In line with the feed. Moves you round a constant-resistance circle: up for an inductor, down for a capacitor.</td>
          </tr>
          <tr>
            <th scope="row">Shunt L or C</th>
            <td>Across the line. Moves you round a constant-conductance circle, the mirror image of the series case.</td>
          </tr>
          <tr>
            <th scope="row">Line</th>
            <td>
              A length of coax or ladder line. Give it a characteristic impedance, a velocity factor, and its
              matched loss if you care about it; the impedance spirals in as it travels.
            </td>
          </tr>
          <tr>
            <th scope="row">Stub</th>
            <td>A dead-ended length of line, open or shorted, used as a reactance you can cut to length.</td>
          </tr>
          <tr>
            <th scope="row">Transformer</th>
            <td>A balun or unun, set by impedance ratio: 4:1 turns 200 Ω into 50 Ω.</td>
          </tr>
          <tr>
            <th scope="row">Resistor</th>
            <td>For dummy loads and for seeing what a lossy match costs you.</td>
          </tr>
        </tbody>
      </table>
      <p>
        Every component has a slider, and the slider works in <strong>ohms of reactance</strong> rather than in
        microhenries, because that is what decides how far round the circle you slide. Type an exact value in the
        box when you know what you want. <em>Switch out of circuit</em> takes a component out without deleting
        it, for a quick before-and-after.
      </p>
      <p>
        Give an inductor or capacitor a <strong>Q</strong> and it stops being perfect: the tool adds the loss
        resistance that a real component has. Leave it at 0 for ideal parts.
      </p>

      <h2>Letting the tool do it</h2>
      <p>
        Under <em>Match it for me</em> the tool works out every two-component L network that brings what the
        radio currently sees to your system impedance, at the design frequency. Each one shows real component
        values and the band over which the result stays under 2:1. Press <em>Use this</em> and the components
        are added to the end of the chain.
      </p>
      <p>Which to choose?</p>
      <ul>
        <li>
          A <strong>low-pass</strong> arrangement (series inductor, shunt capacitor) also attenuates harmonics,
          which is usually what a transmitter wants.
        </li>
        <li>
          A <strong>high-pass</strong> one blocks DC and often needs a smaller, cheaper capacitor.
        </li>
        <li>
          If the load already has the right resistance, one component is enough: the tool offers that instead.
        </li>
      </ul>

      <h2>Reading the result</h2>
      <table className="key-table">
        <tbody>
          <tr>
            <th scope="row">At the radio</th>
            <td>What the rig sees at the design frequency, after everything in the chain.</td>
          </tr>
          <tr>
            <th scope="row">SWR</th>
            <td>
              And how much power is turned back at the mismatch, in dB. Note this is power that never leaves the
              radio, not power lost as heat.
            </td>
          </tr>
          <tr>
            <th scope="row">Under 2:1</th>
            <td>
              How much bandwidth the match holds. A narrow figure means a high-Q match: fine for one band edge,
              annoying across a whole band.
            </td>
          </tr>
          <tr>
            <th scope="row">Step by step</th>
            <td>The impedance after each component, so you can see which one did the work.</td>
          </tr>
        </tbody>
      </table>
      <p>
        The blue line across the chart is the whole sweep, not just the design frequency: it shows how the match
        drifts as you move across the band. Hover it to read any point, and click the SWR curve underneath to
        make that frequency the design frequency.
      </p>

      <h2>A worked example: matching a short vertical</h2>
      <ol className="guide-steps">
        <li>Set the load to 22 Ω resistance and −140 Ω reactance at 7.1 MHz: a typical short, capacitive vertical.</li>
        <li>Set the sweep to 7.0 to 7.2 MHz and the design frequency to 7.1.</li>
        <li>
          Look at <em>Match it for me</em>. The tool offers arrangements starting with a series inductor — that
          is the loading coil you were going to wind anyway.
        </li>
        <li>Press <em>Use this</em> on the low-pass one and watch the path walk from the rim into the centre.</li>
        <li>
          Check the <em>Under 2:1</em> figure. On an antenna like this it will be narrow, which is the honest
          answer: a short vertical is a high-Q load, and no matching network changes that.
        </li>
      </ol>

      <h2>Honest limits</h2>
      <ul>
        <li>
          Components are ideal unless you give them a Q, and the tool has no parasitic capacitance, no
          self-resonance and no core saturation. Real parts at real power are less obliging.
        </li>
        <li>
          Line loss is modelled as matched loss scaling with the square root of frequency, which is a good
          approximation for coax but not an exact cable model. Take the figures from your cable's datasheet.
        </li>
        <li>
          A match at the shack end of a long, lossy feedline can hide a terrible antenna. Watch what the chart
          does at the load, not just at the radio.
        </li>
      </ul>
    </>
  );
}
