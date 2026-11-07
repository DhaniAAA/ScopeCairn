import { execFileSync } from "node:child_process";

/** Decode path yang di-quote git (escape C: \\, \", dan oktal \NNN byte UTF-8). */
function decodeGitPath(raw: string): string {
  let p = raw.trim();
  if (!(p.startsWith('"') && p.endsWith('"'))) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\") {
      const next = inner[i + 1];
      if (next >= "0" && next <= "7") {
        bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
        i += 3;
      } else if (next === "n") { bytes.push(10); i++; }
      else if (next === "t") { bytes.push(9); i++; }
      else { bytes.push(next.charCodeAt(0)); i++; }
    } else {
      bytes.push(inner.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export function changedFilesVsHead(repoRoot: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4);
    p = decodeGitPath(p);
    if (p) files.push(p);
  }
  return files;
}

export interface ChangedVsBase {
  files: string[];
  /**
   * True bila ref base tidak valid. Hasil tak bisa dipercaya — pemanggil
   * HARUS gagal, bukan diam-diam lolos (false pass = bahaya).
   */
  baseInvalid: boolean;
  /** Ref yang dipakai, untuk pesan error. */
  base: string;
}

/**
 * File berubah terhadap sebuah base ref — mencakup perubahan yang SUDAH
 * di-commit.
 *
 * `changedFilesVsHead` hanya melihat working tree vs HEAD. Kalau agent
 * melakukan commit (keb commonplace di tim, dan di orke/CI), working tree
 * bersih → verify melaporkan "0 file berubah" → LOLOS diam-diam. Di repo
 * besar dengan branch protection, itu persis jumlah review yang tak pernah
 * terjadi.
 *
 * Diff memakai tiga-titik (`base...HEAD`) → perubahan pada branch ini sejak
 * titik divergensinya, bukan selisih penuh dengan base (yang akan ikut
 * menghitung commit base yang tak ada hubungannya).
 */
export function changedFilesVsBase(repoRoot: string, base: string): ChangedVsBase {
  const files = new Set<string>();
  let baseInvalid = false;
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      const p = decodeGitPath(line);
      if (p) files.add(p);
    }
  } catch {
    baseInvalid = true;
  }
  // Perubahan yang belum di-commit tetap ikut — basis ref tak menggantikan
  // working tree, keduanya dijumlahkan.
  for (const p of changedFilesVsHead(repoRoot)) files.add(p);
  return { files: [...files], baseInvalid, base };
}

/** Ambil SHA pendek HEAD git saat ini (`git rev-parse --short HEAD`), atau null bila bukan repo git / belum ada commit. */
export function currentGitHead(repoRoot: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export interface GitDriftSince {
  currentHead: string | null;
  commitsSinceSave: number;
  changedFiles: string[];
}

/**
 * Hitung jumlah commit dan daftar file yang berubah sejak `savedHead`
 * (mencakup commit baru `savedHead..HEAD` + perubahan working tree saat ini).
 */
export function gitDriftSince(repoRoot: string, savedHead: string | null): GitDriftSince {
  const currentHead = currentGitHead(repoRoot);
  let commitsSinceSave = 0;
  const committedFiles = new Set<string>();
  const files = new Set<string>();

  if (savedHead && savedHead !== "none" && currentHead) {
    try {
      const countRaw = execFileSync("git", ["rev-list", "--count", `${savedHead}..HEAD`], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const parsed = Number.parseInt(countRaw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        commitsSinceSave = parsed;
      }
    } catch {
      commitsSinceSave = 0;
    }

    try {
      const diffOut = execFileSync("git", ["diff", "--name-only", `${savedHead}..HEAD`], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of diffOut.split("\n")) {
        const p = decodeGitPath(line);
        if (p) {
          committedFiles.add(p);
          files.add(p);
        }
      }
    } catch {
      // Abaikan bila savedHead sudah tidak terjangkau
    }
  }

  for (const p of changedFilesVsHead(repoRoot)) {
    if (p) files.add(p);
  }

  const changedFiles = [...files]
    .filter((f) => {
      if (f.startsWith(".scopecairn/")) return false;
      // Jangan laporkan .gitignore yang hanya baru ditambahkan otomatis oleh session save
      if (f === ".gitignore" && !committedFiles.has(".gitignore")) {
        try {
          const diff = execFileSync("git", ["diff", "HEAD", "--", ".gitignore"], {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 3000,
            stdio: ["ignore", "pipe", "ignore"],
          });
          if (!diff.trim()) return false; // untracked .gitignore dari ensureSessionGitignored
          const addedLines = diff
            .split("\n")
            .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
            .map((l) => l.slice(1).trim())
            .filter(Boolean);
          const removedLines = diff
            .split("\n")
            .filter((l) => l.startsWith("-") && !l.startsWith("---"));
          if (
            removedLines.length === 0 &&
            addedLines.length > 0 &&
            addedLines.every((l) => l === ".scopecairn/" || l === ".scopecairn/session.md")
          ) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    })
    .sort((a, b) => a.localeCompare(b));

  return { currentHead, commitsSinceSave, changedFiles };
}
