import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { prepareTreeSitter } from "../src/treesitter.js";
import { drizzleAdapter, parseDrizzleTables, parseDrizzleQueries } from "../src/adapters/drizzle.js";
import { parseExpressRoutes } from "../src/adapters/express.js";
import { parseFastApiRoutes } from "../src/adapters/fastapi.js";
import { parseSqlAlchemyModels, parseSqlAlchemyQueries } from "../src/adapters/sqlalchemy.js";
import { parsePrismaModels } from "../src/adapters/prisma.js";
import { usedVueComponents, vueComponentName, parseVueImports, parseTemplateTags, hasVueDefineComponent } from "../src/adapters/vue.js";
import { nextjsAdapter, detectServerActions, detectMiddleware, routeHandlers, prismaCalls } from "../src/adapters/nextjs.js";
import { normalizeApiPath, parseApiCalls, parseRouteName, deriveApiCalls } from "../src/adapters/apiCalls.js";

await prepareTreeSitter(["typescript", "tsx", "javascript", "python", "vue"]);

test("prisma schema keeps the explicit regex fallback", () => {
  assert.deepEqual(parsePrismaModels(`model User {\n id Int @id\n}\n// model Fake {}\nmodel Post {}`), [
    { name: "User", line: 1 }, { name: "Post", line: 5 },
  ]);
});

test("drizzle tables parsed", () => {
  const t = parseDrizzleTables(`export const users = pgTable("users", {\n  id: serial("id"),\n});`);
  assert.equal(t.length, 1);
  assert.equal(t[0].name, "users");
  assert.equal(t[0].table, "users");
});

test("drizzle relational + builder queries", () => {
  const q = parseDrizzleQueries(`await db.query.users.findMany();\nawait db.select().from(users);\nawait db.insert(orders).values({});`);
  const tables = q.map((x) => x.table).sort();
  assert.deepEqual(tables, ["orders", "users", "users"].sort());
});

test("express routes parsed", () => {
  const r = parseExpressRoutes(`app.get("/users", listUsers);\nrouter.post("/login", loginHandler);`);
  assert.equal(r.length, 2);
  assert.equal(r[0].method.toUpperCase(), "GET");
});

test("fastapi routes parsed", () => {
  const r = parseFastApiRoutes(`@app.get("/items")\ndef list_items():\n    pass\n@router.post("/items")\ndef create_item():\n    pass`);
  assert.equal(r.length, 2);
  assert.equal(r[0].path, "/items");
});

test("sqlalchemy models parsed", () => {
  const m = parseSqlAlchemyModels(`class User(Base):\n    __tablename__ = "users"\n    id = Column(Integer)`);
  assert.equal(m.length, 1);
  assert.equal(m[0].name, "User");
});

test("vue used components detected in template", () => {
  const used = usedVueComponents(
    `<script>import UserCard from "./UserCard.vue";</script><template><UserCard /></template>`
  );
  assert.ok(used.length >= 1);
  assert.equal(vueComponentName("src/components/UserCard.vue"), "UserCard");
});

test("nextjs server actions + middleware detection", () => {
  assert.equal(detectServerActions(`"use server";\nexport async function a() {}`), true);
  assert.equal(detectServerActions(`export async function a() {}`), false);
  assert.equal(detectMiddleware("src/middleware.ts"), true);
  assert.equal(detectMiddleware("src/app/page.tsx"), false);
});

test("express ignores comments, strings and nested handler expressions", () => {
  const routes = parseExpressRoutes(`// app.get("/fake", fake)
const text = 'router.post("/fake", fake)';
app.get(
  "/real", listUsers
);
router.post("/inline", () => handle());`);
  assert.deepEqual(routes.map((route) => [route.method, route.path, route.handler]), [
    ["GET", "/real", "listUsers"], ["POST", "/inline", null],
  ]);
});

test("fastapi decorators bind only to their own function", () => {
  const routes = parseFastApiRoutes(`@app.get("/a")
@cache()
async def first():
    pass
text = '@router.post("/fake")'
@router.post("/b")
def second():
    pass`);
  assert.deepEqual(routes.map((route) => [route.method, route.path, route.handler, route.line]), [
    ["GET", "/a", "first", 1], ["POST", "/b", "second", 6],
  ]);
});

