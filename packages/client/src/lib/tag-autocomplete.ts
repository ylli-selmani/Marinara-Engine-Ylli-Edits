/**
 * Booru-style tag autocomplete: CSV parsing + fuzzy matching.
 *
 * The tag vocabulary is always user-supplied — Marinara ships no tag data.
 * The expected CSV layout matches the a1111 tagcomplete convention:
 *
 *   <name>,<type>,<postCount>,"<aliases>"
 *
 * e.g. `long_hair,0,2898315,longhair`
 *
 * Column names are not expected, and both count and aliases are optional.
 * Multiple aliases are comma separated inside the quoted fourth column.
 */

/** Tag category, following the Danbooru tag API numbering. Used only for result coloring. */
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

export interface TagMatch {
  tag: TagRecord;
  score: number;
  /** The alias that matched, when the match came from an alias rather than the name. */
  matchedAlias?: string;
}

/**
 * Splits one CSV line into fields, honoring double-quoted values that may
 * themselves contain commas. Handles the `""` escape for a literal quote.
 */
export function splitCsvLine(line: string): string[] {
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
 * Parses a tag CSV into records. Malformed and blank lines are skipped rather
 * than failing the whole import, so a partially broken export still works.
 */
export function parseTagCsv(text: string, options: { limit?: number } = {}): TagRecord[] {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const tags: TagRecord[] = [];
  const seen = new Set<string>();

  // Strip a UTF-8 BOM, which spreadsheet exports commonly prepend.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (const rawLine of source.split(/\r?\n/)) {
    if (tags.length >= limit) break;
    const line = rawLine.trim();
    if (!line) continue;

    const fields = splitCsvLine(line);
    const name = (fields[0] ?? "").trim();
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const category = Number.parseInt((fields[1] ?? "").trim(), 10);
    const postCount = Number.parseInt((fields[2] ?? "").trim(), 10);
    const aliases = (fields[3] ?? "")
      .split(",")
      .map((alias) => alias.trim())
      .filter(Boolean);

    const searchKeys = [name, ...aliases].map((entry) => entry.toLowerCase());

    tags.push({
      name,
      category: Number.isFinite(category) ? category : 0,
      postCount: Number.isFinite(postCount) ? postCount : 0,
      aliases,
      searchKeys,
    });
  }

  return tags;
}

/**
 * Scores a candidate search key against a query. Higher is better; 0 means no match.
 *
 * Prefix matches outrank substring matches, and substring matches outrank
 * subsequence ("fuzzy") matches. Popular tags win ties via a small count bonus,
 * so `1girl` surfaces before an obscure tag with the same prefix.
 */
export function scoreTagMatch(searchKey: string, query: string, postCount: number): number {
  if (!query) return 0;

  const index = searchKey.indexOf(query);
  let base = 0;

  if (index === 0) {
    // Prefix match: exact-length prefixes beat longer partial ones.
    base = 1000 - Math.min(searchKey.length - query.length, 200);
  } else if (index > 0) {
    // Word-boundary substring beats a mid-word substring.
    const isWordStart = /[^a-z0-9]/.test(searchKey[index - 1] ?? "");
    base = (isWordStart ? 700 : 500) - Math.min(index, 100);
  } else if (isSubsequence(query, searchKey)) {
    // Fuzzy fallback: all query chars appear in order, e.g. "lngr" -> "long_hair".
    base = 200 - Math.min(searchKey.length - query.length, 150);
  } else {
    return 0;
  }

  // Popularity bonus is deliberately small: relevance dominates, but it breaks ties.
  const popularity = postCount > 0 ? Math.min(Math.log10(postCount + 1) * 6, 60) : 0;
  return base + popularity;
}

/** True when every character of `query` appears in `value` in order. */
export function isSubsequence(query: string, value: string): boolean {
  let queryIndex = 0;

  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] === query[queryIndex]) {
      queryIndex += 1;
    }
  }

  return queryIndex === query.length;
}

/**
 * Ranks tags for a query. Returns at most `limit` matches, best first.
 *
 * Each tag is scored on its best-matching key so an alias hit still surfaces the
 * canonical tag.
 *
 * A full scan over a 125k-tag export costs roughly 17ms, which drops frames while
 * typing. Building a small prefix index first (see `createTagIndex`) narrows the
 * candidate set to the tags that can actually win, so the common case only scores
 * a handful of entries.
 */
export function matchTags(tags: readonly TagRecord[], query: string, limit = 50): TagMatch[] {
  const normalized = normalizeTagQuery(query);
  if (!normalized) return [];

  const candidates = collectCandidates(tags, normalized);
  const matches: TagMatch[] = [];

  for (const tag of candidates) {
    let best = 0;
    let bestAlias: string | undefined;

    for (let index = 0; index < tag.searchKeys.length; index += 1) {
      const score = scoreTagMatch(tag.searchKeys[index], normalized, tag.postCount);
      if (score > best) {
        best = score;
        // searchKeys[0] is the canonical name; anything later is an alias.
        bestAlias = index === 0 ? undefined : tag.searchKeys[index];
      }
    }

    if (best > 0) {
      matches.push({ tag, score: best, matchedAlias: bestAlias });
    }
  }

  matches.sort((a, b) => b.score - a.score || a.tag.name.localeCompare(b.tag.name));
  return matches.slice(0, limit);
}

