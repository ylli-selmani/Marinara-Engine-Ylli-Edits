// ──────────────────────────────────────────────
// Booru tag CSV vocabulary: parsing and repair.
//
// Expected layout, matching the a1111 tagcomplete convention:
//
//   <name>,<type>,<postCount>,"<aliases>"
//
// Real exports are messier than the spec: aliases may be unquoted, the alias
// column is often empty, quotes may be doubled, and a UTF-8 BOM or CRLF line
// endings are common. This parser accepts all of those and reports what it had
// to repair, so the client can preview exactly what the server will store.
//
// Parsing is pure and shared so the client can preview and the server can
// validate the same bytes with the same rules.
// ──────────────────────────────────────────────

/** Upper bound on an imported vocabulary, to keep a bad file from exhausting memory. */
export const TAG_CSV_MAX_TAGS = 500_000;
/** Upper bound on accepted file size, matching the lorebook text import budget. */
export const TAG_CSV_MAX_CHARS = 64 * 1024 * 1024;
/** Longest accepted tag name, mirroring booru tag limits. */
export const TAG_CSV_MAX_TAG_LENGTH = 200;

/** Tag category, following the Danbooru tag API numbering. Used for result coloring. */
export type TagCategory = number;

export interface TagRecord {
  /** Canonical tag as trained, underscores preserved. */
  name: string;
  category: TagCategory;
  postCount: number;
  aliases: string[];
  /** Lowercased search keys: the name plus every alias, for cheap matching. */
  searchKeys: string[];
}

export type TagCsvIssueCode =
  | "missing_name"
  | "duplicate_name"
  | "bad_category"
  | "bad_post_count"
  | "unquoted_aliases"
  | "too_many_columns"
  | "tag_too_long"
  | "tag_limit_reached";

export interface TagCsvIssue {
  code: TagCsvIssueCode;
  severity: "error" | "warning";
  /** 1-based source line, or null when the issue applies to the whole file. */
  line: number | null;
  detail?: string;
}

export interface ParsedTagCsv {
  tags: TagRecord[];
  issues: TagCsvIssue[];
  /** Rows seen, including repaired and skipped ones. */
  totalRows: number;
  /** Rows that produced a usable tag. */
  acceptedRows: number;
  /** Rows skipped because they could not yield a tag. */
  skippedRows: number;
  /** Rows that parsed but needed a repair, e.g. an unquoted alias list. */
  repairedRows: number;
}

/**
 * Splits one CSV line into fields, honoring double-quoted values that may
 * themselves contain commas. Handles the `""` escape for a literal quote.
 */
export function splitTagCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  fields.push(current);
  return fields;
}

/** Booru tags use underscores; the models were trained on spaces. */
export function displayTagName(name: string): string {
  return name.replace(/_/g, " ");
}

export function normalizeTagQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Parses a tag CSV into records, repairing the shapes real exports produce.
 *
 * Malformed and blank lines are skipped rather than failing the whole import,
 * and every skip or repair is reported so the caller can show the user what
 * happened instead of silently dropping their data.
 */
export function parseTagCsv(text: string, options: { limit?: number } = {}): ParsedTagCsv {
  const limit = Math.min(options.limit ?? TAG_CSV_MAX_TAGS, TAG_CSV_MAX_TAGS);
  const tags: TagRecord[] = [];
  const issues: TagCsvIssue[] = [];
  const seen = new Set<string>();

  let totalRows = 0;
  let skippedRows = 0;
  let repairedRows = 0;
  let limitReported = false;

  // Strip a UTF-8 BOM, which spreadsheet exports commonly prepend.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!.trim();
    if (!line) continue;

    totalRows += 1;

    if (tags.length >= limit) {
      if (!limitReported) {
        issues.push({ code: "tag_limit_reached", severity: "warning", line: lineNumber, detail: String(limit) });
        limitReported = true;
      }
      skippedRows += 1;
      continue;
    }

    const fields = splitTagCsvLine(line);
    const name = (fields[0] ?? "").trim();

    if (!name) {
      issues.push({ code: "missing_name", severity: "warning", line: lineNumber });
      skippedRows += 1;
      continue;
    }

    if (name.length > TAG_CSV_MAX_TAG_LENGTH) {
      issues.push({
        code: "tag_too_long",
        severity: "warning",
        line: lineNumber,
        detail: String(name.length),
      });
      skippedRows += 1;
      continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      issues.push({ code: "duplicate_name", severity: "warning", line: lineNumber, detail: name });
      skippedRows += 1;
      continue;
    }
    seen.add(key);

    let repaired = false;

    const rawCategory = (fields[1] ?? "").trim();
    const category = Number.parseInt(rawCategory, 10);
    if (rawCategory && !Number.isFinite(category)) {
      issues.push({ code: "bad_category", severity: "warning", line: lineNumber, detail: rawCategory });
      repaired = true;
    }

    const rawCount = (fields[2] ?? "").trim();
    const postCount = Number.parseInt(rawCount, 10);
    if (rawCount && !Number.isFinite(postCount)) {
      issues.push({ code: "bad_post_count", severity: "warning", line: lineNumber, detail: rawCount });
      repaired = true;
    }

    if (fields.length > 4) {
      // A comma inside an unquoted alias list splits into extra columns. The
      // columns after index 2 are that list, so join them back rather than
      // discarding the aliases.
      issues.push({
        code: "unquoted_aliases",
        severity: "warning",
        line: lineNumber,
        detail: String(fields.length - 3),
      });
      repaired = true;
    }

    const aliases = parseAliases(fields.slice(3).join(","));
    pushTag(tags, {
      name,
      category: Number.isFinite(category) ? category : 0,
      postCount: Number.isFinite(postCount) ? postCount : 0,
      aliases,
    });
    if (repaired) repairedRows += 1;
  }

  return { tags, issues, totalRows, acceptedRows: tags.length, skippedRows, repairedRows };
}

function parseAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function pushTag(
  tags: TagRecord[],
  input: { name: string; category: TagCategory; postCount: number; aliases: string[] },
): void {
  tags.push({
    ...input,
    searchKeys: [input.name, ...input.aliases].map((entry) => entry.toLowerCase()),
  });
}

/** Convenience accessor for callers that only want the vocabulary. */
export function parseTagCsvRecords(text: string, options: { limit?: number } = {}): TagRecord[] {
  return parseTagCsv(text, options).tags;
}