test("drizzle tables and queries require structural calls", () => {
  const source = `// const fake = pgTable("fake", {})
const users = pgTable("users", {});
const bad = "db.query.bad.findMany()";
db.select(); unrelated.from(other);
db.select().from(users);
db.query.users.findMany();
db.insert(orders).values({});`;
  assert.deepEqual(parseDrizzleTables(source).map((table) => table.table), ["users"]);
  assert.deepEqual(parseDrizzleQueries(source).map((query) => query.table), ["users", "users", "orders"]);
});

test("sqlalchemy table belongs to its class and queries are calls", () => {
  const source = `class Plain:
    pass
class User(Base):
    __tablename__ = "users"
    def search(self):
        return select(User)
class Other:
    __tablename__ = "others"
text = "session.query(Fake)"
session.query(Other)`;
  assert.deepEqual(parseSqlAlchemyModels(source).map((model) => [model.name, model.table]), [
    ["User", "users"], ["Other", "others"],
  ]);
  assert.deepEqual(parseSqlAlchemyQueries(source).map((query) => query.model), ["User", "Other"]);
});

test("vue imports and tags stay within script and template nodes", () => {
  const source = `<script setup>
import UserCard from "./UserCard.vue";
const ignored = 'import Fake from "./Fake.vue"';
</script>
<template><UserCard /><user-card /><div title="<fake-tag />" /></template>
<style>.x::before { content: "<fake-tag />" }</style>`;
  assert.deepEqual(parseVueImports(source).map((imp) => [imp.name, imp.line]), [["UserCard", 2]]);
  assert.deepEqual(parseTemplateTags(source), ["UserCard", "user-card"]);
  assert.deepEqual(usedVueComponents(source).map((imp) => imp.name), ["UserCard"]);
  assert.equal(hasVueDefineComponent(`<template><div>defineComponent({})</div></template>`), false);
});

test("nextjs exported handlers and prisma calls ignore text lookalikes", () => {
  const source = `const text = "prisma.fake.findMany()";
// export function POST() {}
export async function GET() { return prisma.user.findMany(); }
function DELETE() {}
prisma.user.update({});`;
  assert.deepEqual(routeHandlers(source), [{ method: "GET", line: 3 }]);
  assert.deepEqual(prismaCalls(source).map((call) => [call.model, call.op]), [["user", "findMany"], ["user", "update"]]);
  assert.equal(detectServerActions(`const text = '"use server"';`), false);
  assert.equal(detectServerActions(`function a() { doWork(); "use server"; }`), false);
  assert.equal(detectServerActions(`function a() { "use server"; doWork(); }`), true);
});

test("framework adapters parse JavaScript and TSX with their loaded grammars", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, type TEXT, signature TEXT, start_line INTEGER, end_line INTEGER);
CREATE TABLE relationships (source_id INTEGER, target_id INTEGER, relationship_type TEXT, weight REAL, confidence REAL, evidence TEXT);`);
    db.prepare("INSERT INTO symbols (file_id, name, type) VALUES (?, ?, ?)").run(1, "schema.js", "file");
    db.prepare("INSERT INTO symbols (file_id, name, type) VALUES (?, ?, ?)").run(2, "page.tsx", "file");
    db.prepare("INSERT INTO symbols (file_id, name, type) VALUES (?, ?, ?)").run(3, "User", "model");
    const ctx = { db, repoRoot: "." };
    drizzleAdapter.apply(ctx, [{ fileId: 1, rel: "src/db/schema.js", content: `const users = pgTable ("users", {}); db.select().from(users);` }]);
    nextjsAdapter.apply(ctx, [{ fileId: 2, rel: "src/app/page.tsx", content: `export default function Page() { return <div>{prisma.user.findMany()}</div>; }` }]);
    const models = db.prepare("SELECT name FROM symbols WHERE file_id = 1 AND type = 'model'").all() as { name: string }[];
    const queries = db.prepare("SELECT COUNT(*) AS count FROM relationships WHERE relationship_type = 'QUERIES'").get() as { count: number };
    assert.deepEqual(models.map((model) => model.name), ["users"]);
    assert.equal(queries.count, 2);
  } finally {
    db.close();
  }
});

test("calls_api normalizer menyamakan template dan route dinamis", () => {
  assert.equal(normalizeApiPath("/api/users/${id}"), "/api/users/{}");
  assert.equal(normalizeApiPath("/api/users/[id]"), "/api/users/{}");
  assert.equal(normalizeApiPath("/api/users/:id"), "/api/users/{}");
  assert.equal(normalizeApiPath("/api/users/<int:id>/"), "/api/users/{}");
  assert.equal(normalizeApiPath("https://x.test/api/health?x=1#h"), "/api/health");
  assert.equal(normalizeApiPath("api/users"), "/api/users");
  assert.deepEqual(parseRouteName("GET /api/users/[id]"), { method: "GET", path: "/api/users/[id]" });
  assert.deepEqual(parseRouteName("ROUTE /path/"), { method: null, path: "/path/" });
});

test("calls_api detector: fetch literal, template, axios.post, skip dinamis dan Map.get", async () => {
  await prepareTreeSitter(["typescript"]);
  const calls = parseApiCalls(
    `fetch('/api/health');\nfetch(\`/api/users/\${id}\`);\naxios.post('/api/orders', body);\nconst m = new Map(); m.get("key");\nfetch(url);`,
    "typescript"
  );
  const raws = calls.map((c) => c.raw).sort();
  assert.ok(raws.includes("/api/health"));
  assert.ok(raws.includes("/api/users/${id}"));
  assert.ok(raws.includes("/api/orders"));
  assert.ok(!raws.includes("key"));
  assert.ok(!raws.includes("url"));
  const post = calls.find((c) => c.raw === "/api/orders");
  assert.equal(post?.method, "POST");
});

