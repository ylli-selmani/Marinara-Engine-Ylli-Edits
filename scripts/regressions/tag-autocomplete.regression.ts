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
const {
  applyTagCompletion,
  comparableTagName,
  createTagIndex,
  displayTagName,
  getTagFragmentAtCaret,
  matchTags,
  sameTagName,
} = await import("../../packages/client/src/lib/tag-autocomplete.js");

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
  { query: "long ha", start: 13, end: 20 },
  "the fragment runs from after the separator to the caret",
);

assert.deepEqual(
  getTagFragmentAtCaret("masterpiece,long_ha", 19),
  { query: "long ha", start: 12, end: 19 },
  "a fragment with no separating space works too",
);

assert.deepEqual(getTagFragmentAtCaret("long_ha", 7), { query: "long ha", start: 0, end: 7 }, "the first tag works");

// A trailing space keeps the fragment open, because a space is part of real tag
// keys (`blonde hair`). Suggestions stop when nothing matches, not on the space.
assert.deepEqual(
  getTagFragmentAtCaret("long_hair ", 10),
  { query: "long hair", start: 0, end: 10 },
  "a trailing space keeps the fragment open",
);
// Parentheses are part of a tag name in every real export, so they complete like
// any other character. Only `n::` carries weight syntax here.
assert.deepEqual(
  getTagFragmentAtCaret("watercolor_(medium", 18),
  { query: "watercolor (medium", start: 0, end: 18 },
  "an unclosed parenthesis is still a completable tag",
);
assert.equal(getTagFragmentAtCaret("masterpiece, ", 13), null, "an empty field has nothing to complete");

// --- Caret in the middle of a word -------------------------------------------
// The fragment must span the whole tag, not stop at the caret. Ending at the
// caret is what previously cut a tag in half and left the tail behind.

assert.deepEqual(
  getTagFragmentAtCaret("long_hair", 4),
  { query: "long hair", start: 0, end: 9 },
  "clicking mid-tag selects the entire tag for replacement",
);

assert.deepEqual(
  getTagFragmentAtCaret("masterpiece, long_hair, solo", 17),
  { query: "long hair", start: 13, end: 22 },
  "a mid-tag caret spans only that tag, not the neighbours",
);

// Completing from a mid-word caret must replace the whole tag and keep the rest.
assert.equal(
  applyTagCompletion("long_hair, solo", getTagFragmentAtCaret("long_hair, solo", 4)!, "blue_hair").value,
  "blue hair, solo",
  "a mid-tag completion replaces the whole tag and preserves the remainder",
);

// --- Weight syntax -----------------------------------------------------------
// `1.1::toon` is a weight prefix plus a tag; only the tag is completed.

assert.deepEqual(
  getTagFragmentAtCaret("-1::toon", 8),
  { query: "toon", start: 4, end: 8 },
  "a negative weight prefix is stripped before matching",
);

assert.deepEqual(
  getTagFragmentAtCaret("1.1::toon", 8),
  { query: "toon", start: 5, end: 9 },
  "a positive weight prefix is stripped before matching",
);

assert.equal(getTagFragmentAtCaret("-1::", 4), null, "a bare weight value has no tag to complete");

assert.deepEqual(
  getTagFragmentAtCaret("masterpiece, 1.15::toon", 22),
  { query: "toon", start: 19, end: 23 },
  "weight syntax after another tag resolves to the tag after the prefix",
);

// --- Closing weight marker ---------------------------------------------------
// Weight syntax wraps the tag: `2::photorealistic::`. Both markers are syntax, so
// only the text between them is the tag. Leaving the closing `::` in the query made
// every tag in a double-colon prompt uncompletable, since `photorealistic::` matches
// no tag in the vocabulary.
assert.deepEqual(
  getTagFragmentAtCaret("2::photorealistic::", 19),
  { query: "photorealistic", start: 3, end: 19 },
  "the closing weight marker is stripped from the query but stays inside the range",
);

