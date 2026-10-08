import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);
const source = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
const grammars = ["typescript", "tsx", "javascript", "python", "java", "go", "rust", "php", "c_sharp", "cpp", "c", "ruby", "html", "vue"];

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  minify: false,
  sourcemap: false,
  clean: true,
  onSuccess: () => {
    mkdirSync("dist/grammars", { recursive: true });
    for (const grammar of grammars) {
      const name = `tree-sitter-${grammar}.wasm`;
      copyFileSync(path.join(source, name), path.join("dist/grammars", name));
    }
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
});