test("calls_api resolver: INFERRED template, EXTRACTED literal, AMBIGUOUS cap 3", async () => {
  await prepareTreeSitter(["typescript", "tsx"]);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT, language TEXT, hash TEXT, size INTEGER);
CREATE TABLE symbols (id INTEGER PRIMARY KEY, file_id INTEGER, name TEXT, type TEXT, signature TEXT, start_line INTEGER, end_line INTEGER);
CREATE TABLE relationships (source_id INTEGER, target_id INTEGER, relationship_type TEXT, weight REAL, confidence REAL, evidence TEXT);`);
    db.prepare("INSERT INTO files (id, path, language, hash, size) VALUES (1, 'app/api/users/[id]/route.ts', 'typescript', 'h', 1)").run();
    db.prepare("INSERT INTO files (id, path, language, hash, size) VALUES (2, 'web/UserCard.tsx', 'typescript', 'h', 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (10, 1, 'app/api/users/[id]/route.ts', 'file', '', 1, 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (11, 1, 'GET /api/users/[id]', 'route', 'GET /api/users/[id]', 1, 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (12, 1, 'GET /api/health', 'route', 'GET /api/health', 1, 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (20, 2, 'web/UserCard.tsx', 'file', '', 1, 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (21, 2, 'UserCard', 'component', '', 1, 10)").run();
    const inf = deriveApiCalls(db, 2, `export function UserCard(){ fetch(\`/api/users/\${id}\`); }`, "web/UserCard.tsx");
    assert.equal(inf.length, 1);
    assert.equal(inf[0].evidence, "INFERRED");
    assert.equal(inf[0].callerId, 21);
    assert.equal(inf[0].targetId, 11);
    const ext = deriveApiCalls(db, 2, `export function UserCard(){ fetch('/api/health'); }`, "web/UserCard.tsx");
    assert.equal(ext.length, 1);
    assert.equal(ext[0].evidence, "EXTRACTED");
    // Dua kandidat method sama path → maksimal 3 AMBIGUOUS
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (13, 1, 'POST /api/users/[id]', 'route', 'POST /api/users/[id]', 1, 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (14, 1, 'PUT /api/users/[id]', 'route', 'PUT /api/users/[id]', 1, 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (15, 1, 'PATCH /api/users/[id]', 'route', 'PATCH /api/users/[id]', 1, 1)").run();
    db.prepare("INSERT INTO symbols (id, file_id, name, type, signature, start_line, end_line) VALUES (16, 1, 'DELETE /api/users/[id]', 'route', 'DELETE /api/users/[id]', 1, 1)").run();
    const amb = deriveApiCalls(db, 2, `export function UserCard(){ fetch('/api/users/123', { method: 'POST' }); }`, "web/UserCard.tsx");
    assert.ok(amb.length >= 1 && amb.length <= 3);
    assert.ok(amb.every((e) => e.evidence === "AMBIGUOUS" || e.evidence === "EXTRACTED" || e.evidence === "INFERRED"));
  } finally {
    db.close();
  }
});
