/**
 * Tag autocomplete (#TBD): the CSV vocabulary parser and fuzzy matcher that back
 * booru-style completion in image prompt/tag fields.
 *
 * The vocabulary is user-supplied, so the parser must tolerate the real-world
 * shapes Danbooru exports produce: quoted alias lists containing commas,
 * unquoted single aliases, empty alias columns, blank lines, and a UTF-8 BOM.
 *
 * Parsing lives in `packages/shared` so the client preview and any server-side
 * import agree on the same bytes; matching and caret editing stay client-side.
 */
import assert from "node:assert/strict";

const { parseTagCsv, splitTagCsvLine: splitCsvLine } = await import("../../packages/shared/src/utils/tag-csv.js");
const { applyTagCompletion, createTagIndex, displayTagName, getTagFragmentAtCaret, matchTags } =
  await import("../../packages/client/src/lib/tag-autocomplete.js");

// --- CSV field splitting ----------------------------------------------------

assert.deepEqual(
  splitCsvLine('breasts,0,5030549,"/b,breats,breast,oppai,tits,boobs"'),
  ["breasts", "0", "5030549", "/b,breats,breast,oppai,tits,boobs"],
  "a quoted alias list must survive its interior commas as one field",
);

assert.deepEqual(
  splitCsvLine("commentary_request,5,6398122,/com"),
  ["commentary_request", "5", "6398122", "/com"],
  "an unquoted single alias must parse",
);

assert.deepEqual(splitCsvLine("skirt,0,2203167,"), ["skirt", "0", "2203167", ""], "an empty alias column must parse");

assert.deepEqual(
  splitCsvLine('smile,0,4216919,":},:),smiling"'),
  ["smile", "0", "4216919", ":},:),smiling"],
  "punctuation-only aliases must parse",
);

assert.deepEqual(
  splitCsvLine('weird,0,1,"a""b"'),
  ["weird", "0", "1", 'a"b'],
  "a doubled quote must decode to one literal quote",
);

// --- Vocabulary parsing -----------------------------------------------------

const parsedFile = parseTagCsv(
  [
    '1girl,0,8496612,"sole_female,1girls"',
    "commentary_request,5,6398122,/com",
    "skirt,0,2203167,",
    "",
    "   ",
    "malformed_line_without_commas",
    'dupe,0,1,"x"',
    'dupe,0,2,"y"',
  ].join("\n"),
);
const parsed = parsedFile.tags;

assert.deepEqual(
  parsed.map((entry) => entry.name),
  ["1girl", "commentary_request", "skirt", "malformed_line_without_commas", "dupe"],
  "blank lines are skipped and duplicate names collapse to the first occurrence",
);

assert.deepEqual(parsed[0].aliases, ["sole_female", "1girls"], "quoted aliases are split");
assert.deepEqual(parsed[1].aliases, ["/com"], "an unquoted alias is kept");
assert.deepEqual(parsed[2].aliases, [], "an empty alias column yields no aliases");
assert.equal(parsed[1].category, 5, "the category column is parsed");
assert.equal(parsed[4].postCount, 1, "the first duplicate wins");

// Repairs and skips are reported rather than silently applied.
assert.equal(parsedFile.skippedRows, 1, "the duplicate row is reported as skipped");
assert.ok(
  parsedFile.issues.some((issue) => issue.code === "duplicate_name"),
  "the duplicate is reported by code",
);
assert.equal(parsedFile.repairedRows, 0, "a clean file reports no repairs");

// An unquoted comma-separated alias list splits into extra columns; the aliases
// must be rejoined rather than dropped.
{
  const repaired = parseTagCsv("hair,0,10,/h,hairstyle,hairdo");
  assert.deepEqual(repaired.tags[0]!.aliases, ["/h", "hairstyle", "hairdo"], "extra columns rejoin into aliases");
  assert.ok(repaired.repairedRows >= 1, "the repair is reported");
  assert.ok(
    repaired.issues.some((issue) => issue.code === "unquoted_aliases"),
    "the unquoted alias list is reported by code",
  );
}

