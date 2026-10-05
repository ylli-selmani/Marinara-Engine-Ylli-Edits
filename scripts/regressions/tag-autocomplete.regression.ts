/**
 * Tag autocomplete core (#TBD): the CSV vocabulary parser and fuzzy matcher that
 * back booru-style completion in image prompt/tag fields.
 *
 * The vocabulary is user-supplied, so the parser must tolerate the real-world
 * shapes Danbooru exports produce: quoted alias lists containing commas,
 * unquoted single aliases, empty alias columns, blank lines, and a UTF-8 BOM.
 */
import assert from "node:assert/strict";

const { applyTagCompletion, displayTagName, getTagFragmentAtCaret, matchTags, parseTagCsv, splitCsvLine } =
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

const parsed = parseTagCsv(
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

assert.equal(parseTagCsv('\uFEFF1girl,0,5,"a"')[0].name, "1girl", "a UTF-8 BOM is stripped");
assert.equal(parseTagCsv('1girl,0,5,"a"\n2girls,0,4,"b"', { limit: 1 }).length, 1, "the limit is honored");

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
);

assert.equal(matchTags(vocabulary, "long_ha", 5)[0]?.tag.name, "long_hair", "the popular prefix match ranks first");

const aliasHit = matchTags(vocabulary, "hires", 5).find((match) => match.tag.name === "highres");
assert.ok(aliasHit, "an alias query surfaces the canonical tag");
assert.equal(aliasHit.matchedAlias, "hires", "the matching alias is reported for display");

assert.equal(matchTags(vocabulary, "1girl", 5)[0]?.tag.name, "1girl", "an exact prefix outranks longer siblings");

assert.deepEqual(matchTags(vocabulary, "", 5), [], "an empty query returns no matches");
assert.deepEqual(matchTags(vocabulary, "zzzznomatch", 5), [], "a query with no subsequence returns nothing");

const subsequenceHit = matchTags(vocabulary, "lngr", 5);
assert.ok(subsequenceHit.length > 0, "fuzzy subsequence matching still finds candidates");

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
  const realTags = parseTagCsv(csvText);
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