// The range must still cover the closing marker, so completing keeps the wrapper
// and does not leave a stray `::` behind the inserted tag.
assert.equal(
  applyTagCompletion("2::photorealistic::", getTagFragmentAtCaret("2::photorealistic::", 19)!, "photorealistic").value,
  "2::photorealistic, ",
  "completing a wrapped tag replaces the whole wrapper, not part of it",
);

assert.deepEqual(
  getTagFragmentAtCaret("2::photorealistic", 17),
  { query: "photorealistic", start: 3, end: 17 },
  "an unclosed weight wrapper completes the tag inside it",
);

// A negative weight, a decimal weight, and a bare marker must all behave sensibly.
assert.equal(getTagFragmentAtCaret("2::", 3), null, "a weight with no tag has nothing to complete");
assert.equal(getTagFragmentAtCaret("-1::", 4), null, "a negative weight with no tag has nothing to complete");
assert.deepEqual(
  getTagFragmentAtCaret("-0.8::toon (style)", 18),
  { query: "toon (style)", start: 6, end: 18 },
  "a negative decimal weight resolves the parenthesized tag after it",
);

// A comma inside a weighted group starts a new tag, and that tag completes.
assert.deepEqual(
  getTagFragmentAtCaret("2::pornhwa, manhwa::", 20),
  { query: "manhwa", start: 12, end: 20 },
  "a tag mid-list inside a weight group is completable",
);

// A comma typed before the closing marker leaves that marker stranded in front of
// the next tag. The leftover `::` used to become part of the query, so the tag after
// it matched nothing at all.
//
// The range starts at the tag, not at the stranded marker: rewriting text the user
// already typed before the caret is riskier than leaving their own typo in place, and
// the query is what has to be right for suggestions to appear.
assert.deepEqual(
  getTagFragmentAtCaret("0.8::depth of field,:: blonde", 29),
  { query: "blonde", start: 23, end: 29 },
  "a closing marker stranded after a comma does not poison the next query",
);
assert.deepEqual(
  getTagFragmentAtCaret("2::pornhwa,::manhwa", 19),
  { query: "manhwa", start: 13, end: 19 },
  "a stranded marker with no space still resolves the next tag",
);

// Only the doubled colon is syntax. A single colon is real tag content, so it must
// survive into the query or those tags become unsearchable.
assert.deepEqual(
  getTagFragmentAtCaret("re:zero", 7),
  { query: "re:zero", start: 0, end: 7 },
  "a single colon stays part of the tag name",
);

// Brace and bracket emphasis are syntax too, not tag content. NovelAI scales attention
// with `{tag}` / `[tag]` at 1.05x per level, so `{{blonde` is a normal thing to type —
// and before this was handled the query became `{blonde`, which matched nothing.
{
  const emphasized: Array<[string, string]> = [
    ["{{blonde", "blonde"],
    ["{{{blonde", "blonde"],
    ["[[blonde", "blonde"],
    ["[[[blonde", "blonde"],
    ["{{blonde}}", "blonde"],
    ["masterpiece, {{blonde", "blonde"],
    ["1.2::{{blonde", "blonde"],
    ["[[long hair", "long hair"],
  ];
  for (const [text, query] of emphasized) {
    assert.equal(
      getTagFragmentAtCaret(text, text.length)?.query,
      query,
      `${JSON.stringify(text)} should search for the tag inside the emphasis`,
    );
  }

  // The leading run is skipped, not replaced, so completing keeps the emphasis the user
  // typed. A run of any length counts: matching only pairs left the third brace of `{{{`
  // inside the replaced range.
  assert.deepEqual(
    getTagFragmentAtCaret("{{blonde", 8),
    { query: "blonde", start: 2, end: 8 },
    "the opening braces are left out of the replaced range",
  );
  assert.deepEqual(
    getTagFragmentAtCaret("{{{blonde", 9),
    { query: "blonde", start: 3, end: 9 },
    "every brace in the opening run is skipped",
  );

  // Completing inside emphasis must preserve it, the same way it preserves a weight.
  // `applyTagCompletion` inserts the display form, so underscores become spaces.
  assert.equal(
    applyTagCompletion("{{blonde", getTagFragmentAtCaret("{{blonde", 8)!, "blonde_hair").value,
    "{{blonde hair, ",
    "completing inside braces keeps the braces",
  );
  assert.equal(
    applyTagCompletion("[[blonde", getTagFragmentAtCaret("[[blonde", 8)!, "blonde_hair").value,
    "[[blonde hair, ",
    "completing inside brackets keeps the brackets",
  );
  // Emphasis and a weight on the same segment: both wrappers survive.
  assert.equal(
    applyTagCompletion("1.2::{{blonde", getTagFragmentAtCaret("1.2::{{blonde", 13)!, "blonde_hair").value,
    "1.2::{{blonde hair, ",
    "a weight and emphasis are both preserved",
  );
}

