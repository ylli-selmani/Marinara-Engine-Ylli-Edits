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
  normalizeTagKey,
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
 * Two tiers, matching what established booru autocompletes do: a prefix hit beats a
 * substring hit. Popular tags win ties via a small count bonus, so `1girl` surfaces
 * before an obscure tag with the same prefix.
 *
 * There is deliberately no subsequence ("fuzzy") tier. It sounds helpful but on a
 * real vocabulary it is noise: `bhl` subsequence-matches 988 tags and `ths` matches
 * 6,093, because a long query is *easier* to scatter across a long tag. It produced
 * `kingprotea_alter_(...)_(fate)` for `realistic`, and the best any ranking rule
 * could do for `bhl` was `anus`. a1111-sd-webui-tagcomplete, the tool this feature
 * is modelled on, does no fuzzy matching at all. A leading `*` gives the substring
 * behaviour explicitly instead (see `normalizeTagQuery` callers).
 */
export function scoreTagMatch(
  searchKey: string,
  query: string,
  postCount: number,
  options: { anywhere?: boolean } = {},
): number {
  if (!query) return 0;

  const index = searchKey.indexOf(query);
  let base: number;

  if (index === 0) {
    // Prefix match: an exact prefix beats a longer partial one.
    base = 1000 - Math.min(searchKey.length - query.length, 200);
  } else if (index > 0) {
    // With `*` the user asked for the text anywhere, so where it sits stops
    // mattering: a mid-word hit is scored as a prefix hit rather than being
    // demoted. Without the marker, a word-boundary substring still beats a
    // mid-word one.
    if (options.anywhere) {
      base = 1000 - Math.min(searchKey.length - query.length, 200);
    } else {
      const isWordStart = /[^a-z0-9]/.test(searchKey[index - 1] ?? "");
      base = (isWordStart ? 700 : 500) - Math.min(index, 100);
    }
  } else {
    return 0;
  }

  // Popularity bonus is deliberately small: relevance dominates, but it breaks ties.
  const popularity = postCount > 0 ? Math.min(Math.log10(postCount + 1) * 6, 60) : 0;
  return base + popularity;
}

/** Prefix length used as the index bucket key. Two characters is the sweet spot. */
const INDEX_PREFIX_LENGTH = 2;

/**
 * Match count above which the full sort is replaced by a bounded top-N selection.
 *
 * Ordinary queries return a handful of matches, where sorting everything is
 * cheapest and simplest. Broad ones do not: on a 125k vocabulary `*a` yields 95,675
 * matches and only 50 are ever shown, so ordering the rest is wasted work on the
 * keystroke path. Kept well above the popup's own limit so only genuinely broad
 * queries take the other branch.
 */
const SELECTION_THRESHOLD = 500;

/**
 * A leading `*` means "match anywhere", the convention a1111 tagcomplete uses.
 *
 * Without it every match is anchored at a word boundary, which is what makes the
 * default list short and relevant. With it, `*hair` finds `long_hair`.
 */
export function parseTagQuery(rawQuery: string): { query: string; substring: boolean } {
  const trimmed = rawQuery.trimStart();
  const substring = trimmed.startsWith("*");
  return { query: normalizeTagQuery(substring ? trimmed.slice(1) : trimmed), substring };
}

/** Map from a 1-2 character prefix to the tags starting with it. */
export interface TagIndex {
  /**
   * Tags keyed by the first two characters of each name/alias. Reaches every
   * *prefix* match, plus the substring matches whose text happens to start the key.
   */
  byPrefix: Map<string, TagRecord[]>;
  /**
   * Tags keyed by every two-character pair appearing anywhere in a name/alias.
   *
   * A substring match does NOT have to start at the key's beginning: `hair` matches
   * `long_hair`, whose first pair is `lo`. Keying candidates only by the key's own
   * prefix therefore makes such matches unreachable — measured on a 125k vocabulary,
   * `hair` found 149 of its 827 matches and never surfaced `long_hair`, the most
   * common hair tag. Every substring of length >= 2 must contain the query's first
   * pair somewhere, so this map is a sound candidate set for substring queries.
   */
  byBigram: Map<string, TagRecord[]>;
  /** Every tag whose name or alias is shorter than the prefix length. */
  short: TagRecord[];
  tags: readonly TagRecord[];
}

