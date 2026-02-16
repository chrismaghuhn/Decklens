// ==================== Scryfall-like Search Syntax Parser ====================
// Parses prefixed syntax from the search input:
//   o:"draw a card"  → oracle text filter
//   t:creature       → type filter
//   id:WUB           → color identity filter
//   cmc:3 / cmc>=4 / cmc<=2 → mana value filter
//   kw:flying         → keyword filter
// Remaining text (no prefix) is treated as a name/text search.

export interface ParsedSearchSyntax {
  textQuery: string;
  oracleText?: string;
  type?: string;
  colorIdentity?: string;
  cmcOp?: '=' | '>=' | '<=' | '>' | '<';
  cmcValue?: number;
  keyword?: string;
}

const SYNTAX_RE =
  /(?:^|\s)(o:|t:|id:|cmc[:<>=!]+|kw:)("(?:[^"\\]|\\.)*"|[^\s]+)/gi;

const SYNTAX_PREFIXES = /(?:^|\s)(?:o:|t:|id:|cmc[:<>=]|kw:)/i;

/** Quick check: does the input contain any syntax prefixes? */
export function hasSyntaxPrefixes(input: string): boolean {
  return SYNTAX_PREFIXES.test(input);
}

/** Parse Scryfall-like syntax from input, returning structured filters + remaining text. */
export function parseSearchSyntax(input: string): ParsedSearchSyntax {
  const result: ParsedSearchSyntax = { textQuery: '' };
  let remaining = input;

  // Extract all prefix:value pairs
  const matches: Array<{ full: string; prefix: string; value: string }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SYNTAX_RE.source, 'gi');

  while ((m = re.exec(input)) !== null) {
    const prefix = m[1].toLowerCase().trim();
    let value = m[2];
    // Strip surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    matches.push({ full: m[0], prefix, value });
  }

  for (const { full, prefix, value } of matches) {
    remaining = remaining.replace(full, ' ');

    if (prefix === 'o:') {
      result.oracleText = value;
    } else if (prefix === 't:') {
      result.type = value;
    } else if (prefix === 'id:') {
      result.colorIdentity = value.toUpperCase();
    } else if (prefix === 'kw:') {
      result.keyword = value;
    } else if (prefix.startsWith('cmc')) {
      // Parse operator: cmc:3, cmc>=4, cmc<=2, cmc>3, cmc<2
      const opMatch = prefix.match(/cmc([><=!]{0,2}):?/);
      let op: ParsedSearchSyntax['cmcOp'] = '=';
      if (opMatch && opMatch[1]) {
        const raw = opMatch[1];
        if (raw === '>=' || raw === '<=' || raw === '>' || raw === '<') {
          op = raw;
        }
      }
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
        result.cmcOp = op;
        result.cmcValue = num;
      }
    }
  }

  result.textQuery = remaining.replace(/\s+/g, ' ').trim();
  return result;
}
