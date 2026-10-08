import { Suspense, lazy } from 'react';
import { About } from './pages/About';
import { GuidePage, GuidesIndex } from './pages/Guides';
import { Home } from './pages/Home';
import { useHashPath } from './router';

// Each tool is its own chunk, fetched the first time its page opens: the home page and the
// guides need none of the solver, the Smith chart or the balun maths. The engine's WASM
// is fetched by the worker separately, as before.
const AntennaModeler = lazy(() => import('./tools/antenna-modeler/AntennaModeler').then((m) => ({ default: m.AntennaModeler })));
const SmithTool = lazy(() => import('./tools/smith-chart/SmithTool').then((m) => ({ default: m.SmithTool })));
const BalunTool = lazy(() => import('./tools/balun/BalunTool').then((m) => ({ default: m.BalunTool })));
const LcTool = lazy(() => import('./tools/lc/LcTool').then((m) => ({ default: m.LcTool })));
const ToolboxTool = lazy(() => import('./tools/toolbox/ToolboxTool').then((m) => ({ default: m.ToolboxTool })));
const FdtdTool = lazy(() => import('./tools/fdtd/FdtdTool').then((m) => ({ default: m.FdtdTool })));

const NAV = [
  { path: '/', label: 'Home' },
  { path: '/antenna', label: 'Antenna Modeler' },
  { path: '/smith', label: 'Smith Chart' },
  { path: '/balun', label: 'Baluns' },
  { path: '/lc', label: 'Coils & Filters' },
  { path: '/toolbox', label: 'Toolbox' },
  { path: '/fdtd', label: 'Fields' },
  { path: '/guides', label: 'Field Guides' },
  { path: '/about', label: 'About' },
];

/** Shown while a tool's chunk loads: no heading, so nothing reads as the page before it is. */
function Loading() {
  return <p className="muted loading-tool">Loading the tool…</p>;
}

function Page({ path }: { path: string }) {
  if (path === '/guides') return <GuidesIndex />;
  if (path.startsWith('/guides/')) return <GuidePage id={path.slice('/guides/'.length)} />;

  switch (path) {
    case '/':
      return <Home />;
    case '/antenna':
      return <AntennaModeler />;
    case '/smith':
      return <SmithTool />;
    case '/balun':
      return <BalunTool />;
    case '/lc':
      return <LcTool />;
    case '/toolbox':
      return <ToolboxTool />;
    case '/fdtd':
      return <FdtdTool />;
    case '/about':
      return <About />;
    default:
      return (
        <div className="prose">
          <h1>Nothing here</h1>
          <p>
            <a href="#/">Back to the workbench</a>
          </p>
        </div>
      );
  }
}

/** Highlights "Field Guides" for every guide page, not just the index. */
function isCurrent(navPath: string, path: string): boolean {
  return navPath === path || (navPath !== '/' && path.startsWith(`${navPath}/`));
}

export function App() {
  const path = useHashPath();
  return (
    <>
      <header className="site-header">
        <a className="brand" href="#/">
          <span className="brand-mark">EMWS</span>
          <span className="brand-name">Electro Magnetic Works Suite</span>
        </a>
        <nav aria-label="Main">
          {NAV.map((item) => (
            <a key={item.path} href={`#${item.path}`} aria-current={isCurrent(item.path, path) ? 'page' : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
      </header>
      {/* The Smith chart spreads wider than the other tools on a big screen (styles.css). */}
      <main className={path === '/smith' ? 'main-wide' : undefined}>
        <Suspense fallback={<Loading />}>
          <Page path={path} />
        </Suspense>
      </main>
      <footer className="site-footer">
        EMWS by ZR1JT · public domain (<a href="#/about">Unlicense / CC0</a>) · everything runs in your
        browser, and nothing leaves it unless you sign in and share · 73
      </footer>
    </>
  );
}
