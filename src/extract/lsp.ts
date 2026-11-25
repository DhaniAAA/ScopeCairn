import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export interface LspStatus {
  tsserver: string | null;
  gopls: string | null;
  pyright: string | null;
  rustAnalyzer?: string | null;
}

export interface LspServerCommand {
  command: string;
  args: string[];
  languageId: string;
}

export interface LspLocation {
  file: string;
  line: number; // 1-based
  character: number; // 0-based
}

function whichBinary(name: string): string | null {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(cmd, [name], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status === 0 && r.stdout && r.stdout.trim().length > 0) {
      const first = r.stdout.trim().split(/\r?\n/)[0].trim();
      return first.length > 0 ? first : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Deteksi LSP opsional di PATH: `typescript-language-server`/`tsserver`, `gopls`,
 * `pyright-langserver`/`pyright`, dan `rust-analyzer`. Selalu sukses (tidak melempar).
 */
export function detectLsp(): LspStatus {
  return {
    tsserver: whichBinary("typescript-language-server") ?? whichBinary("tsserver"),
    gopls: whichBinary("gopls"),
    pyright: whichBinary("pyright-langserver") ?? whichBinary("pyright"),
    rustAnalyzer: whichBinary("rust-analyzer"),
  };
}

export function isLspAvailable(status: LspStatus): boolean {
  return (
    status.tsserver !== null ||
    status.gopls !== null ||
    status.pyright !== null ||
    (status.rustAnalyzer ?? null) !== null
  );
}

export function serverCommandForLanguage(
  language: string,
  status: LspStatus
): LspServerCommand | null {
  if (language === "typescript" || language === "javascript") {
    if (!status.tsserver) return null;
    const base = path.basename(status.tsserver).toLowerCase();
    // `tsserver` klasik memakai protokol berbeda dari LSP stdio; gunakan bila `typescript-language-server`
    if (base.includes("typescript-language-server")) {
      return { command: status.tsserver, args: ["--stdio"], languageId: language };
    }
    return null;
  }
  if (language === "go" && status.gopls) {
    return { command: status.gopls, args: ["serve"], languageId: "go" };
  }
  if (language === "python" && status.pyright) {
    const base = path.basename(status.pyright).toLowerCase();
    if (base.includes("pyright-langserver")) {
      return { command: status.pyright, args: ["--stdio"], languageId: "python" };
    }
    return null;
  }
  if (language === "rust" && status.rustAnalyzer) {
    return { command: status.rustAnalyzer, args: [], languageId: "rust" };
  }
  return null;
}

/**
 * Klien JSON-RPC 2.0 LSP over stdio dengan framing `Content-Length`.
 */
export class LspStdioClient {
  private proc: ChildProcessByStdio<Writable, Readable, null>;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  constructor(command: string, args: string[], cwd: string) {
    this.proc = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
      shell: false,
    });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.on("error", () => this.dispose());
    this.proc.on("exit", () => this.dispose());
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const sepIdx = this.buffer.indexOf("\r\n\r\n");
      if (sepIdx === -1) break;
      const header = this.buffer.slice(0, sepIdx).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.slice(sepIdx + 4);
        continue;
      }
      const len = Number.parseInt(m[1], 10);
      const bodyStart = sepIdx + 4;
      if (this.buffer.length < bodyStart + len) break;
      const bodyStr = this.buffer.slice(bodyStart, bodyStart + len).toString("utf8");
      this.buffer = this.buffer.slice(bodyStart + len);
      try {
        const msg = JSON.parse(bodyStr) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const waiter = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(waiter.timer);
          if (msg.error) waiter.reject(new Error(msg.error.message ?? "LSP error"));
          else waiter.resolve(msg.result);
        }
      } catch {
        // abaikan frame korup
      }
    }
  }

  private sendPayload(payload: unknown): void {
    if (this.closed || !this.proc.stdin.writable) return;
    const json = JSON.stringify(payload);
    const bytes = Buffer.byteLength(json, "utf8");
    this.proc.stdin.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
  }

  request(method: string, params: unknown, timeoutMs = 3000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("LSP client closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendPayload({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.sendPayload({ jsonrpc: "2.0", method, params });
  }

  async initialize(repoRoot: string): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(path.resolve(repoRoot)).href,
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
        },
      },
    });
    this.notify("initialized", {});
  }

  didOpen(absPath: string, languageId: string, text: string): void {
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(path.resolve(absPath)).href,
        languageId,
        version: 1,
        text,
      },
    });
  }

  private parseLocationResult(res: unknown, repoRoot: string): LspLocation | null {
    const items = Array.isArray(res) ? res : res ? [res] : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as {
        uri?: string;
        targetUri?: string;
        range?: { start?: { line?: number; character?: number } };
        targetSelectionRange?: { start?: { line?: number; character?: number } };
        targetRange?: { start?: { line?: number; character?: number } };
      };
      const uri = obj.targetUri ?? obj.uri;
      const range = obj.targetSelectionRange ?? obj.range ?? obj.targetRange;
      if (!uri?.startsWith("file://")) continue;
      let fsPath: string;
      try {
        fsPath = fileURLToPath(uri);
      } catch {
        continue;
      }
      const rel = path.relative(repoRoot, fsPath).split(path.sep).join("/");
      if (rel.startsWith("..")) continue;
      return {
        file: rel,
        line: (range?.start?.line ?? 0) + 1,
        character: range?.start?.character ?? 0,
      };
    }
    return null;
  }

  async definition(
    absPath: string,
    line0: number,
    character0: number,
    repoRoot: string
  ): Promise<LspLocation | null> {
    const res = await this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(path.resolve(absPath)).href },
      position: { line: line0, character: character0 },
    });
    return this.parseLocationResult(res, repoRoot);
  }

  async typeDefinition(
    absPath: string,
    line0: number,
    character0: number,
    repoRoot: string
  ): Promise<LspLocation | null> {
    const res = await this.request("textDocument/typeDefinition", {
      textDocument: { uri: pathToFileURL(path.resolve(absPath)).href },
      position: { line: line0, character: character0 },
    });
    return this.parseLocationResult(res, repoRoot);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    const waitClose = new Promise<void>((resolve) => {
      if (this.proc.exitCode !== null || this.proc.killed) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 400);
      this.proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      await this.request("shutdown", null, 1000);
      this.notify("exit", null);
    } catch {
      // ignore
    } finally {
      this.dispose();
      await waitClose;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(new Error("LSP client disposed"));
    }
    this.pending.clear();
    try {
      this.proc.kill();
    } catch {
      // ignore
    }
  }
}