/**
 * Indexes a vocabulary for fast candidate lookup.
 *
 * `byPrefix` and `byBigram` partition candidate discovery by how a query can match;
 * `short` holds tags with no key long enough to bucket. Lists are deduplicated so a
 * tag reached through its name and an alias is not scored twice.
 *
 * The index exists because a 125k-tag vocabulary is queried on every keystroke;
 * tagcomplete filters a plain array, which suits its scale but not ours. Measured
 * cost at 125,865 tags: ~30ms for the prefix map, ~450ms and ~14MB for the bigram
 * map, which buys 2ms substring queries instead of 14ms and full recall instead of
 * a fifth of it. That is a deliberate trade against a one-off import cost.
 */
export function createTagIndex(tags: readonly TagRecord[]): TagIndex {
  const byPrefix = new Map<string, TagRecord[]>();
  const byBigram = new Map<string, TagRecord[]>();
  const short: TagRecord[] = [];
  const seenShort = new Set<TagRecord>();

  // Membership sets mirror each list. Probing a list with `includes` is O(n) per
  // tag and turns the build quadratic — 26s over a 126k-tag vocabulary — so the
  // dedupe uses these instead, keeping the build a single linear pass.
  const prefixSeen = new Map<string, Set<TagRecord>>();
  const bigramSeen = new Map<string, Set<TagRecord>>();

  const addTo = (
    map: Map<string, TagRecord[]>,
    membership: Map<string, Set<TagRecord>>,
    key: string,
    tag: TagRecord,
  ) => {
    let bucket = map.get(key);
    let members = membership.get(key);

    if (!bucket || !members) {
      bucket = [];
      members = new Set();
      map.set(key, bucket);
      membership.set(key, members);
    }

    // A tag can reach the same bucket more than once, through its name and an
    // alias sharing the pair; keep one entry so it is not scored twice.
    if (members.has(tag)) return;
    members.add(tag);
    bucket.push(tag);
  };

  for (const tag of tags) {
    // A tag is only "short" when *every* key is below the prefix length;
    // otherwise its long keys already make it reachable through a bucket.
    let hasLongKey = false;

    // Pairs already recorded for this tag, so a key repeating a pair does not
    // re-add it. Scoped per tag to keep the bookkeeping proportional to one tag.
    const pairs = new Set<string>();

    for (const key of tag.searchKeys) {
      if (key.length >= INDEX_PREFIX_LENGTH) {
        hasLongKey = true;
        addTo(byPrefix, prefixSeen, key.slice(0, INDEX_PREFIX_LENGTH), tag);
      }

      for (let position = 0; position < key.length - 1; position += 1) {
        const pair = key.slice(position, position + INDEX_PREFIX_LENGTH);
        if (pairs.has(pair)) continue;
        pairs.add(pair);
        addTo(byBigram, bigramSeen, pair, tag);
      }
    }

    if (!hasLongKey && !seenShort.has(tag)) {
      seenShort.add(tag);
      short.push(tag);
    }
  }

  return { byPrefix, byBigram, short, tags };
}

/**
 * Narrows a query to the tags worth scoring.
 *
 * A match can begin anywhere in a key, so the prefix bucket alone is not a sound
 * candidate set: `hair` matches `long_hair`, which is filed under `lo`. The bigram
 * map covers that case, because any substring of length >= 2 contains the query's
 * first pair somewhere. The two lists are unioned, with `short` for keys too brief
 * to bucket, so no match is reachable only by scanning the vocabulary.
 */
