import { spawnSync } from "node:child_process";

export interface LspStatus {
  tsserver: string | null;
  gopls: string | null;
  pyright: string | null;
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
 * Deteksi LSP opsional di PATH: `tsserver`, `gopls`, `pyright`.
 * Selalu sukses (tidak melempar) — null berarti biner tidak ditemukan.
 * Scan tetap jalan tanpa LSP; ini hanya info best-effort.
 */
export function detectLsp(): LspStatus {
  return {
    tsserver: whichBinary("tsserver"),
    gopls: whichBinary("gopls"),
    pyright: whichBinary("pyright"),
  };
}

export function isLspAvailable(status: LspStatus): boolean {
  return status.tsserver !== null || status.gopls !== null || status.pyright !== null;
}

/**
 * Stub aman: selalu `null` bila LSP tidak ada / belum diimplementasikan.
 * Disengaja tidak melempar agar pemanggil bisa fallback ke ekstraksi
 * Tree-sitter tanpa cabang error khusus.
 */
export function resolveWithLsp(
  _file: string,
  _symbol: string,
  _lspStatus?: LspStatus
): string | null {
  return null;
}
