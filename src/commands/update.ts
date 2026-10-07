import { execFileSync, execSync } from "node:child_process";
import pkg from "../../package.json" with { type: "json" };

function latestVersion(): string | null {
  try {
    const out = execFileSync("npm", ["view", "scopecairn", "version"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function cmdUpdate(opts: { check?: boolean } = {}): void {
  const current = (pkg as { version: string }).version;
  const latest = latestVersion();
  if (!latest) {
    console.log("Gagal memeriksa versi terbaru (offline atau belum terpublish).");
    console.log("Update manual: npm i -g scopecairn@latest");
    return;
  }
  console.log(`Versi terpasang: ${current} | terbaru: ${latest}`);
  if (latest === current) {
    console.log("Sudah versi terbaru.");
    return;
  }
  if (opts.check) {
    console.log("Update tersedia. Jalankan `scopecairn update`.");
    return;
  }
  try {
    execSync("npm i -g scopecairn@latest", {
      stdio: "inherit",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });
    console.log(`✓ scopecairn diperbarui ke ${latest}.`);
  } catch {
    console.log("Update gagal. Jalankan manual: npm i -g scopecairn@latest");
  }
}
