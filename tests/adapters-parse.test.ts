import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDrizzleTables, parseDrizzleQueries } from "../src/adapters/drizzle.js";
import { parseExpressRoutes } from "../src/adapters/express.js";
import { parseFastApiRoutes } from "../src/adapters/fastapi.js";
import { parseSqlAlchemyModels } from "../src/adapters/sqlalchemy.js";
import { usedVueComponents, vueComponentName } from "../src/adapters/vue.js";
import { detectServerActions, detectMiddleware } from "../src/adapters/nextjs.js";

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
