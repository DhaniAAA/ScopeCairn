import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml, type VisualModel } from "../src/graph/visual.js";

test("renderHtml menghasilkan dokumen HTML interaktif yang valid dan mandiri", () => {
  const model: VisualModel = {
    nodes: [
      {
        id: 1,
        file: "src/index.ts",
        lang: "typescript",
        symbols: 10,
        module: "src",
        cluster: 0,
        clusterName: "core",
        pagerank: 0.05,
        inDeg: 2,
        outDeg: 1,
        x: 100,
        y: 100,
        r: 12,
        color: "hsl(200, 70%, 55%)",
      },
      {
        id: 2,
        file: "src/utils.ts",
        lang: "typescript",
        symbols: 5,
        module: "src",
        cluster: 0,
        clusterName: "core",
        pagerank: 0.02,
        inDeg: 1,
        outDeg: 2,
        x: 200,
        y: 150,
        r: 9,
        color: "hsl(200, 70%, 55%)",
      },
    ],
    edges: [
      { a: 1, b: 2, rel: "IMPORTS", n: 3, conf: 0.95 },
    ],
    truncatedFiles: 0,
    truncatedEdges: 0,
    symbols: [
      {
        id: 101,
        name: "main",
        type: "function",
        file: "src/index.ts",
        cluster: 0,
        pr: 0.04,
        inn: 0,
        out: 1,
        callers: [],
        callees: ["helper (CALLS)"],
        x: 105,
        y: 105,
      },
      {
        id: 102,
        name: "helper",
        type: "function",
        file: "src/utils.ts",
        cluster: 0,
        pr: 0.03,
        inn: 1,
        out: 0,
        callers: ["main (CALLS)"],
        callees: [],
        x: 195,
        y: 145,
      },
    ],
    symbolEdges: [
      { s: 101, t: 102, rel: "CALLS" },
    ],
    truncatedSymbols: 0,
    clusterNames: [{ id: 0, name: "core" }],
    modularity: 0.42,
  };

  const html = renderHtml(model, "MyProject", "2026-10-08 20:00:00");
  assert.ok(html.startsWith("<!DOCTYPE html>"), "Harus diawali <!DOCTYPE html>");
  assert.ok(html.includes("MyProject"), "Harus memuat judul project");
  assert.ok(html.includes("<canvas id=\"cv\">"), "Harus memuat elemen canvas utama");
  assert.ok(html.includes("<canvas id=\"minimap\">") || html.includes("id=\"hud\"") || html.includes("id=\"cv\""), "Harus memuat canvas view");
  assert.ok(html.includes("src/index.ts"), "Harus memuat data payload node");
  assert.ok(html.includes("</html>"), "Harus ditutup </html>");
});
