import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareTreeSitter } from "../src/treesitter.js";
import { extractFile } from "../src/extract/index.js";

await prepareTreeSitter(["typescript", "tsx", "javascript", "python", "java", "go", "rust", "php", "c_sharp", "cpp", "c", "ruby", "html", "vue"]);

test("TypeScript mengabaikan panggilan dalam komentar dan memberi scope pemanggil yang benar", () => {
  const result = extractFile("src/a.ts", `export function outer() {\n  // ghost()\n  inner();\n}\nfunction inner() {}`);
  assert.ok(result.symbols.some((s) => s.name === "outer" && s.type === "function" && s.endLine === 4));
  assert.ok(result.relations.some((r) => r.from === "outer" && r.to === "inner" && r.rel === "CALLS"));
  assert.ok(!result.relations.some((r) => r.to === "ghost"));
});

test("TSX class, method, component dan import menggunakan AST", () => {
  const result = extractFile("src/a.tsx", `import React from "react";\nexport class Widget extends Base { run() { this.render(); } }\nexport function Card() { return <div />; }`);
  assert.ok(result.symbols.some((s) => s.name === "Widget" && s.type === "class"));
  assert.ok(result.symbols.some((s) => s.name === "run" && s.type === "method"));
  assert.ok(result.symbols.some((s) => s.name === "Card" && s.type === "component"));
  assert.ok(result.relations.some((r) => r.rel === "IMPORTS" && r.to === "react"));
});

test("Python mendeteksi method bersarang dan call di kelas", () => {
  const result = extractFile("src/a.py", `class Example:\n    def run(self):\n        helper()\n`);
  assert.ok(result.symbols.some((s) => s.name === "run" && s.type === "method"));
  assert.ok(result.relations.some((r) => r.from === "run" && r.to === "helper" && r.rel === "CALLS"));
});

test("Go import dan deklarasi fungsi terdeteksi", () => {
  const result = extractFile("src/a.go", `package main\nimport "fmt"\nfunc greet() { fmt.Println("hello") }`);
  assert.ok(result.symbols.some((s) => s.name === "greet" && s.type === "function"));
  assert.ok(result.relations.some((r) => r.rel === "IMPORTS" && r.to === "fmt"));
});

test("HTML dan Vue mengenali elemen id", () => {
  assert.ok(extractFile("index.html", `<div id="app"></div>`).symbols.some((s) => s.name === "app"));
  assert.ok(extractFile("Widget.vue", `<template><div id="root"></div></template>`).symbols.some((s) => s.name === "root"));
});

for (const [path, source, expected] of [
  ["src/a.js", "function greet() { return ok(); }", "greet"],
  ["src/a.java", "class Hello { void greet() { ok(); } }", "greet"],
  ["src/a.rs", "fn greet() { ok(); }", "greet"],
  ["src/a.php", "<?php function greet() { ok(); }", "greet"],
  ["src/a.cs", "class Hello { void greet() { ok(); } }", "greet"],
  ["src/a.cpp", "void greet() { ok(); }", "greet"],
  ["src/a.c", "void greet() { ok(); }", "greet"],
  ["src/a.rb", "def greet; ok(); end", "greet"],
] as const) {
  test(`${path} mengekstrak deklarasi ${expected}`, () => {
    const result = extractFile(path, source);
    assert.ok(result.symbols.some((s) => s.name === expected && ["function", "method"].includes(s.type)), JSON.stringify(result));
  });
}