/** Prefix length used as the index bucket key. Two characters is the sweet spot. */
const INDEX_PREFIX_LENGTH = 2;

/** Approximate map from a 1-2 character prefix to the tags starting with it. */
export interface TagIndex {
  /** Tags bucketed by their first `INDEX_PREFIX_LENGTH` characters. */
  byPrefix: Map<string, TagRecord[]>;
  /** Every tag whose name or alias is shorter than the prefix length. */
  short: TagRecord[];
  tags: readonly TagRecord[];
}

/**
 * Builds a prefix index over a vocabulary.
 *
 * Buckets hold tags whose name *or* any alias starts with that prefix, so alias
 * queries stay fast. The index costs one pass and is meant to be built once per
 * imported vocabulary, not per keystroke.
 */
export function createTagIndex(tags: readonly TagRecord[]): TagIndex {
  const byPrefix = new Map<string, TagRecord[]>();
  const short: TagRecord[] = [];
  const bucketed = new Set<TagRecord>();

  const addToBucket = (key: string, tag: TagRecord) => {
    const bucket = byPrefix.get(key);
    if (bucket) {
      bucket.push(tag);
    } else {
      byPrefix.set(key, [tag]);
    }
  };

  for (const tag of tags) {
    let placed = false;

    for (const key of tag.searchKeys) {
      if (key.length < INDEX_PREFIX_LENGTH) {
        if (!short.includes(tag)) short.push(tag);
        placed = true;
        continue;
      }

      addToBucket(key.slice(0, INDEX_PREFIX_LENGTH), tag);
      placed = true;
    }

    if (placed) bucketed.add(tag);
  }

  return { byPrefix, short, tags };
}

/**
 * Narrows a query to the tags worth scoring.
 *
 * Prefix and substring matches live in the query's own bucket, so a populated
 * bucket is scored alone. A sparse bucket means the query is likely a fuzzy
 * subsequence ("lngr" -> "long_hair"), which can match tags in any bucket, so
 * those fall back to the full vocabulary rather than silently dropping results.
 */
function collectCandidates(tags: readonly TagRecord[], query: string): readonly TagRecord[] {
  if (query.length < INDEX_PREFIX_LENGTH) return tags;

  const index = getOrBuildIndex(tags);
  const bucket = index.byPrefix.get(query.slice(0, INDEX_PREFIX_LENGTH));

  if (!bucket) return index.short.length > 0 ? index.short : tags;
  if (bucket.length < SPARSE_BUCKET_THRESHOLD) return tags;

  return index.short.length > 0 ? [...bucket, ...index.short] : bucket;
}

/**
 * Below this many bucket entries a prefix lookup is too selective to be useful,
 * so the query is more likely fuzzy and the full scan is worth its cost.
 */
const SPARSE_BUCKET_THRESHOLD = 20;

/**
 * Caches the index against the vocabulary array identity, so repeated keystrokes
 * reuse one build. A new import produces a new array and therefore a new index.
 */
let cachedIndex: { tags: readonly TagRecord[]; index: TagIndex } | null = null;

export function getOrBuildIndex(tags: readonly TagRecord[]): TagIndex {
  if (cachedIndex && cachedIndex.tags === tags) return cachedIndex.index;
  const index = createTagIndex(tags);
  cachedIndex = { tags, index };
  return index;
}

/**
 * Finds the tag fragment being typed at `caret`, plus the range to replace.
 *
 * Tags are comma separated, so the fragment runs from the previous comma to the
 * caret. Returns null when the caret sits in an obviously non-tag context
 * (inside a parenthesized weight, or right after a newline with nothing typed).
 */
export function getTagFragmentAtCaret(
  value: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  if (caret < 0 || caret > value.length) return null;

  const before = value.slice(0, caret);
  const lastComma = before.lastIndexOf(",");
  const rawStart = lastComma + 1;
  const rawFragment = before.slice(rawStart);

  // Don't propose tags inside a weighting group like "(masterpiece:1.2".
  if (rawFragment.includes("(") || rawFragment.includes(")")) return null;

  const query = normalizeTagQuery(rawFragment);
  if (!query) return null;

  // Only complete the word currently under the caret, ignoring trailing space.
  if (/\s$/.test(rawFragment)) return null;

  // Skip the separator whitespace so the replaced range starts at the fragment
  // itself; otherwise completing "masterpiece, long_ha" would eat the space
  // after the comma and yield "masterpiece,long hair".
  const leadingWhitespace = rawFragment.length - rawFragment.trimStart().length;

  return { query, start: rawStart + leadingWhitespace, end: caret };
}

/**
 * Applies a chosen tag to the text, replacing the active fragment and appending
 * a trailing ", " so tags can be typed back to back.
 *
 * Parentheses are escaped because most backends treat them as weight syntax.
 */
export function applyTagCompletion(
  value: string,
  range: { start: number; end: number },
  tagName: string,
  options: { appendComma?: boolean } = {},
): { value: string; caret: number } {
  const appendComma = options.appendComma ?? true;
  const label = displayTagName(tagName).replace(/([()\\])/g, "\\$1");

  const before = value.slice(0, range.start);
  // Replace any trailing whitespace the user typed before the caret.
  const after = value.slice(range.end).replace(/^\s+/, "");

  const insertion = `${label}${appendComma ? ", " : ""}`;
  const nextValue = `${before}${insertion}${after}`;

  return { value: nextValue, caret: before.length + insertion.length };
}
