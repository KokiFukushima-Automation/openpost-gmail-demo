/**
 * Pure CSV reader for campaign mail-merge imports (docs/08_phase4_spec.md §2.2). No I/O: callers
 * read the file themselves and hand this the text. RFC 4180-shaped: quoted fields, embedded
 * delimiter/CRLF/`""`, CRLF or LF line endings, a leading BOM stripped.
 */

export interface CsvParseOptions {
  /** Overrides delimiter auto-detection. */
  delimiter?: ',' | ';' | '\t';
  /** Hard cap on data rows (header excluded). Default 10 000 (CAMPAIGN_MAX_ROWS's own default). */
  maxRows?: number;
  /** Hard cap on any one cell's UTF-8 byte length. Default 8192. */
  maxCellBytes?: number;
}

export interface CsvTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  delimiter: string;
}

export class CsvError extends Error {
  readonly line: number;
  readonly column: number | null;
  constructor(message: string, line: number, column: number | null = null) {
    super(message);
    this.name = 'CsvError';
    this.line = line;
    this.column = column;
  }
}

const DEFAULT_MAX_ROWS = 10_000;
const DEFAULT_MAX_CELL_BYTES = 8192;

/** Trim, strip a leading BOM, lowercase, collapse internal whitespace. */
export function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const EMAIL_HEADER_CANDIDATES = ['email', 'e-mail', 'e mail', 'address', 'email address'];

/** Finds the email column among normalised headers: an explicit `--email-column` (matched
 *  case-insensitively against the raw header), else the first of a small set of common names.
 *  Ambiguity (more than one candidate present) or absence is an error naming `--email-column`. */
export function pickEmailColumn(headers: string[], explicit?: string): string {
  if (explicit !== undefined) {
    const idx = headers.findIndex((h) => h.toLowerCase() === explicit.toLowerCase());
    if (idx === -1) {
      throw new CsvError(`--email-column "${explicit}" is not a column in this CSV`, 0);
    }
    return headers[idx] as string;
  }
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  const matches = normalized.filter((h) => EMAIL_HEADER_CANDIDATES.includes(h.norm));
  if (matches.length === 0) {
    throw new CsvError(
      'no email column found (expected one of: email, e-mail, address) - pass --email-column',
      0,
    );
  }
  if (matches.length > 1) {
    throw new CsvError(
      `ambiguous email column: ${matches.map((m) => m.raw).join(', ')} - pass --email-column`,
      0,
    );
  }
  return matches[0]!.raw;
}

/** Splits raw CSV text into logical lines/records, honouring quoted fields that may themselves
 *  contain the delimiter, CR, LF or an escaped `""`. Returns rows of raw (unescaped) field strings
 *  plus the 1-based source line each record STARTED on (for error messages). */
function tokenize(text: string, delimiter: string): { fields: string[]; startLine: number }[] {
  const records: { fields: string[]; startLine: number }[] = [];
  let i = 0;
  const len = text.length;
  let line = 1;
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let recordStartLine = 1;
  let sawAnyCharInRecord = false;

  const pushField = (): void => {
    fields.push(field);
    field = '';
  };
  const pushRecord = (): void => {
    pushField();
    records.push({ fields, startLine: recordStartLine });
    fields = [];
    sawAnyCharInRecord = false;
  };

  while (i < len) {
    const ch = text[i] as string;
    if (!sawAnyCharInRecord) recordStartLine = line;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }

    sawAnyCharInRecord = true;
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // CRLF or lone CR: treat as a record terminator either way.
      if (text[i + 1] === '\n') i += 1;
      pushRecord();
      line += 1;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRecord();
      line += 1;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (inQuotes) {
    throw new CsvError('unterminated quoted field', recordStartLine);
  }
  // Trailing partial record (no final newline).
  if (field.length > 0 || fields.length > 0 || sawAnyCharInRecord) {
    pushRecord();
  }
  return records;
}

const DELIMITER_CANDIDATES = [',', ';', '\t'] as const;

function detectDelimiter(headerLine: string): string {
  let best: string = ',';
  let bestCount = -1;
  for (const d of DELIMITER_CANDIDATES) {
    // Count occurrences outside quotes - a cheap approximation good enough for a header line
    // (headers are rarely themselves quoted with embedded delimiters).
    let count = 0;
    let inQuotes = false;
    for (const ch of headerLine) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === d && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

/** Parses CSV text per docs/08_phase4_spec.md §2.2. Rows are built with `Object.create(null)` so a
 *  column literally named `__proto__`/`constructor` lands as an own property, never touching
 *  `Object.prototype`. */
export function parseCsv(text: string, opts: CsvParseOptions = {}): CsvTable {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCellBytes = opts.maxCellBytes ?? DEFAULT_MAX_CELL_BYTES;

  const stripped = text.replace(/^\uFEFF/, '');
  if (stripped.trim().length === 0) {
    throw new CsvError('empty file: no data rows', 1);
  }

  const firstLineEnd = stripped.search(/\r\n|\r|\n/);
  const headerLine = firstLineEnd === -1 ? stripped : stripped.slice(0, firstLineEnd);
  const delimiter = opts.delimiter ?? detectDelimiter(headerLine);

  const records = tokenize(stripped, delimiter);
  if (records.length === 0) {
    throw new CsvError('empty file: no data rows', 1);
  }

  const rawHeaders = (records[0] as { fields: string[]; startLine: number }).fields;
  const headers = rawHeaders.map((h) => h.replace(/^\uFEFF/, ''));
  const normalizedSeen = new Map<string, string>();
  for (const h of headers) {
    const norm = normalizeHeader(h);
    const existing = normalizedSeen.get(norm);
    if (existing !== undefined) {
      throw new CsvError(`duplicate header after normalisation: "${existing}" and "${h}"`, 1);
    }
    normalizedSeen.set(norm, h);
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    throw new CsvError('headers present but no data rows', 1);
  }
  if (dataRecords.length > maxRows) {
    throw new CsvError(
      `too many rows: ${dataRecords.length} exceeds the ${maxRows} limit (CAMPAIGN_MAX_ROWS)`,
      dataRecords[maxRows]?.startLine ?? dataRecords.length + 1,
    );
  }

  const rows: Array<Record<string, string>> = [];
  for (const rec of dataRecords) {
    if (rec.fields.length > headers.length) {
      throw new CsvError(
        `row has more cells (${rec.fields.length}) than headers (${headers.length})`,
        rec.startLine,
      );
    }
    const row: Record<string, string> = Object.create(null) as Record<string, string>;
    for (let c = 0; c < headers.length; c++) {
      const raw = rec.fields[c];
      if (raw === undefined) continue; // ragged short row: key absent, not empty-string.
      if (Buffer.byteLength(raw, 'utf8') > maxCellBytes) {
        throw new CsvError(`cell exceeds ${maxCellBytes} bytes`, rec.startLine, c + 1);
      }
      row[headers[c] as string] = raw;
    }
    rows.push(row);
  }

  return { headers, rows, delimiter };
}