// Every weight spelling people actually write must parse. A weight that fails to
// parse silently becomes part of the tag name, leaving the tag uncompletable with
// no visible reason why — which is exactly how `2.::photorealistic::` broke.
{
  const weightForms: Array<[string, string, number]> = [
    ["2::photorealistic::", "integer with closing marker", 3],
    ["2.::photorealistic::", "trailing-dot weight", 4],
    ["2.5::photorealistic::", "decimal weight", 5],
    [".5::photorealistic::", "bare-dot weight", 4],
    ["-1::photorealistic::", "negative weight", 4],
    ["+1::photorealistic::", "explicitly positive weight", 4],
  ];

  for (const [text, label, expectedStart] of weightForms) {
    const fragment = getTagFragmentAtCaret(text, text.length);
    assert.ok(fragment, `${label} must be completable`);
    assert.equal(fragment.query, "photorealistic", `${label} resolves to the tag`);
    assert.equal(fragment.start, expectedStart, `${label} starts the range at the tag, not inside the weight`);
  }

  // The range must cover the closing marker, so completing keeps the wrapper.
  assert.equal(
    applyTagCompletion("2.::photorealistic::", getTagFragmentAtCaret("2.::photorealistic::", 20)!, "photorealistic")
      .value,
    "2.::photorealistic, ",
    "completing replaces the whole wrapper, leaving no stray marker",
  );

  // Weights with no tag inside them have nothing to complete.
  for (const text of ["2::", "2.::", "-1::", ".5::"]) {
    assert.equal(getTagFragmentAtCaret(text, text.length), null, `${JSON.stringify(text)} has no tag to complete`);
  }
}

// A completion must not double up a separator that is already present.
assert.equal(
  applyTagCompletion("long_ha, solo", { start: 0, end: 7 }, "long_hair").value,
  "long hair, solo",
  "an existing separator is not duplicated",
);

// --- Completion application -------------------------------------------------

assert.equal(
  applyTagCompletion("masterpiece, long_ha", { start: 13, end: 20 }, "long_hair").value,
  "masterpiece, long hair, ",
  "the active fragment is replaced, keeping the separator space",
);

assert.equal(
  applyTagCompletion("", { start: 0, end: 0 }, "smile_(expression)").value,
  "smile (expression), ",
  "parentheses are inserted verbatim so the tag matches the vocabulary",
);

// The range is derived from the same helper the hook uses, so this pins the real
// pairing rather than a hand-written range that no longer occurs.
assert.equal(
  applyTagCompletion("master, long_ha  ", getTagFragmentAtCaret("master, long_ha  ", 14)!, "long_hair").value,
  "master, long hair, ",
  "trailing whitespace after the fragment is consumed, not doubled",
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
    // Multi-word and parenthesized names, as a real export stores them.
    "blonde_hair,0,2195202,",
    "watercolor_(medium),0,22992,",
    "watercolor_pencil_(medium),0,838,",
  ].join("\n"),
).tags;

