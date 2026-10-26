// One stylesheet serves every tool, so a rule written for one part of the app reaches any
// other part that happens to use the same class name. Three such collisions went unseen
// for weeks, each with every functional test passing (found 2026-10-24):
//   - .chain-panel: the Smith chart's wide-screen columns squeezed the balun tool's design
//     panel, which used the same name, into crushed columns from 1440 px up;
//   - .guide: the SWR chart's dashed 2:1 lines were drawn at 55 % opacity, and so was every
//     Field Guide article, which carries the class "guide";
//   - .pad-wire / .pad-label: the toolbox's attenuator drawing restyled the balun tool's
//     winding pad, whose labels shrank and darkened.
// The rule this test holds: a class name used in more than one part of the app is either
// one of the suite's shared building blocks (listed below, on purpose), or every rule that
// styles it is scoped beneath something else (".smith .chain-panel").

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Classes meant to look the same wherever they appear. Add to this only on purpose. */
const SHARED = new Set([
  'alert-inline', 'badge', 'band-buttons', 'band-table', 'build-card', 'button-row', 'chart-readout', 'chart-title',
  'check', 'danger', 'feed-table', 'field', 'field-input', 'field-label', 'field-row', 'form-section', 'hit', 'issue',
  'issue-mark', 'issue-text', 'issues', 'lede', 'link', 'modeler', 'muted', 'page-header', 'panel', 'parts-table',
  'peak-line', 'plot', 'plot-label', 'plot-note', 'primary', 'prose', 'results-title', 'section-head', 'segmented',
  'side-panel', 'small', 'small-segmented', 'summary', 'tab-body', 'tab-link', 'table-wrap', 'tabs', 'visually-hidden',
  'vna', 'workspace',
]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** tools/<tool> for a tool, otherwise the top folder under src (pages, ui, guides) or the file. */
function area(file: string): string {
  const parts = relative('src', file).split(sep);
  return parts[0] === 'tools' ? `tools/${parts[1]}` : parts[0]!;
}

/** Every class name a file sets: literal strings, template literals, and the strings in a ternary. */
function classNames(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\}|\{"([^"]+)"\})/g)) {
    found.push(...(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/));
  }
  for (const m of text.matchAll(/className=\{[^}]*\}/g)) {
    for (const s of m[0].matchAll(/'([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)'/g)) found.push(...s[1]!.split(' '));
  }
  return found.filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
}

const classPattern = (name: string) => new RegExp(`\\.${name}(?![a-z0-9-])`);

/** Does the selector mention the class anywhere? */
function mentions(selector: string, name: string): boolean {
  return classPattern(name).test(selector);
}

/** Scoped: the class is not in the first compound selector, so something else must match first. */
function scoped(selector: string, name: string): boolean {
  return !classPattern(name).test(selector.split(/[\s>+~]+/)[0]!);
}

/** Each selector in the stylesheet, comments removed, @-rule headers skipped. */
function selectors(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .flatMap((m) => m[1]!.split(','))
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('@'));
}

describe('class names shared between parts of the app', () => {
  it('are either shared building blocks or styled only under a scope', () => {
    const uses = new Map<string, Set<string>>();
    for (const file of tsxFiles('src')) {
      for (const name of classNames(readFileSync(file, 'utf8'))) {
        if (!uses.has(name)) uses.set(name, new Set());
        uses.get(name)!.add(area(file));
      }
    }
    const rules = selectors(readFileSync('src/styles.css', 'utf8'));
    const collisions: string[] = [];
    for (const [name, areas] of uses) {
      if (areas.size < 2 || SHARED.has(name)) continue;
      // Unscoped: the class sits in the selector's first compound, so the rule applies wherever it appears.
      const unscoped = rules.filter((s) => mentions(s, name) && !scoped(s, name));
      if (unscoped.length) collisions.push(`.${name} is used in ${[...areas].sort().join(' and ')}, and styled for all of them by: ${unscoped.join(' | ')}`);
    }
    expect(collisions).toEqual([]);
  });

  it('would have caught the three collisions it was written after', () => {
    // The checker's own logic, on miniature versions of what went wrong.
    expect(scoped('.chain-panel', 'chain-panel')).toBe(false);
    expect(scoped('.guide', 'guide')).toBe(false);
    expect(scoped('.pad-label', 'pad-label')).toBe(false);
    expect(scoped('.smith .chain-panel', 'chain-panel')).toBe(true);
    expect(scoped('.pad-figure .pad-label', 'pad-label')).toBe(true);
    expect(classNames('<div className="prose guide">')).toEqual(['prose', 'guide']);
    expect(classNames("<li className={hit ? 'imd-hit' : undefined}>")).toEqual(['imd-hit']);
  });
});
