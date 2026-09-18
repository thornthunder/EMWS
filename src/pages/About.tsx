const REPO = 'https://github.com/thornthunder/EMWS';

export function About() {
  return (
    <div className="prose">
      <h1>About EMWS</h1>
      <p>
        The Electro Magnetic Works Suite is a set of electromagnetic simulation tools for radio amateurs and
        experimenters, started by ZR1JT. It is a static web application: the server only hands out files, and
        all the computation happens on your machine.
      </p>

      <h2>Public domain</h2>
      <p>
        EMWS is dedicated to the public domain. The source code is released under{' '}
        <a href="https://unlicense.org/">The Unlicense</a>; the documentation, example antenna models and other
        data under <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</a>. Use it, copy it,
        host your own, sell it, change it. No permission or credit is needed. The source is at{' '}
        <a href={REPO}>{REPO.replace('https://', '')}</a>.
      </p>

      <h2>The engines</h2>
      <p>
        The Antenna Modeler runs <strong>NEC2</strong>, the Numerical Electromagnetics Code written at Lawrence
        Livermore National Laboratory by G. J. Burke and A. J. Poggio, a work of the United States government
        and in the public domain. EMWS uses <strong>nec2c 1.3.1</strong>, the C translation by Neoklis
        Kyriazis, 5B4AZ, who also placed it in the public domain. It is compiled, unmodified, to WebAssembly.
      </p>
      <p>
        The application is built with React and Vite, which are MIT-licensed; their notices travel with the
        built files.
      </p>

      <h2>Know the limits</h2>
      <p>
        A model is only as good as its assumptions. NEC2 wants wires of a single diameter, segments that are
        short against the wavelength but long against the wire radius, and horizontal wires kept well clear of
        the ground; it cannot model buried radials. Treat the results as a guide to build and measure by, not
        as a guarantee. EMWS comes with no warranty of any kind.
      </p>
    </div>
  );
}
