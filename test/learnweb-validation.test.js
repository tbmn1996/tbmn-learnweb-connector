/**
 * Input-Validierungs-Tests für learnweb-read-activity.
 *
 * Ziel: sicherstellen, dass
 *  - modtype gegen /^[a-z_]+$/ gezwungen wird (kein Path-Traversal)
 *  - modtype keine Uppercase-Varianten akzeptiert
 *  - cmid positiv sein muss
 *  - limit/offset im gültigen Bereich liegen
 *
 * Wir testen das Zod-Schema direkt, indem wir den Validator isoliert
 * aufbauen — die Regex lebt in src/tools/learnweb.ts und ist dort die
 * einzige Verteidigungslinie gegen modtype-Injection.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const { z } = require("zod");

const MODTYPE_RE = /^[a-z_]+$/;

// Identischer Schema-Shape wie in src/tools/learnweb.ts readActivity.
const readActivitySchema = z.object({
  cmid: z.number().int().positive(),
  modtype: z
    .string()
    .regex(MODTYPE_RE, "modtype must be lowercase letters/underscores."),
  limit: z.number().int().positive().max(25).optional(),
  offset: z.number().int().min(0).optional(),
});

const searchCoursesSchema = z.object({
  query: z.string().min(2).max(200),
  page: z.number().int().min(0).max(20).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

test("read-activity: path traversal im modtype wird abgelehnt", () => {
  const parse = readActivitySchema.safeParse({ cmid: 1, modtype: "../../admin" });
  assert.equal(parse.success, false);
});

test("read-activity: Uppercase modtype wird abgelehnt (lowercase required)", () => {
  const parse = readActivitySchema.safeParse({ cmid: 1, modtype: "RESOURCE" });
  assert.equal(parse.success, false);
});

test("read-activity: Bindestrich im modtype wird abgelehnt", () => {
  const parse = readActivitySchema.safeParse({ cmid: 1, modtype: "some-mod" });
  assert.equal(parse.success, false);
});

test("read-activity: leerer modtype wird abgelehnt", () => {
  const parse = readActivitySchema.safeParse({ cmid: 1, modtype: "" });
  assert.equal(parse.success, false);
});

test("read-activity: gültige Eingabe passiert Schema", () => {
  const parse = readActivitySchema.safeParse({
    cmid: 42,
    modtype: "ratingallocate",
    limit: 10,
    offset: 0,
  });
  assert.equal(parse.success, true);
});

test("read-activity: cmid muss positiv sein", () => {
  const zero = readActivitySchema.safeParse({ cmid: 0, modtype: "resource" });
  const neg = readActivitySchema.safeParse({ cmid: -1, modtype: "resource" });
  assert.equal(zero.success, false);
  assert.equal(neg.success, false);
});

test("read-activity: limit > 25 wird abgelehnt", () => {
  const parse = readActivitySchema.safeParse({
    cmid: 1,
    modtype: "forum",
    limit: 100,
  });
  assert.equal(parse.success, false);
});

test("read-activity: negatives offset wird abgelehnt", () => {
  const parse = readActivitySchema.safeParse({
    cmid: 1,
    modtype: "forum",
    offset: -5,
  });
  assert.equal(parse.success, false);
});

test("search-courses: query unter 2 Zeichen wird abgelehnt", () => {
  const parse = searchCoursesSchema.safeParse({ query: "a" });
  assert.equal(parse.success, false);
});

test("search-courses: query über 200 Zeichen wird abgelehnt", () => {
  const parse = searchCoursesSchema.safeParse({ query: "x".repeat(201) });
  assert.equal(parse.success, false);
});

test("search-courses: page ausserhalb 0..20 wird abgelehnt", () => {
  const below = searchCoursesSchema.safeParse({ query: "abc", page: -1 });
  const above = searchCoursesSchema.safeParse({ query: "abc", page: 21 });
  assert.equal(below.success, false);
  assert.equal(above.success, false);
});

test("search-courses: limit ausserhalb 1..50 wird abgelehnt", () => {
  const below = searchCoursesSchema.safeParse({ query: "abc", limit: 0 });
  const above = searchCoursesSchema.safeParse({ query: "abc", limit: 51 });
  assert.equal(below.success, false);
  assert.equal(above.success, false);
});

test("search-courses: gültige Eingabe passiert Schema", () => {
  const parse = searchCoursesSchema.safeParse({
    query: "Wirtschaftsinformatik",
    page: 1,
    limit: 25,
  });
  assert.equal(parse.success, true);
});