assert.equal(matchTags(vocabulary, "long_ha", 5)[0]?.tag.name, "long_hair", "the popular prefix match ranks first");

const aliasHit = matchTags(vocabulary, "hires", 5).find((match) => match.tag.name === "highres");
assert.ok(aliasHit, "an alias query surfaces the canonical tag");
assert.equal(aliasHit.matchedAlias, "hires", "the matching alias is reported for display");

// The "you already wrote this" badge is an identity claim about the user's text, so
// it uses the stricter comparison. The punctuation-blind one it used to share with
// alias suppression conflates genuinely different tags — it maps `bluesky` onto
// `blue_sky`, `blood` onto `blood+` and `witch` onto `w.i.t.c.h.`, all pairs of
// distinct real tags (135 such collision groups exist in a real export). Badging one
// of those would tell the user their text is something it is not.
{
  // Same tag, punctuation typed differently: these must still be recognized.
  const sameAsWritten: Array<[string, string]> = [
    ["watercolor pencil medium", "watercolor_pencil_(medium)"],
    ["watercolor pencil (medium)", "watercolor_pencil_(medium)"],
    ["blonde hair", "blonde_hair"],
    ["Blonde Hair", "blonde_hair"],
    ["blue eyes", "blue-eyes"],
    ["the idolmaster", "the_idolmaster"],
  ];
  for (const [typed, canonical] of sameAsWritten) {
    assert.equal(sameTagName(typed, canonical), true, `"${typed}" is the tag ${canonical}`);
  }

  // Distinct real tags that the lossy comparison would have merged. Each of these
  // pairs exists as two separate tags in a Danbooru export.
  const distinct: Array<[string, string]> = [
    ["bluesky", "blue_sky"],
    ["foxtail", "fox_tail"],
    ["cattail", "cat_tail"],
    ["blood", "blood+"],
    ["witch", "w.i.t.c.h."],
    ["teapot", "tea/pot"],
    ["denim", "deni_m"],
    ["snow", "s-now"],
    ["re:zero", "rezero"],
  ];
  for (const [typed, other] of distinct) {
    assert.equal(sameTagName(typed, other), false, `"${typed}" is not the tag ${other}`);
  }

  // A bracket that OPENS a name is the tag's identity, not a qualifier wrapper, so it must
  // not be dropped. Unconditionally stripping brackets merged these separate tags, which is
  // the same class of false positive the list above guards against.
  const leadingBracketIsContent: Array<[string, string]> = [
    ["(cosplay)", "cosplay"],
    ["[artist]_name", "artist name"],
    ["a", "(a)"],
    ["a", "[a]"],
  ];
  for (const [typed, other] of leadingBracketIsContent) {
    assert.equal(
      sameTagName(typed, other),
      false,
      `a leading bracket is content, so "${typed}" is not the tag ${other}`,
    );
  }

  // A TRAILING bracket is a qualifier wrapper, and the word inside it is what a person
  // keeps when typing by hand — so the bracketed and unbracketed spellings are the same
  // tag. This is the case that forbids the simpler "drop every bracket" rule.
  const trailingBracketIsWrapper: Array<[string, string]> = [
    ["school_(uniform)", "school uniform"],
    ["sword_(weapon)", "sword weapon"],
  ];
  for (const [a, b] of trailingBracketIsWrapper) {
    assert.equal(sameTagName(a, b), true, `"${a}" is the tag ${b}`);
  }

  // The lossy comparison is still the right one for deciding whether an alias adds
  // information, which is why both functions exist.
  assert.equal(
    comparableTagName("blondehair"),
    comparableTagName("blonde_hair"),
    "the alias comparison still treats a punctuation-only restatement as redundant",
  );
}

