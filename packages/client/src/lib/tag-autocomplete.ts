/**
 * Booru-style tag autocomplete: matching and caret editing for the client.
 *
 * CSV parsing lives in `@marinara-engine/shared` (`utils/tag-csv.ts`) so the same
 * rules apply wherever a vocabulary is read. This module owns what is purely
 * interactive: ranking candidates and splicing a chosen tag into the text.
 */
import {
  displayTagName,
  normalizeTagQuery,
  type TagRecord,
  // Re-exported so callers have one import site for vocabulary work.
} from "@marinara-engine/shared";

export {
  displayTagName,
  normalizeTagQuery,
  parseTagCsv,
  parseTagCsvRecords,
  splitTagCsvLine,
  TAG_CSV_MAX_CHARS,
  TAG_CSV_MAX_TAGS,
  TAG_CSV_MAX_TAG_LENGTH,
  type ParsedTagCsv,
  type TagCategory,
  type TagCsvIssue,
  type TagCsvIssueCode,
  type TagRecord,
} from "@marinara-engine/shared";

export interface TagMatch {
  tag: TagRecord;
  score: number;
  /** The alias that matched, when the match came from an alias rather than the name. */
  matchedAlias?: string;
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
    // Prefix match: an exact prefix beats a longer partial one.
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

/** Prefix length used as the index bucket key. Two characters is the sweet spot. */
const INDEX_PREFIX_LENGTH = 2;

/** Map from a 1-2 character prefix to the tags starting with it. */
export interface TagIndex {
  byPrefix: Map<string, TagRecord[]>;
  /** Tags whose name or alias contains a given pair, grouped by its first character. */
  byOpeningChar: Map<string, TagRecord[]>;
  /** Every tag whose name or alias is shorter than the prefix length. */
  short: TagRecord[];
  tags: readonly TagRecord[];
}

/**
 * Indexes a vocabulary for fast candidate lookup.
 *
 * Three structures cooperate:
 * - `byPrefix`: tags whose name or alias starts with a 2-char prefix.
 * - `short`: tags with no key long enough to bucket, kept disjoint from buckets.
 * - `byOpeningChar`: tags containing a 2-char pair, grouped by that pair's first
 *   character, used to reach fuzzy matches without scanning the whole vocabulary.
 *
 * A tag is either short-keyed or bucketed, never both, so concatenating those
 * two cannot yield the same tag twice.
 */
export function createTagIndex(tags: readonly TagRecord[]): TagIndex {
  const byPrefix = new Map<string, TagRecord[]>();
  const byOpeningChar = new Map<string, TagRecord[]>();
  const short: TagRecord[] = [];
  const seenShort = new Set<TagRecord>();

  // Membership sets mirror each list. Probing a list with `includes` is O(n) per
  // tag and turns the build quadratic — 26s over a 126k-tag vocabulary — so the
  // dedupe uses these instead, keeping the build a single linear pass.
  const prefixSeen = new Map<string, Set<TagRecord>>();

  const addToBucket = (key: string, tag: TagRecord) => {
    let bucket = byPrefix.get(key);
    let members = prefixSeen.get(key);

    if (!bucket || !members) {
      bucket = [];
      members = new Set();
      byPrefix.set(key, bucket);
      prefixSeen.set(key, members);
    }

    // A tag can reach the same bucket through its name and an alias that share
    // a 2-char prefix; keep one entry so it is not scored twice.
    if (members.has(tag)) return;
    members.add(tag);
    bucket.push(tag);
  };

  const addToOpeningChar = (opening: string, tag: TagRecord) => {
    const group = byOpeningChar.get(opening);
    if (group) {
      group.push(tag);
    } else {
      byOpeningChar.set(opening, [tag]);
    }
  };

  for (const tag of tags) {
    // A tag is only "short" when *every* key is below the prefix length;
    // otherwise its long keys already make it reachable through a bucket.
    let hasLongKey = false;

    // Openings already recorded for this tag, so it is listed once per opening
    // character however many distinct pairs it contributes. Scoped per tag to
    // keep the bookkeeping proportional to one tag rather than the vocabulary.
    const openings = new Set<string>();

    for (const key of tag.searchKeys) {
      if (key.length >= INDEX_PREFIX_LENGTH) {
        hasLongKey = true;
        addToBucket(key.slice(0, INDEX_PREFIX_LENGTH), tag);
      }

      for (let position = 0; position < key.length - 1; position += 1) {
        const opening = key[position]!;
        if (openings.has(opening)) continue;
        openings.add(opening);
        addToOpeningChar(opening, tag);
      }
    }

    if (!hasLongKey && !seenShort.has(tag)) {
      seenShort.add(tag);
      short.push(tag);
    }
  }

  return { byPrefix, byOpeningChar, short, tags };
}

/**
 * Narrows a query to the tags worth scoring.
 *
 * The bucket alone is not a sound candidate set: it holds prefix/substring hits,
 * but a fuzzy subsequence ("lngr" -> "long_hair") can live in any bucket, and
 * popular query prefixes fill their bucket while rare ones barely fill it. Gating
 * on bucket size therefore both drops results and, when the bucket looks sparse,
 * falls back to scanning the whole vocabulary on every keystroke.
 *
 * Instead the candidate set is always the union of three cheap, sound sources:
 * the query's bucket (prefix and substring hits), the short-key list, and the
 * tags containing the query's first character, which is where every subsequence
 * match must start.
 */
function collectCandidates(tags: readonly TagRecord[], query: string): readonly TagRecord[] {
  if (query.length < INDEX_PREFIX_LENGTH) return tags;

  const index = getOrBuildIndex(tags);
  const bucket = index.byPrefix.get(query.slice(0, INDEX_PREFIX_LENGTH));

  const candidates: TagRecord[] = [];
  const seen = new Set<TagRecord>();

  const add = (tag: TagRecord) => {
    if (seen.has(tag)) return;
    seen.add(tag);
    candidates.push(tag);
  };

  // Bucket entries are guaranteed prefix/substring hits.
  if (bucket) for (const tag of bucket) add(tag);
  for (const tag of index.short) add(tag);

  // For a two-character query, "is a subsequence of" and "contains" coincide, so
  // the bucket already holds every match (`short` covers tags too brief to
  // bucket). Skipping the fuzzy scan here avoids walking the first character's
  // list — most of the vocabulary — on every two-key stroke.
  if (query.length < 3) return candidates;

  // Fuzzy matches are reached through the pairs that begin with the query's
  // first character, which is a sound bound: every subsequence match must start
  // with that character, so it appears in some pair starting with it. Pair lists
  // stay discriminating where character lists do not — "h" is in roughly half
  // the vocabulary, while any given "h?" pair covers a small fraction of it.
  //
  // A match need not contain a pair adjacent *in the query* (for "bhl" the tag
  // "blue_hair_large" contains neither "bh" nor "hl"), so the seeds are scanned
  // with the exact in-order test rather than filtered by the pair.
  const seeds = index.byOpeningChar.get(query[0]!);

  if (seeds) {
    const rest = query.slice(1);

    for (const tag of seeds) {
      if (seen.has(tag)) continue;
      if (tag.searchKeys.some((key) => isSubsequence(rest, key))) add(tag);
    }
  }

  return candidates;
}

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
 * Ranks tags for a query. Returns at most `limit` matches, best first.
 *
 * Each tag is scored on its best-matching key so an alias hit still surfaces the
 * canonical tag.
 */
export function matchTags(tags: readonly TagRecord[], query: string, limit = 50): TagMatch[] {
  const normalized = normalizeTagQuery(query);
  if (!normalized) return [];

  const matches: TagMatch[] = [];

  for (const tag of collectCandidates(tags, normalized)) {
    let best = 0;
    let bestAlias: string | undefined;

    for (let index = 0; index < tag.searchKeys.length; index += 1) {
      const score = scoreTagMatch(tag.searchKeys[index]!, normalized, tag.postCount);
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

/**
 * Matches a weighted prompt segment like `1.1::toon` or `-1::2d`.
 *
 * A1111/NovelAI weight syntax prefixes a value with `n::`, so the text after the
 * separator is the actual tag and the text before it is a number we must not
 * treat as tag content.
 */
const WEIGHT_PREFIX = /^([-+]?\d*\.?\d+)\s*::/;

/**
 * Finds the tag fragment being typed at `caret`, plus the range to replace.
 *
 * Tags are comma separated, so the fragment runs from the previous comma to the
 * *end of the word under the caret* — not to the caret itself. Using the caret as
 * the end is what mangled tags: clicking into the middle and completing replaced
 * only the half before the pointer, leaving the remainder behind.
 *
 * Weight syntax is stripped from the front (`1.1::toon` completes `toon`) and
 * makes the whole segment non-completable when it is a bare number (`-1::`).
 *
 * Returns null when the caret sits in a context that is not a tag.
 */
export function getTagFragmentAtCaret(
  value: string,
  caret: number,
): { query: string; start: number; end: number } | null {
  if (caret < 0 || caret > value.length) return null;

  const before = value.slice(0, caret);
  const lastComma = before.lastIndexOf(",");
  const rawStart = lastComma + 1;

  // The word continues past the caret, so the replacement spans the whole tag.
  // Only the run up to the next whitespace or comma belongs to it.
  const after = value.slice(caret);
  const trailing = after.match(/^[^,\s]*/)?.[0] ?? "";
  const trailingSeparator = after.slice(trailing.length).match(/^\s*/)?.[0] ?? "";

  const rawFragment = before.slice(rawStart) + trailing;

  // Parenthesized weight groups are not tag names, so leave them alone.
  if (rawFragment.includes("(") || rawFragment.includes(")")) return null;

  // Skip the separator space so a weight prefix is still recognized at the start
  // of the fragment ("masterpiece, 1.15::toon").
  const fragmentIndent = rawFragment.length - rawFragment.trimStart().length;

  // Split any `1.1::` prefix off the front; the tag is what follows it.
  const weightMatch = rawFragment.slice(fragmentIndent).match(WEIGHT_PREFIX);
  const weightLength = weightMatch ? weightMatch[0].length : 0;
  const tagPart = rawFragment.slice(fragmentIndent + weightLength);

  const query = normalizeTagQuery(tagPart);
  // A segment that is only a weight value ("-1::") has no tag to complete.
  if (!query) return null;

  // Once the user types a separator without typing on, the tag is finished:
  // completing it now would fight the next tag they are starting. Text after the
  // caret means a mid-word edit, which is still completable.
  if (!trailing && /[\s,]$/.test(before)) return null;

  const leadingWhitespace = tagPart.length - tagPart.trimStart().length;

  return {
    query,
    start: rawStart + fragmentIndent + weightLength + leadingWhitespace,
    end: caret + trailing.length + trailingSeparator.length,
  };
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
  // The range covers the fragment and its trailing separator, so whatever remains
  // is the next tag. Preserve it, but don't leave two separators in a row.
  const after = value.slice(range.end);

  const needsSeparator = appendComma && !/^\s*,/.test(after);
  const insertion = `${label}${needsSeparator ? ", " : ""}`;
  const nextValue = `${before}${insertion}${after}`;

  return { value: nextValue, caret: before.length + insertion.length };
}
