// Reads and writes NEC-2 card decks the way nec2c does (misc.c load_line, input.c
// readmn, geometry.c readgm), so that EMWS sees a deck exactly as the engine will.
//
// nec2c's rules, which differ from what people often assume:
// - A line that starts with a space or '#' is skipped entirely, as are blank lines.
// - Only the first two characters are the mnemonic; they are upper-cased.
// - Fields are separated by spaces, tabs or commas. Missing fields read as zero.
// - Integer fields may hold only digits and signs: "21.0" in an integer field is an error.
// - A line longer than 132 characters is split, and the rest is read as a new card.

export type CardSection = 'comment' | 'geometry' | 'program';

export interface Card {
  /** 1-based line number in the source text. */
  line: number;
  /** Two-letter mnemonic, upper-cased as nec2c does. */
  mnemonic: string;
  section: CardSection;
  /** The fields after the mnemonic, as written. */
  fields: string[];
  /** Everything after the mnemonic, for comment cards. */
  text: string;
  /** The line as written, trimmed. */
  raw: string;
}

export interface DeckNotice {
  line: number;
  message: string;
}

export interface LexedDeck {
  cards: Card[];
  /** Lines nec2c will read differently from how they look. */
  notices: DeckNotice[];
}

/** nec2c's input line buffer. */
export const MAX_LINE_LENGTH = 132;

/** Integer and float field counts per card: geometry cards 2 + 7, program cards 4 + 6. */
export const FIELD_LAYOUT: Record<'geometry' | 'program', { ints: number; floats: number }> = {
  geometry: { ints: 2, floats: 7 },
  program: { ints: 4, floats: 6 },
};

export function lexDeck(text: string): LexedDeck {
  const cards: Card[] = [];
  const notices: DeckNotice[] = [];
  let section: CardSection | undefined;

  const lines = text.split(/\r\n|\r|\n/);
  lines.forEach((source, index) => {
    const line = index + 1;
    if (source === '' || source.startsWith('#')) return;
    if (source.startsWith(' ')) {
      if (source.trim() !== '') {
        notices.push({ line, message: `Line ${line} starts with a space, so nec2c ignores it.` });
      }
      return;
    }
    if (source.length > MAX_LINE_LENGTH) {
      notices.push({
        line,
        message: `Line ${line} is longer than ${MAX_LINE_LENGTH} characters; nec2c reads the rest as another card.`,
      });
    }

    const mnemonic = source.slice(0, 2).toUpperCase();
    const rest = source.slice(2);

    // The deck opens with optional comment cards; CE ends them. Geometry runs up to GE.
    if (section === undefined) section = mnemonic === 'CM' || mnemonic === 'CE' ? 'comment' : 'geometry';
    const cardSection = section;
    if (section === 'comment' && mnemonic === 'CE') section = 'geometry';
    else if (section === 'geometry' && mnemonic === 'GE') section = 'program';

    cards.push({
      line,
      mnemonic,
      section: cardSection,
      fields: rest.split(/[ \t,]+/).filter((f) => f !== ''),
      text: rest.trim(),
      raw: source.trim(),
    });
  });

  return { cards, notices };
}

const INTEGER = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Integer field `index` of a card, 0 when absent (as nec2c), undefined when malformed. */
export function intField(card: Card, index: number): number | undefined {
  const token = card.fields[index];
  if (token === undefined) return 0;
  return INTEGER.test(token) ? Number.parseInt(token, 10) : undefined;
}

/** Float field `index` (counting from the first float), 0 when absent, undefined when malformed. */
export function floatField(card: Card, index: number): number | undefined {
  const layout = FIELD_LAYOUT[card.section === 'geometry' ? 'geometry' : 'program'];
  const token = card.fields[layout.ints + index];
  if (token === undefined) return 0;
  return FLOAT.test(token) ? Number(token) : undefined;
}

/** Shortest text that reads back as the same value, to 10 significant digits. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Cannot write ${value} into a NEC card`);
  if (value === 0) return '0'; // also turns -0 into 0
  return String(Number(value.toPrecision(10)));
}

export function formatCard(mnemonic: string, ints: readonly number[], floats: readonly number[] = []): string {
  for (const i of ints) {
    if (!Number.isInteger(i)) throw new RangeError(`${mnemonic} card: integer field holds ${i}`);
  }
  return [mnemonic, ...ints.map(String), ...floats.map(formatNumber)].join(' ');
}
