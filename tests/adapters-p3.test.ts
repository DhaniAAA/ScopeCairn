import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { parseNestRoutes, parseNestInjectables, nestjsAdapter } from "../src/adapters/nestjs.js";
import { parseDjangoRoutes, parseDjangoModels, djangoAdapter } from "../src/adapters/django.js";

test("nestjs routes and injectables parsed correctly", () => {
  const code = `
@Injectable()
export class UserService {}

@Controller('users')
export class UserController {
  @Get(':id')
  async getUser() {}

  @Post()
  async createUser() {}
}
`;
  const routes = parseNestRoutes(code);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].method, "GET");
  assert.equal(routes[0].path, "/users/:id");
  assert.equal(routes[0].handler, "getUser");

  assert.equal(routes[1].method, "POST");
  assert.equal(routes[1].path, "/users");
  assert.equal(routes[1].handler, "createUser");

  const injectables = parseNestInjectables(code);
  assert.equal(injectables.length, 1);
  assert.equal(injectables[0].name, "UserService");
});

test("nestjs adapter registers routes and relations in sqlite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY,
        file_id INTEGER,
        name TEXT,
        type TEXT,
        signature TEXT,
        start_line INTEGER,
        end_line INTEGER
      );
      CREATE TABLE relationships (
        source_id INTEGER,
        target_id INTEGER,
        relationship_type TEXT,
        weight REAL,
        confidence REAL,
        evidence TEXT
      );
    `);

    // File symbol
    db.prepare("INSERT INTO symbols (file_id, name, type) VALUES (?, ?, ?)").run(1, "src/user.controller.ts", "file");
    // Handler method symbol
    db.prepare("INSERT INTO symbols (file_id, name, type) VALUES (?, ?, ?)").run(1, "getUser", "method");

    const code = `
@Controller('users')
export class UserController {
  @Get(':id')
  async getUser() {}
}
`;
    const res = nestjsAdapter.apply({ db, repoRoot: "." }, [
      { fileId: 1, rel: "src/user.controller.ts", content: code },
    ]);

    assert.equal(res.symbols, 1); // 1 route symbol created
    const route = db.prepare("SELECT name, type FROM symbols WHERE type = 'route'").get() as { name: string; type: string };
    assert.equal(route.name, "GET /users/:id");

    const rels = db.prepare("SELECT relationship_type FROM relationships WHERE relationship_type = 'ROUTES_TO'").all();
    assert.equal(rels.length, 1);
  } finally {
    db.close();
  }
});

test("django routes and models parsed correctly", () => {
  const urlCode = `
from django.urls import path, re_path
from . import views

urlpatterns = [
    path('articles/<int:id>/', views.article_detail, name='detail'),
    path('articles/', views.article_list, name='list'),
]
`;
  const routes = parseDjangoRoutes(urlCode);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].path, "/articles/<int:id>/");
  assert.equal(routes[0].handler, "views.article_detail");
  assert.equal(routes[1].path, "/articles/");

  const modelCode = `
from django.db import models

class Article(models.Model):
    title = models.CharField(max_length=100)

class Comment(models.Model):
    text = models.TextField()
`;
  const models = parseDjangoModels(modelCode);
  assert.equal(models.length, 2);
  assert.equal(models[0].name, "Article");
  assert.equal(models[1].name, "Comment");
});

test("django adapter registers routes and models in sqlite", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE symbols (
        id INTEGER PRIMARY KEY,
        file_id INTEGER,
        name TEXT,
        type TEXT,
        signature TEXT,
        start_line INTEGER,
        end_line INTEGER
      );
      CREATE TABLE relationships (
        source_id INTEGER,
        target_id INTEGER,
        relationship_type TEXT,
        weight REAL,
        confidence REAL,
        evidence TEXT
      );
    `);

    db.prepare("INSERT INTO symbols (file_id, name, type) VALUES (?, ?, ?)").run(1, "myproject/urls.py", "file");
    db.prepare("INSERT INTO symbols (file_id, name, type) VALUES (?, ?, ?)").run(2, "myproject/models.py", "file");

    const urlCode = `urlpatterns = [ path('items/', views.list_items) ]`;
    const modelCode = `class Item(models.Model): pass`;

    const resUrls = djangoAdapter.apply({ db, repoRoot: "." }, [
      { fileId: 1, rel: "myproject/urls.py", content: urlCode },
    ]);
    const resModels = djangoAdapter.apply({ db, repoRoot: "." }, [
      { fileId: 2, rel: "myproject/models.py", content: modelCode },
    ]);

    assert.equal(resUrls.symbols, 1);
    assert.equal(resModels.symbols, 1);

    const routeSym = db.prepare("SELECT name FROM symbols WHERE type = 'route'").get() as { name: string };
    assert.equal(routeSym.name, "ROUTE /items/");

    const modelSym = db.prepare("SELECT name FROM symbols WHERE type = 'model'").get() as { name: string };
    assert.equal(modelSym.name, "Item");
  } finally {
    db.close();
  }
});
