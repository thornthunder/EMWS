import { About } from './pages/About';
import { GuidePage, GuidesIndex } from './pages/Guides';
import { Home } from './pages/Home';
import { useHashPath } from './router';
import { AntennaModeler } from './tools/antenna-modeler/AntennaModeler';
import { SmithTool } from './tools/smith-chart/SmithTool';

const NAV = [
  { path: '/', label: 'Home' },
  { path: '/antenna', label: 'Antenna Modeler' },
  { path: '/smith', label: 'Smith Chart' },
  { path: '/guides', label: 'Field Guides' },
  { path: '/about', label: 'About' },
];

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
      <main>
        <Page path={path} />
      </main>
      <footer className="site-footer">
        EMWS by ZR1JT · public domain (<a href="#/about">Unlicense / CC0</a>) · everything runs in your
        browser, nothing is uploaded · 73
      </footer>
    </>
  );
}