function collectCandidates(tags: readonly TagRecord[], query: string): readonly TagRecord[] {
  // A one-character query is below the bigram's resolution: it matches most of the
  // vocabulary, so there is no bucket to narrow by and every tag has to be scored.
  if (query.length < INDEX_PREFIX_LENGTH) return tags;

  const index = getOrBuildIndex(tags);
  const pair = query.slice(0, INDEX_PREFIX_LENGTH);

  const candidates: TagRecord[] = [];
  const seen = new Set<TagRecord>();

  const add = (tag: TagRecord) => {
    if (seen.has(tag)) return;
    seen.add(tag);
    candidates.push(tag);
  };

  // Every candidate contains the query's first pair, so this one list is both a
  // superset of the prefix bucket and the sound set for substring matches.
  const paired = index.byBigram.get(pair);
  if (paired) for (const tag of paired) add(tag);
  for (const tag of index.short) add(tag);

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
 * canonical tag. A query starting with `*` matches anywhere instead of only at a
 * word boundary.
 */
export function matchTags(tags: readonly TagRecord[], query: string, limit = 50): TagMatch[] {
  const { query: normalized, substring } = parseTagQuery(query);
  if (!normalized) return [];

  const matches: TagMatch[] = [];

  // A `*` query matches anywhere, but not arbitrarily: its first pair must appear
  // in the key, so the bigram map still bounds it. Scanning the whole vocabulary
  // instead cost 33-134ms per keystroke at 125k tags, because the entire match set
  // was built and sorted before the limit was applied.
  const candidates = collectCandidates(tags, normalized);

  for (const tag of candidates) {
    let best = 0;
    let bestAlias: string | undefined;

    for (let index = 0; index < tag.searchKeys.length; index += 1) {
      const key = tag.searchKeys[index]!;
      // `*` means "this text, wherever it appears", so a mid-word hit is scored as
      // a prefix hit instead of being demoted below word-boundary hits.
      const score = scoreTagMatch(key, normalized, tag.postCount, { anywhere: substring });

      if (score > best) {
        best = score;
        // searchKeys[0] is the canonical name; anything later is an alias.
        bestAlias = index === 0 ? undefined : key;
      }
    }

    if (best > 0) {
      matches.push({ tag, score: best, matchedAlias: bestAlias });
    }
  }

  // Sorting the full match set is what made broad queries expensive: `*a` produced
  // 95,675 matches to show 50. Only the best `limit` entries are ever returned, so
  // a bounded top-N selection replaces the full sort above a threshold.
  const compare = (a: TagMatch, b: TagMatch) => b.score - a.score || a.tag.name.localeCompare(b.tag.name);

  if (matches.length > SELECTION_THRESHOLD) {
    // Keep a running best-N: sort, truncate, and stop carrying the tail.
    const top = matches.slice(0, limit);
    top.sort(compare);

    for (let index = limit; index < matches.length; index += 1) {
      const candidate = matches[index]!;
      // One comparison against the current worst is enough to reject most entries.
      if (compare(candidate, top[top.length - 1]!) >= 0) continue;
      top.push(candidate);
      top.sort(compare);
      top.pop();
    }

    return top;
  }

  matches.sort(compare);

  return matches.slice(0, limit);
}

/**
 * Matches a weighted prompt segment like `1.1::toon`, `-1::2d`, or `2::toon::`.
 *
 * Weight syntax wraps a value in `n::`, and the closing `::` is commonly written
 * too. Both sides are syntax: only the text between them is the tag. Without
 * stripping the closing marker, a prompt written as `2::photorealistic::` left the
 * query as `photorealistic::`, which matches no tag — so every tag in a
 * double-colon prompt was uncompletable.
 *
 * The value accepts a trailing dot (`2.::tag`) and a bare dot (`.5::tag`), because
 * hand-written prompts contain both and a weight that fails to parse silently
 * becomes part of the tag name, leaving the tag uncompletable.
 */
const WEIGHT_PREFIX = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))\s*::/;
/** The closing `n::` of the same syntax, when the segment is written as `n::tag::`. */
const WEIGHT_SUFFIX = /\s*::\s*$/;