assert.equal(parseTagCsv('\uFEFF1girl,0,5,"a"').tags[0]!.name, "1girl", "a UTF-8 BOM is stripped");
assert.equal(parseTagCsv('1girl,0,5,"a"\n2girls,0,4,"b"', { limit: 1 }).tags.length, 1, "the limit is honored");

// --- Caret fragment detection -----------------------------------------------

// `start` skips the separator whitespace so the space after the comma survives.
assert.deepEqual(
  getTagFragmentAtCaret("masterpiece, long_ha", 20),
  { query: "long_ha", start: 13, end: 20 },
  "the fragment runs from after the separator to the caret",
);

assert.deepEqual(
  getTagFragmentAtCaret("masterpiece,long_ha", 19),
  { query: "long_ha", start: 12, end: 19 },
  "a fragment with no separating space works too",
);

assert.deepEqual(getTagFragmentAtCaret("long_ha", 7), { query: "long_ha", start: 0, end: 7 }, "the first tag works");

assert.equal(getTagFragmentAtCaret("long_hair ", 10), null, "a trailing space closes the popup");
assert.equal(getTagFragmentAtCaret("(masterpiece:1.2", 15), null, "weight syntax must not be completed");
assert.equal(getTagFragmentAtCaret("masterpiece, ", 13), null, "an empty field has nothing to complete");

// --- Completion application -------------------------------------------------

assert.equal(
  applyTagCompletion("masterpiece, long_ha", { start: 13, end: 20 }, "long_hair").value,
  "masterpiece, long hair, ",
  "the active fragment is replaced, keeping the separator space",
);

assert.equal(
  applyTagCompletion("", { start: 0, end: 0 }, "smile_(expression)").value,
  "smile \\(expression\\), ",
  "parentheses are escaped so they are not read as weights",
);

assert.equal(
  applyTagCompletion("master, long_ha  ", { start: 8, end: 16 }, "long_hair").value,
  "master, long hair, ",
  "trailing whitespace after the fragment collapses instead of doubling up",
);

assert.equal(
  applyTagCompletion("", { start: 0, end: 0 }, "long_hair", { appendComma: false }).value,
  "long hair",
  "appending the comma is optional",
);

assert.equal(displayTagName("long_hair"), "long hair", "underscores render as spaces");

// --- Matching ---------------------------------------------------------------

const vocabulary = parseTagCsv(
  [
    '1girl,0,8496612,"sole_female,1girls"',
    'highres,5,8261366,"high_resolution,high_res,hires"',
    "long_hair,0,6274005," + '"/lh,longhair"',
    "long_hair_ornament,0,500,",
    "solo,0,7131665,",
  ].join("\n"),
).tags;

assert.equal(matchTags(vocabulary, "long_ha", 5)[0]?.tag.name, "long_hair", "the popular prefix match ranks first");

const aliasHit = matchTags(vocabulary, "hires", 5).find((match) => match.tag.name === "highres");
assert.ok(aliasHit, "an alias query surfaces the canonical tag");
assert.equal(aliasHit.matchedAlias, "hires", "the matching alias is reported for display");

assert.equal(matchTags(vocabulary, "1girl", 5)[0]?.tag.name, "1girl", "an exact prefix outranks longer siblings");

assert.deepEqual(matchTags(vocabulary, "", 5), [], "an empty query returns no matches");
assert.deepEqual(matchTags(vocabulary, "zzzznomatch", 5), [], "a query with no subsequence returns nothing");

const subsequenceHit = matchTags(vocabulary, "lngr", 5);
assert.ok(subsequenceHit.length > 0, "fuzzy subsequence matching still finds candidates");

// --- Candidate narrowing must not lose or duplicate results -----------------
//
// Both bugs below only appear once a 2-character bucket is well populated, which
// is why they need a fixture larger than the tiny ones above.

/** Builds a vocabulary with `count` filler tags sharing a 2-char prefix. */
const withFiller = (prefix: string, count: number, extra: string[]): ReturnType<typeof parseTagCsv>["tags"] =>
  parseTagCsv(
    [...Array.from({ length: count }, (_, index) => `${prefix}_filler_${index},0,${10 + index},`), ...extra].join("\n"),
  ).tags;