function findSymbolPositionInRange(
  content: string,
  symbol: string,
  startLine1 = 1,
  endLine1?: number
): { line0: number; character0: number } | null {
  const lines = content.split(/\r?\n/);
  const lo = Math.max(0, startLine1 - 1);
  const hi = Math.min(lines.length - 1, (endLine1 ?? lines.length) - 1);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`);
  for (let i = lo; i <= hi; i++) {
    const m = re.exec(lines[i]);
    if (m) return { line0: i, character0: m.index };
  }
  return null;
}

/**
 * Resolusi satu simbol via LSP (`textDocument/definition`).
 * Mengembalikan string `"rel/path.ts:line"` bila berhasil, atau `null` bila LSP tidak tersedia/gagal.
 */
export async function resolveWithLsp(
  file: string,
  symbol: string,
  lspStatus?: LspStatus,
  repoRoot = process.cwd(),
  customServer?: LspServerCommand
): Promise<string | null> {
  const abs = path.isAbsolute(file) ? file : path.join(repoRoot, ...file.split("/"));
  if (!fs.existsSync(abs)) return null;

  const ext = path.extname(abs).toLowerCase();
  const lang =
    ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts"
      ? "typescript"
      : ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs"
        ? "javascript"
        : ext === ".go"
          ? "go"
          : ext === ".py"
            ? "python"
            : ext === ".rs"
              ? "rust"
              : null;
  if (!lang) return null;

  const status = lspStatus ?? detectLsp();
  const srv = customServer ?? serverCommandForLanguage(lang, status);
  if (!srv) return null;

  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const pos = findSymbolPositionInRange(text, symbol);
  if (!pos) return null;

  const client = new LspStdioClient(srv.command, srv.args, repoRoot);
  try {
    await client.initialize(repoRoot);
    client.didOpen(abs, srv.languageId, text);
    const loc = await client.definition(abs, pos.line0, pos.character0, repoRoot);
    return loc ? `${loc.file}:${loc.line}` : null;
  } catch {
    return null;
  } finally {
    await client.shutdown();
  }
}

/**
 * Tingkatkan edge `CALLS`, `USES`, dan `IMPLEMENTS` berstatus `AMBIGUOUS`/`INFERRED`
 * menggunakan LSP (`textDocument/definition` & `textDocument/typeDefinition`)
 * untuk file-file yang berubah. Best-effort: kegagalan LSP tidak pernah menggagalkan scan.
 */
export async function enrichRelationsWithLsp(
  db: DatabaseSync,
  repoRoot: string,
  files: Array<{ fileId: number; rel: string; content: string; language: string }>,
  lspStatus: LspStatus,
  customServers?: Partial<Record<string, LspServerCommand>>
): Promise<number> {
  if (files.length === 0) return 0;
  let upgraded = 0;

  const byLang = new Map<string, typeof files>();
  for (const f of files) {
    const srv = customServers?.[f.language] ?? serverCommandForLanguage(f.language, lspStatus);
    if (!srv) continue;
    const list = byLang.get(f.language) ?? [];
    list.push(f);
    byLang.set(f.language, list);
  }

  for (const [lang, langFiles] of byLang.entries()) {
    const srv = customServers?.[lang] ?? serverCommandForLanguage(lang, lspStatus);
    if (!srv) continue;
    const client = new LspStdioClient(srv.command, srv.args, repoRoot);
    try {
      await client.initialize(repoRoot);
      for (const f of langFiles) {
        const abs = path.join(repoRoot, ...f.rel.split("/"));
        client.didOpen(abs, srv.languageId, f.content);

        const ambigRows = db
          .prepare(
            `SELECT r.id AS relId, r.relationship_type AS relType,
                    s.start_line AS startLine, s.end_line AS endLine,
                    t.id AS currentTargetId, t.name AS targetName
             FROM relationships r
             JOIN symbols s ON s.id = r.source_id
             JOIN symbols t ON t.id = r.target_id
             WHERE s.file_id = ?
               AND (
                 (r.relationship_type = 'CALLS' AND r.evidence = 'AMBIGUOUS')
                 OR (r.relationship_type IN ('USES', 'IMPLEMENTS') AND r.evidence IN ('AMBIGUOUS', 'INFERRED'))
               )
             LIMIT 100`
          )
          .all(f.fileId) as Array<{
          relId: number;
          relType: string;
          startLine: number;
          endLine: number;
          currentTargetId: number;
          targetName: string;
        }>;

        for (const row of ambigRows) {
          const pos = findSymbolPositionInRange(
            f.content,
            row.targetName,
            row.startLine,
            row.endLine
          );
          if (!pos) continue;
          let loc: LspLocation | null = null;
          try {
            loc = await client.definition(abs, pos.line0, pos.character0, repoRoot);
            if (!loc && (row.relType === "USES" || row.relType === "IMPLEMENTS")) {
              loc = await client.typeDefinition(abs, pos.line0, pos.character0, repoRoot);
            }
          } catch {
            continue;
          }
          if (!loc) continue;
          const resolvedSym = db
            .prepare(
              `SELECT s.id FROM symbols s
               JOIN files tf ON tf.id = s.file_id
               WHERE tf.path = ? AND s.type != 'file'
                 AND s.start_line <= ? AND s.end_line >= ?
               ORDER BY (s.end_line - s.start_line) ASC LIMIT 1`
            )
            .get(loc.file, loc.line, loc.line) as { id: number } | undefined;
          if (resolvedSym) {
            db.prepare(
              `UPDATE relationships SET target_id = ?, confidence = 0.98, evidence = 'EXTRACTED' WHERE id = ?`
            ).run(resolvedSym.id, row.relId);
            upgraded++;
          }
        }
      }
    } catch {
      // LSP session gagal — tetap gunakan ekstraksi Tree-sitter
    } finally {
      await client.shutdown();
    }
  }

  return upgraded;
}