// An alias that only restates the name is not worth a row slot. Exports carry a
// punctuation-free spelling beside the real name, and because it scores at least as
// well it used to be displayed — so `blonde_hair` rendered as "blonde hair" followed
// by "blondehair", the same text twice, both truncated, with the name losing a
// quarter of the row to the repeat. 468 of the aliases in a real export are like this.
{
  const redundant = parseTagCsv(
    ["name,postCount,category,aliases", "blonde_hair,2195202,0,blondehair", "blue_eyes,800000,0,blueeyes"].join("\n"),
  ).tags;

  for (const query of ["blonde", "blondeh", "blue"]) {
    const match = matchTags(redundant, query, 5)[0];
    assert.ok(match, `"${query}" should match a tag`);
    assert.equal(
      match.matchedAlias,
      undefined,
      `a punctuation-only alias must not be shown beside the name (query was "${query}")`,
    );
  }

  // The alias must still be *searchable*: suppressing it for display must not make
  // the tag unfindable by the spelling someone actually typed.
  const byAlias = matchTags(redundant, "blondehair", 5);
  assert.equal(byAlias[0]?.tag.name, "blonde_hair", "the alias still finds the tag it belongs to");

  // A genuinely different alias is unaffected.
  const distinct = parseTagCsv(
    ["name,postCount,category,aliases", "colored_eyelashes,59782,0,blonde_eyelashes"].join("\n"),
  ).tags;
  const distinctMatch = matchTags(distinct, "blonde eyelashes", 5)[0];
  assert.equal(distinctMatch?.tag.name, "colored_eyelashes", "a distinct alias still finds its tag");
  assert.equal(distinctMatch?.matchedAlias, "blonde eyelashes", "a distinct alias is still shown for display");
}

assert.equal(matchTags(vocabulary, "1girl", 5)[0]?.tag.name, "1girl", "an exact prefix outranks longer siblings");

assert.deepEqual(matchTags(vocabulary, "", 5), [], "an empty query returns no matches");
assert.deepEqual(matchTags(vocabulary, "zzzznomatch", 5), [], "an unmatched query returns nothing");

// --- No subsequence ("fuzzy") tier -------------------------------------------
//
// A subsequence tier let query letters match a tag in order, skipping characters.
// On a real vocabulary that is noise, not recall: `realistic` matched
// `kingprotea_alter_(swimsuit_avenger)_(first_ascension)_(fate)`, `bhl` matched 988
// tags (best available answer: `anus`), and `lngr` returned `\||/` rather than
// `long_hair`. a1111-sd-webui-tagcomplete, which this feature follows, does no
// fuzzy matching at all. These assertions pin its absence, so it cannot creep back.
{
  const tags = parseTagCsv(
    [
      "long_hair,0,6274005,",
      "anus,0,170793,",
      "realistic,0,32900,",
      "realistic_teeth,0,424,",
      "photorealistic,0,1807,",
      "kingprotea_alter_(swimsuit_avenger)_(first_ascension)_(fate),0,57,",
    ].join("\n"),
  ).tags;

  // `lngr` is a subsequence of `long_hair` but not a substring of it.
  assert.deepEqual(matchTags(tags, "lngr", 5), [], "scattered letters must not match a tag");
  // `bhl` likewise: no tag contains it literally.
  assert.deepEqual(matchTags(tags, "bhl", 5), [], "an abbreviation with no literal hit returns nothing");

  const longWordNames = matchTags(tags, "realistic", 20).map((match) => match.tag.name);
  assert.ok(
    !longWordNames.includes("kingprotea_alter_(swimsuit_avenger)_(first_ascension)_(fate)"),
    `a complete word must not match on scattered letters alone: ${longWordNames}`,
  );
  assert.equal(longWordNames[0], "realistic", "the exact tag still ranks first for its own name");

  // Prefix beats a mid-word substring, and a word-boundary substring beats a
  // mid-word one. `hair` appears mid-word in `long_hair`.
  assert.equal(matchTags(tags, "long", 5)[0]?.tag.name, "long_hair", "a prefix hit ranks first");
}