/**
 * Finds the tag fragment being typed at `caret`, plus the range to replace.
 *
 * Tags are comma separated, so a fragment runs from the previous comma to the end
 * of the segment under the caret — not to the caret itself. Using the caret as the
 * end is what mangled tags: clicking into the middle and completing replaced only
 * the half before the pointer, leaving the remainder behind.
 *
 * A space does NOT end a fragment. Real tag keys contain spaces (`blonde hair`) and
 * parentheses (`watercolor_(medium)`), so treating either as syntax made the common
 * case uncompletable: 28.2% of a Danbooru export has parentheses in the name. The
 * caller decides whether to show suggestions based on whether anything matched,
 * which closes the list exactly when there is nothing left to offer.
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

  // The segment continues past the caret, so the replacement spans the whole tag.
  // A comma is the only true terminator; spaces and parentheses belong to the tag.
  const after = value.slice(caret);
  const trailing = after.match(/^[^,]*/)?.[0] ?? "";
  const trailingSeparator = after.slice(trailing.length).match(/^\s*/)?.[0] ?? "";

  const rawFragment = before.slice(rawStart) + trailing;

  // Skip the separator space so a weight prefix is still recognized at the start
  // of the fragment ("masterpiece, 1.15::toon").
  const fragmentIndent = rawFragment.length - rawFragment.trimStart().length;

  // Split any `1.1::` prefix off the front; the tag is what follows it. The
  // closing `::` is stripped from the tag text only — the replacement range still
  // covers it, so completing `2::photorealistic::` keeps the weight wrapper.
  const weightMatch = rawFragment.slice(fragmentIndent).match(WEIGHT_PREFIX);
  const weightLength = weightMatch ? weightMatch[0].length : 0;
  const tagPart = rawFragment.slice(fragmentIndent + weightLength);
  const tagText = tagPart.replace(WEIGHT_SUFFIX, "");

  // Keep a leading `*` in the query: it means "match anywhere" and is consumed by
  // `matchTags`. The range below already starts at the `*`, so completing replaces
  // it rather than leaving it in the prompt.
  const query = normalizeTagQuery(tagText);
  // A segment that is only a weight value ("-1::") has no tag to complete.
  if (!query.replace(/^\*/, "")) return null;

  // A comma means the tag is finished: completing it would fight the next tag the
  // user is starting. A space does NOT, because tag keys contain them (`blonde
  // hair`). The caller closes the list when nothing matches, so typing a real
  // separator after a complete tag stops suggestions on its own, while `blonde `
  // keeps offering `blonde hair`.
  if (!trailing && /,$/.test(before)) return null;

  const leadingWhitespace = tagText.length - tagText.trimStart().length;

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
 * Parentheses are inserted verbatim. Escaping them is A1111 `(tag:1.2)` syntax,
 * which this app does not parse — weights here are written `1.2::tag`. Since 28.2%
 * of a Danbooru export has parentheses in the name, escaping would corrupt the tag
 * on insertion and break its own exact-match badge: `watercolor_(medium)` would be
 * written as `watercolor_\(medium\)`, which is no longer the tag.
 */
export function applyTagCompletion(
  value: string,
  range: { start: number; end: number },
  tagName: string,
  options: { appendComma?: boolean } = {},
): { value: string; caret: number } {
  const appendComma = options.appendComma ?? true;
  const label = displayTagName(tagName);

  const before = value.slice(0, range.start);
  // The range covers the fragment and its trailing separator, so whatever remains
  // is the next tag. Preserve it, but don't leave two separators in a row.
  const after = value.slice(range.end);

  const needsSeparator = appendComma && !/^\s*,/.test(after);
  const insertion = `${label}${needsSeparator ? ", " : ""}`;
  const nextValue = `${before}${insertion}${after}`;

  return { value: nextValue, caret: before.length + insertion.length };
}
