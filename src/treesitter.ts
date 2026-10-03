// Fase 1: Tree-sitter bootstrap check (FR-02 prep).
// Full symbol extraction lands in Fase 2. Here we only verify that
// `web-tree-sitter` WASM runtime loads, so `doctor` can report it.

let cached: boolean | null = null;

export async function checkTreeSitter(): Promise<{ ok: boolean; detail: string }> {
  if (cached !== null) {
    return cached
      ? { ok: true, detail: "cached OK" }
      : { ok: false, detail: "cached FAIL" };
  }
  try {
    const mod = await import("web-tree-sitter");
    const Parser = (mod as unknown as { Parser: { init: () => Promise<void> } }).Parser;
    if (!Parser || typeof Parser.init !== "function") {
      cached = false;
      return { ok: false, detail: "Parser.init not found" };
    }
    await Parser.init();
    cached = true;
    return { ok: true, detail: "WASM parser runtime OK (grammars load in Fase 2)" };
  } catch (e) {
    cached = false;
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