// --- Leading `*` means "match anywhere" --------------------------------------
//
// The a1111 convention, and the supported way to search inside a tag now that
// there is no fuzzy tier. Without `*`, matching stays anchored at a word boundary.
{
  const tags = parseTagCsv(
    [
      "long_hair,0,6274005,",
      "short_hair,0,900000,",
      "hair_ornament,0,500000,",
      "chair,0,30000,",
      "unrelated,0,10,",
    ].join("\n"),
  ).tags;

  // A bare query matches mid-word, but ranks word-boundary hits above mid-word
  // ones. In `long_hair` the `air` follows `_`, which counts as a boundary, so it
  // leads; in `chair` it is mid-word and trails. `*` flattens that distinction.
  const bare = matchTags(tags, "air", 10);
  const bareNames = bare.map((match) => match.tag.name);
  assert.ok(bareNames.includes("chair"), `a bare query still reaches a mid-word hit: ${bareNames}`);
  assert.ok(
    bareNames.indexOf("long_hair") < bareNames.indexOf("chair"),
    `a word-boundary hit must outrank a mid-word one without "*": ${bareNames}`,
  );

  const bareLongHair = bare.find((match) => match.tag.name === "long_hair")!;
  const starredLongHair = matchTags(tags, "*air", 10).find((match) => match.tag.name === "long_hair")!;
  const bareChair = bare.find((match) => match.tag.name === "chair")!;
  const starredChair = matchTags(tags, "*air", 10).find((match) => match.tag.name === "chair")!;

  assert.ok(
    starredChair.score > bareChair.score,
    `"*" must lift a mid-word hit toward the prefix tier (${bareChair.score} -> ${starredChair.score})`,
  );
  // With the marker the two are compared on the same footing, so popularity (not
  // where the text sits) decides. Without it, position dominated.
  assert.ok(
    starredChair.score >= starredLongHair.score - 10,
    `"*" must put a mid-word hit on the same footing as a boundary one (${starredChair.score} vs ${starredLongHair.score})`,
  );

  const starred = matchTags(tags, "*air", 10).map((match) => match.tag.name);
  assert.ok(starred.includes("long_hair"), `"*air" must find a mid-word hit: ${starred}`);
  assert.ok(starred.includes("chair"), `"*air" must find every mid-word hit: ${starred}`);

  // The marker must not leak into the query: `*hair` is the query `hair`, not `*hair`.
  const starredHair = matchTags(tags, "*hair", 10);
  assert.ok(starredHair.length > 0, `"*hair" must match: ${starredHair.length}`);
  assert.ok(
    starredHair.every((match) => match.tag.searchKeys.some((key) => key.includes("hair"))),
    'every result for "*hair" must actually contain the text',
  );

  // A `*` with nothing after it is not a query.
  assert.deepEqual(matchTags(tags, "*", 5), [], "a lone marker returns nothing");
  // `*` puts every hit on the same footing, so where the text sits stops mattering
  // and popularity decides: `long_hair` (6.27M posts) leads even though `hair` is a
  // trailing suffix there, while `hair_ornament` (500k) drops to last despite being
  // the only true prefix hit. That inversion is the marker doing its job.
  const starredHairTop = matchTags(tags, "*hair", 5);
  assert.equal(starredHairTop[0]?.tag.name, "long_hair", 'with "*", popularity decides instead of position');
  assert.equal(matchTags(tags, "hair", 5)[0]?.tag.name, "hair_ornament", 'without "*", a prefix hit leads');
  assert.ok(
    starredHairTop.every((match) => match.score >= 1000),
    'every "*" hit is scored on the prefix tier',
  );
}