// A tag whose name is long and whose alias is 1 char used to land in both the
// prefix bucket and the short-key list, yielding two identical rows and a
// duplicate React key in the popup.
{
  const tags = withFiller("al", 30, ["alpha,0,10,a"]);
  const names = matchTags(tags, "al", 50).map((match) => match.tag.name);
  assert.equal(names.length, new Set(names).size, "a tag must not appear twice in one result set");
  assert.equal(names.filter((name) => name === "alpha").length, 1, "the short-alias tag appears exactly once");
}

// A subsequence match can live outside the query's bucket. Restricting the
// candidate set to a populated bucket used to make abbreviations of popular tags
// return nothing.
{
  const tags = withFiller("bh", 30, ["blue_hair_large,0,5000,"]);
  const names = matchTags(tags, "bhl", 50).map((match) => match.tag.name);
  assert.ok(names.includes("blue_hair_large"), `a fuzzy match outside a populated bucket must be found: ${names}`);
}

// --- Real-world CSV scale (opt-in) ------------------------------------------
//
// The shipped regression stays hermetic. When a real export is available on the
// machine, this additionally pins parse cost and match latency at full scale,
// which is the part a synthetic fixture cannot prove.
const realCsvPath = process.env.TAG_AUTOCOMPLETE_CSV?.trim();
if (realCsvPath) {
  const { readFileSync } = await import("node:fs");
  const csvText = readFileSync(realCsvPath, "utf8");

  const parseStarted = Date.now();
  const realTags = parseTagCsv(csvText).tags;
  const parseMs = Date.now() - parseStarted;

  assert.ok(realTags.length > 100_000, `expected a large vocabulary, got ${realTags.length}`);
  assert.ok(parseMs < 3_000, `parsing ${realTags.length} tags took ${parseMs}ms, over the 3s budget`);

  const byName = new Map(realTags.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    byName.get("breasts")?.aliases,
    ["/b", "breats", "breast", "oppai", "tits", "boobs"],
    "an alias list with interior commas must survive a real export",
  );
  assert.equal(byName.get("skirt")?.aliases.length, 0, "real entries may legitimately have no aliases");

  const matchStarted = Date.now();
  const rounds = 200;
  for (let index = 0; index < rounds; index += 1) {
    matchTags(realTags, "long_ha", 20);
  }
  const perQueryMs = (Date.now() - matchStarted) / rounds;
  assert.ok(perQueryMs < 16, `matching took ${perQueryMs.toFixed(2)}ms per query, over one frame`);

  // A full-vocabulary scan on every keystroke also has to stay inside a frame,
  // and a fuzzy abbreviation must not degrade into one.
  for (const probe of ["lngr", "bhl", "hair", "sh"]) {
    const started = Date.now();
    const queryRounds = 50;
    for (let index = 0; index < queryRounds; index += 1) {
      matchTags(realTags, probe, 20);
    }
    const perProbeMs = (Date.now() - started) / queryRounds;
    assert.ok(perProbeMs < 16, `"${probe}" took ${perProbeMs.toFixed(2)}ms per query, over one frame`);
  }

  // Building the index must not be quadratic in the vocabulary size; an O(n^2)
  // membership check made this take ~26s on a 126k-tag file.
  const indexStarted = Date.now();
  createTagIndex(realTags);
  const indexMs = Date.now() - indexStarted;
  assert.ok(indexMs < 2_000, `indexing ${realTags.length} tags took ${indexMs}ms, over the 2s budget`);

  assert.equal(matchTags(realTags, "long_ha", 5)[0]?.tag.name, "long_hair", "real prefix match ranks correctly");

  const realAliasHit = matchTags(realTags, "hires", 5).find((match) => match.tag.name === "highres");
  assert.ok(realAliasHit, "a real alias must resolve to its canonical tag");

  console.log(
    `tag-autocomplete regression passed (real CSV: ${realTags.length.toLocaleString()} tags, ` +
      `${parseMs}ms parse, ${perQueryMs.toFixed(2)}ms/query)`,
  );
} else {
  console.log("tag-autocomplete regression passed (synthetic fixture only; set TAG_AUTOCOMPLETE_CSV for scale)");
}
