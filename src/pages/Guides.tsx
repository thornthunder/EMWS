import { GUIDES, guideById } from '../guides/registry';

export function GuidesIndex() {
  return (
    <div className="prose">
      <h1>Field Guides</h1>
      <p className="lede">
        How to get real work out of each tool, written for radio amateurs rather than for software people.
        Every guide is kept in step with the tool it describes.
      </p>
      <div className="cards">
        {GUIDES.map((guide) => (
          <a key={guide.id} className="card card-live" href={`#/guides/${guide.id}`}>
            <h2>{guide.title}</h2>
            <p>{guide.summary}</p>
            <span className="card-cta">Read →</span>
          </a>
        ))}
      </div>
    </div>
  );
}

export function GuidePage({ id }: { id: string }) {
  const guide = guideById(id);
  if (!guide) {
    return (
      <div className="prose">
        <h1>No such guide</h1>
        <p>
          <a href="#/guides">Back to the Field Guides</a>
        </p>
      </div>
    );
  }

  const { Content } = guide;
  return (
    <article className="prose guide">
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href="#/guides">Field Guides</a> <span aria-hidden="true">›</span> <span>{guide.title}</span>
      </nav>
      <h1>{guide.title}</h1>
      <p className="guide-tool">
        A guide to the{' '}
        <a href={guide.toolHref} className="card-cta">
          {guide.toolName} →
        </a>
      </p>
      <Content />
      <hr />
      <p className="muted">
        Found something here that no longer matches the tool? The guides are public domain like the rest of
        EMWS - <a href="https://github.com/thornthunder/EMWS">send a correction</a>.
      </p>
    </article>
  );
}