// --- Spaces and parentheses are tag content, not syntax -----------------------
// Real exports store `watercolor_(medium)` and `blonde_hair` — a space and a
// parenthesis are part of the key. Treating either as a separator made the common
// case uncompletable: 28.2% of a Danbooru export has parentheses in the name, and
// `blonde ` closed the popup right when `blonde hair` was the answer.
{
  // A trailing space must NOT end the fragment.
  const spaced = getTagFragmentAtCaret("blonde ", 7);
  assert.ok(spaced, "a trailing space does not end the fragment");
  assert.equal(spaced.query, "blonde", "the trailing space is trimmed from the query");
  assert.ok(
    matchTags(vocabulary, spaced.query, 3).some((match) => match.tag.name === "blonde_hair"),
    '"blonde " still suggests blonde_hair',
  );

  // A comma DOES end it: the tag is finished and the next one is starting.
  assert.equal(getTagFragmentAtCaret("masterpiece, ", 13), null, "a trailing comma ends the fragment");

  // Parentheses are part of the name, so they must be completable.
  const parenthesized = "watercolor pencil (medium)";
  const parenFragment = getTagFragmentAtCaret(parenthesized, parenthesized.length);
  assert.ok(parenFragment, "a parenthesized tag is completable");
  assert.equal(parenFragment.query, parenthesized, "the parenthesized text is the query");

  // Clicking into the middle of a multi-word tag resolves the WHOLE tag, so
  // completing it replaces all of it rather than leaving a fragment behind.
  const midCaret = parenthesized.indexOf("medium") + "medium".length;
  const midFragment = getTagFragmentAtCaret(parenthesized, midCaret);
  assert.ok(midFragment, "a caret inside a multi-word tag is completable");
  assert.equal(midFragment.query, parenthesized, "a mid-tag caret resolves the whole tag");
  assert.equal(midFragment.start, 0, "the replacement starts at the beginning of the tag");

  // Completion inserts the tag verbatim. Escaping `(` here would be A1111 `(tag:1.2)`
  // syntax, which this app does not parse — weights are `1.2::tag` — and it would
  // write a tag that no longer exists in the vocabulary.
  const applied = applyTagCompletion("realistic, ", { start: 11, end: 11 }, "watercolor_(medium)");
  assert.equal(applied.value, "realistic, watercolor (medium), ", "parentheses are inserted unescaped");
  assert.ok(!applied.value.includes("\\"), "no backslash escaping is applied to a tag");
}

// --- Space / underscore equivalence ------------------------------------------
// The dataset stores `long_hair`, but prompts and aliases use spaces. Both
// spellings must reach the same tag.

assert.equal(
  matchTags(vocabulary, "long hair", 5)[0]?.tag.name,
  "long_hair",
  "a spaced query matches the underscored name",
);

assert.equal(matchTags(vocabulary, "long_hair", 5)[0]?.tag.name, "long_hair", "the underscored query still matches");

assert.equal(
  matchTags(vocabulary, "long hair ornament", 5)[0]?.tag.name,
  "long_hair_ornament",
  "spaces resolve through a multi-word tag",
);

assert.equal(matchTags(vocabulary, "long  hair", 5)[0]?.tag.name, "long_hair", "repeated separators collapse");

// Mixed separators must not produce duplicate suggestions.
const spacedVocabulary = parseTagCsv(
  ['long_hair,0,5000,"long hair,longhair"', "long_hair_large,0,10,"].join("\n"),
).tags;
const spacedMatches = matchTags(spacedVocabulary, "long hair", 20);
const spacedNames = spacedMatches.map((match) => match.tag.name);
assert.equal(
  new Set(spacedNames).size,
  spacedNames.length,
  "a tag whose alias differs only by separators is listed once",
);
assert.equal(spacedNames[0], "long_hair", "the exact spaced form outranks the longer tag");

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

// A `*` query can match inside a tag whose 2-char prefix differs from the query's,
// so the prefix bucket cannot narrow it. This is the one path that scans the whole
// vocabulary, and it must still return the hit rather than inheriting the bucket's
// narrowing (which would silently drop every mid-word match).
{
  const tags = withFiller("bh", 30, ["blue_hair_large,0,5000,"]);
  const names = matchTags(tags, "*hair", 50).map((match) => match.tag.name);
  assert.ok(names.includes("blue_hair_large"), `a "*" match outside the query's bucket must be found: ${names}`);
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
