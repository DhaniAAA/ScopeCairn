import fs from "node:fs";
import path from "node:path";
import { openDb, dataDir } from "../db.js";
import { matchPattern } from "../scope/protected.js";

export interface ArchConfig {
  layers: Record<string, string[]>;
  disallowed: {
    from: string;
    import: string;
    message?: string;
  }[];
}

export interface ArchViolation {
  fromFile: string;
  fromLayer: string;
  toFile: string;
  toLayer: string;
  message?: string;
  line?: number;
}

export interface ArchCheckResult {
  ok: boolean;
  configFile: string;
  configFound: boolean;
  totalViolations: number;
  violations: ArchViolation[];
}

export function archConfigPath(repoRoot: string): string {
  const p1 = path.join(dataDir(repoRoot), "arch.json");
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(repoRoot, "scopecairn.arch.json");
  if (fs.existsSync(p2)) return p2;
  return p1;
}

export function loadArchConfig(repoRoot: string): { config: ArchConfig | null; path: string } {
  const p = archConfigPath(repoRoot);
  if (!fs.existsSync(p)) {
    return { config: null, path: p };
  }
  try {
    const raw = fs.readFileSync(p, "utf8");
    return { config: JSON.parse(raw) as ArchConfig, path: p };
  } catch {
    return { config: null, path: p };
  }
}

export function initArchConfig(repoRoot: string): string {
  const p = path.join(dataDir(repoRoot), "arch.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const sample: ArchConfig = {
    layers: {
      extract: ["src/extract/**"],
      adapters: ["src/adapters/**"],
      commands: ["src/commands/**"],
      core: ["src/*.ts"],
    },
    disallowed: [
      {
        from: "extract",
        import: "commands",
        message: "Extraction engine must remain pure and not depend on CLI commands",
      },
      {
        from: "adapters",
        import: "commands",
        message: "Framework adapters must not depend on CLI commands",
      },
    ],
  };

  fs.writeFileSync(p, JSON.stringify(sample, null, 2) + "\n");
  return p;
}

export function checkArchitecture(repoRoot: string): ArchCheckResult {
  const { config, path: cfgPath } = loadArchConfig(repoRoot);
  if (!config) {
    return {
      ok: true,
      configFile: cfgPath,
      configFound: false,
      totalViolations: 0,
      violations: [],
    };
  }

  const findLayer = (posixPath: string): string | null => {
    for (const [layerName, patterns] of Object.entries(config.layers)) {
      for (const pat of patterns) {
        if (matchPattern(pat, posixPath)) {
          return layerName;
        }
      }
    }
    return null;
  };

  const disallowedMap = new Map<string, string>(); // "from->import" => message
  for (const d of config.disallowed) {
    const key = `${d.from}->${d.import}`;
    disallowedMap.set(key, d.message || `Layer '${d.from}' is forbidden from importing '${d.import}'`);
  }

  const db = openDb(repoRoot);
  const violations: ArchViolation[] = [];

  try {
    const rows = db
      .prepare(
        `SELECT sf.path AS src_path, tf.path AS tgt_path, s.start_line AS line
         FROM relationships r
         JOIN symbols s ON s.id = r.source_id
         JOIN files sf ON sf.id = s.file_id
         JOIN symbols t ON t.id = r.target_id
         JOIN files tf ON tf.id = t.file_id
         WHERE r.relationship_type = 'IMPORTS'`
      )
      .all() as { src_path: string; tgt_path: string; line: number }[];

    for (const r of rows) {
      const srcNorm = r.src_path.replace(/\\/g, "/");
      const tgtNorm = r.tgt_path.replace(/\\/g, "/");
      if (srcNorm === tgtNorm) continue;

      const fromLayer = findLayer(srcNorm);
      const toLayer = findLayer(tgtNorm);

      if (fromLayer && toLayer && fromLayer !== toLayer) {
        const key = `${fromLayer}->${toLayer}`;
        if (disallowedMap.has(key)) {
          violations.push({
            fromFile: srcNorm,
            fromLayer,
            toFile: tgtNorm,
            toLayer,
            message: disallowedMap.get(key),
            line: r.line,
          });
        }
      }
    }
  } finally {
    db.close();
  }

  return {
    ok: violations.length === 0,
    configFile: cfgPath,
    configFound: true,
    totalViolations: violations.length,
    violations,
  };
}

export function cmdArchCheck(
  repoRoot: string,
  opts?: { init?: boolean; json?: boolean }
): void {
  if (opts?.init) {
    const created = initArchConfig(repoRoot);
    console.log(`Created architecture configuration at: ${created}`);
    return;
  }

  const result = checkArchitecture(repoRoot);

  if (opts?.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.configFound) {
    console.log("No architecture rules found (.scopecairn/arch.json).");
    console.log("Run `scopecairn arch-check --init` to generate an initial configuration template.");
    return;
  }

  console.log(`# ScopeCairn Architecture Check\n`);
  console.log(`Rules file: ${result.configFile}`);

  if (result.ok) {
    console.log(`Status: PASSED ✓ (0 architectural boundary violations)`);
    return;
  }

  console.log(`Status: FAILED ✗ (${result.totalViolations} boundary violations detected)\n`);

  for (const v of result.violations) {
    console.log(`  [✗] ${v.fromFile} [layer: ${v.fromLayer}]`);
    console.log(`      imports ${v.toFile} [layer: ${v.toLayer}]`);
    if (v.message) console.log(`      Rule: ${v.message}`);
    console.log("");
  }

  process.exitCode = 1;
}
