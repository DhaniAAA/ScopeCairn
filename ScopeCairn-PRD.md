# ScopeCairn — Product Requirements Document (PRD)

| Item | Detail |
|---|---|
| **Produk** | ScopeCairn — Codebase Intelligence & Agent Optimization Layer |
| **Versi** | 0.5.1 |
| **Status** | Draft |
| **Platform target** | Google Antigravity IDE |
| **Lingkungan** | Mesin developer lokal (local-first, tanpa koneksi jaringan) |
| **Pengguna target** | Developer yang memakai AI coding agent |
| **Lisensi** | MIT (open source) |

> *Pahami codebase. Berikan agent hanya yang ia butuhkan.*

---

## Daftar Isi

1. [Ringkasan Eksekutif](#1-ringkasan-eksekutif)
2. [Latar Belakang & Masalah](#2-latar-belakang--masalah)
3. [Visi, Tujuan, dan Non-Tujuan](#3-visi-tujuan-dan-non-tujuan)
4. [Keputusan Desain](#4-keputusan-desain)
5. [Pengguna & Use Case](#5-pengguna--use-case)
6. [Prinsip Produk](#6-prinsip-produk)
7. [Functional Requirements](#7-functional-requirements)
8. [Auto-Invocation (Integrasi Antigravity)](#8-auto-invocation-integrasi-antigravity)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Arsitektur](#10-arsitektur)
11. [Tech Stack](#11-tech-stack)
12. [Data Model](#12-data-model)
13. [CLI](#13-cli)
14. [Optimasi Token & Konteks](#14-optimasi-token--konteks)
15. [Task Guard & Definition of Done](#15-task-guard--definition-of-done)
16. [Cost-Aware Routing](#16-cost-aware-routing)
17. [Privasi & Keamanan](#17-privasi--keamanan)
18. [Metrik & Benchmark](#18-metrik--benchmark)
19. [Scope MVP & Roadmap](#19-scope-mvp--roadmap)
20. [Risiko & Asumsi](#20-risiko--asumsi)
21. [Pertanyaan Terbuka](#21-pertanyaan-terbuka)
22. [Fitur Masa Depan](#22-fitur-masa-depan)
23. [Rekomendasi Implementasi](#23-rekomendasi-implementasi)

---

## 1. Ringkasan Eksekutif

**ScopeCairn** adalah *codebase intelligence layer* yang berjalan lokal. ScopeCairn membangun pemahaman terstruktur atas sebuah repository dalam bentuk **knowledge graph**, lalu memberikan kepada AI coding agent hanya konteks yang relevan untuk task yang sedang dikerjakan. Agent memanggil ScopeCairn **secara otomatis** melalui `AGENTS.md`, Skill, dan CLI, tanpa MCP dan tanpa embedding.

ScopeCairn menggabungkan:

- Static code analysis & AST parsing
- Knowledge graph (relasi antar simbol)
- Graph-based retrieval (tanpa embedding)
- Context compression
- Change impact analysis
- Task scope control (Task Guard)
- Agent instructions (`AGENTS.md`, Skill)
- Persistent codebase memory

**Definisi satu kalimat:**

> ScopeCairn adalah lapisan intelijen codebase *local-first* yang membangun knowledge graph repository, mengambil hanya konteks relevan bagi task agent, menganalisis dampak perubahan, dan menegakkan prinsip kerja minimal agar AI coding agent lebih cepat, fokus, dan hemat token.

---

## 2. Latar Belakang & Masalah

AI coding agent memiliki kemampuan reasoning yang kuat, tetapi sering menghabiskan waktu dan token hanya untuk memahami codebase pada setiap task.

**Alur tanpa ScopeCairn** (task: *"Tambahkan fitur approval request"*):

```text
list files → grep → read file → grep lagi → read file lain
→ cari database schema → cari API → baca test → baru paham arsitektur
```

| # | Masalah | Dampak |
|---|---|---|
| 1 | Terlalu banyak tool call eksplorasi | Lambat, mahal |
| 2 | Context window cepat penuh | Kualitas reasoning turun |
| 3 | Agent membaca file yang tidak relevan | Token terbuang |
| 4 | Agent bekerja di luar scope (refactor, upgrade dependency, dsb.) | Diff besar, risiko regresi |
| 5 | Eksplorasi yang sama diulang pada task berikutnya | Tidak ada akumulasi pengetahuan |
| 6 | Dependency antar komponen sulit dipahami | Perubahan merusak bagian lain |
| 7 | Dampak perubahan tidak diketahui sebelum edit | Regresi tak terduga |

---

## 3. Visi, Tujuan, dan Non-Tujuan

### 3.1 Visi

> Menjadi **lapisan intelijen lokal** antara codebase developer dan AI coding agent.

ScopeCairn **tidak menggantikan** agent. ScopeCairn menyediakan **konteks** dan **batasan kerja**.

```text
Developer → Antigravity IDE → AI Agent ──(CLI)──▶ ScopeCairn
                                                     ├── Code Graph
                                                     ├── Graph Retrieval
                                                     └── Task Guard
                                                           ↓
                                                  Konteks relevan → Agent
```

### 3.2 Tujuan

| ID | Tujuan | Deskripsi |
|---|---|---|
| **G1** | Memahami codebase | Mengindeks file, folder, function, class, variable, component, import/export, call, inheritance, dan dependency secara otomatis. |
| **G2** | Mengurangi eksplorasi | Dari 20–50 tool call menjadi 5–15 operasi terarah (target awal, divalidasi benchmark). |
| **G3** | Retrieval konteks | Menentukan file/simbol paling relevan terhadap task, dengan prioritas HIGH / MEDIUM / LOW. |
| **G4** | Task scope control | Mengarahkan agent mengerjakan **pekerjaan minimum yang diperlukan**. |
| **G5** | Change impact analysis | Menjawab: *"Apa yang terdampak jika file/simbol ini diubah?"* |
| **G6** | Pengetahuan persisten | Pengetahuan codebase tetap tersedia antar task. |
| **G7** | Pemanggilan otomatis | Agent memanggil ScopeCairn pada setiap task coding tanpa user perlu meminta. |

### 3.3 Non-Tujuan

ScopeCairn **bukan**:

- Pengganti Antigravity atau LLM
- IDE
- Penulis kode otomatis
- Platform CI/CD atau code hosting
- Alat yang mengubah source code tanpa persetujuan agent/user
- Jaminan bahwa kode selalu benar
- Server MCP
- Sistem berbasis embedding atau vector database

---

## 4. Keputusan Desain

| # | Keputusan | Alasan |
|---|---|---|
| D1 | **Tanpa MCP.** Integrasi lewat `AGENTS.md` + Skill + CLI. | Setup lebih sederhana; tidak ada server yang harus dijalankan. |
| D2 | **Tanpa embedding.** Retrieval berbasis knowledge graph. | Lebih ringan, deterministik, dapat dijelaskan, dan sepenuhnya lokal. |
| D3 | **Open source, lisensi MIT.** | Adopsi mudah; cocok untuk developer tool. |
| D4 | **Klasifikasi task** SIMPLE vs COMPLEX berdasarkan estimasi banyaknya perubahan kode pada file (§16). | Mencegah ScopeCairn menjadi beban pada task kecil. |
| D5 | **Tidak ada deteksi endpoint & database di MVP** (FR-13 kini diimplementasikan via framework adapters: prisma, drizzle, nextjs, express, fastapi, sqlalchemy, vue). Area database/API/auth tetap dilindungi lewat aturan *Protected* berbasis pola path (FR-07). | Mengurangi kompleksitas; adapter per framework menjadi fitur masa depan (§22). |
| D6 | **Pemanggilan dipicu agent**, bukan sistem. | Hook IDE belum terverifikasi; lihat §8. |
| D7 | **Bahasa: TypeScript (Node.js)**, didistribusikan lewat npm (`npm install -g` / `npx`). | Instalasi paling mudah bagi developer web yang memakai Antigravity; tanpa runtime tambahan. |
| D8 | **Nama produk dan paket: `scopecairn`** (sebelumnya CodeMind, lalu CodeSherpa). | `codemind` sudah dipakai proyek dengan niche serupa di npm; `codesherpa` sudah dipakai merek lain. Nama baru dicek bebas di npm, PyPI, dan GitHub. |

---

## 5. Pengguna & Use Case

### 5.1 Pengguna Utama

Developer yang memakai AI coding agent: frontend, backend, full-stack, solo developer, dan developer startup.

### 5.2 Use Case

#### UC-01 — Indexing Awal

User menjalankan `scopecairn init`.

```text
Scan repository → deteksi bahasa → parse source → ekstrak simbol
→ bangun relasi → simpan knowledge graph → generate AGENTS.md & Skill
```

#### UC-02 — Retrieval Konteks untuk Task

**Input:** *"Tambahkan fitur approval request."*

```text
Ekstraksi keyword → cari seed node (symbol index) → ekspansi graph
→ ranking node → bangun konteks
```

| Prioritas | File |
|---|---|
| HIGH | `RequestService.ts`, `ApprovalService.ts`, `RequestController.ts`, `RequestRepository.ts` |
| MEDIUM | `auth.middleware.ts`, `notification.service.ts` |
| TEST | `Approval.test.ts` |

#### UC-03 — Change Impact

**Input:** *"Saya ingin mengubah `RequestService`."*

```text
RequestService
├── diimpor oleh  → RequestController
├── memanggil     → ApprovalService
├── memakai       → RequestRepository
└── diuji oleh    → RequestService.test
```

| Level | Komponen |
|---|---|
| HIGH | `RequestController`, `ApprovalService`, `RequestRepository` |
| MEDIUM | `ApprovalPage` |
| TEST | `RequestService.test.ts` |

#### UC-04 — Penegakan Task Minimal

**Task:** *"Fix login redirect bug."*

| Diizinkan | Dihindari |
|---|---|
| `src/auth/login.ts` | Refactor UI |
| `src/auth/redirect.ts` | Upgrade dependency |
| `src/auth/middleware.ts` | Migrasi database |
| `tests/auth/login.test.ts` | Cleanup yang tidak diminta |

#### UC-05 — Pengetahuan Persisten

Task pertama: *"Pahami arsitektur autentikasi."* ScopeCairn menyimpan:

```text
Authentication
  Frontend : Next.js
  Backend  : FastAPI
  Provider : Microsoft Entra ID
  Token    : JWT
  Entry    : src/auth/login.ts
```

Task berikutnya (*"Tambahkan logout"*) memakai pengetahuan ini tanpa eksplorasi ulang.

#### UC-06 — Pemanggilan Otomatis

User mengetik prompt coding biasa di Antigravity. Agent membaca `AGENTS.md`, menjalankan `scopecairn context "<prompt>"`, dan memakai hasilnya tanpa user menyebut ScopeCairn.

---

## 6. Prinsip Produk

1. **Understand before exploring** — pengetahuan lebih dulu, eksplorasi belakangan.
2. **Retrieve before reading** — cari konteks relevan sebelum membaca file penuh.
3. **Change only what matters** — modifikasi seminimal mungkin.
4. **Stop when done** — berhenti saat acceptance criteria terpenuhi.
5. **Accuracy over savings** — penghematan token tidak boleh mengorbankan keberhasilan task.
6. **Always safe to call** — memanggil ScopeCairn tidak pernah merugikan, bahkan untuk task sederhana.

---

## 7. Functional Requirements

Prioritas: **P0** = wajib MVP, **P1** = setelah MVP, **P2** = masa depan.

| ID | Requirement | Prioritas |
|---|---|---|
| FR-01 | Repository Scanner | P0 |
| FR-02 | AST Parser | P0 |
| FR-03 | Knowledge Graph | P0 |
| FR-04 | Graph-Based Retrieval | P0 |
| FR-05 | Ranking | P0 |
| FR-06 | Context Builder | P0 |
| FR-07 | Task Scope | P0 |
| FR-08 | Change Impact Analyzer | P1 |
| FR-09 | Agent Rules (`AGENTS.md`) | P0 |
| FR-10 | Auto-Invocation (Antigravity) | P0 |
| FR-11 | Integrasi Git | P1 |
| FR-12 | Incremental Indexing | P1 |
| FR-13 | *(Diimplementasikan: prisma, drizzle, nextjs, express, fastapi, sqlalchemy, vue)* | — |
| FR-14 | Task Complexity Classifier | P0 |

### FR-01 — Repository Scanner

- **Bahasa MVP:** TypeScript (`.ts`, `.tsx`), JavaScript (`.js`, `.jsx`), Python (`.py`)
- **Bahasa berikutnya:** Java, Go, Rust, PHP, C#
- Menghormati `.gitignore` dan `.scopecairnignore`.

### FR-02 — AST Parser

Memakai **Tree-sitter** untuk mengekstrak: function, class, method, import, export, variable, call, reference, interface, type, dan component.

### FR-03 — Knowledge Graph

| Relasi | Arti |
|---|---|
| `IMPORTS` / `EXPORTS` | Dependensi modul |
| `CALLS` | Pemanggilan fungsi/method |
| `EXTENDS` / `IMPLEMENTS` | Pewarisan & kontrak |
| `REFERENCES` / `USES` | Pemakaian simbol |
| `CONTAINS` | Hierarki file → class → method |
| `TESTS` | Test → kode yang diuji |

Setiap relasi memiliki `weight` dan `confidence` (relasi yang resolusinya tidak pasti, mis. pemanggilan dinamis, diberi confidence lebih rendah).

### FR-04 — Graph-Based Retrieval

Pengganti semantic search. Tanpa embedding, retrieval berjalan dalam tiga langkah:

```text
1. SEED     Ekstrak keyword dari task → cocokkan ke symbol index
            (nama simbol, path, signature, docstring, glossary)
2. EXPAND   Telusuri graph dari seed node melalui relasi,
            dengan bobot menurun per hop (maks. kedalaman dapat dikonfigurasi)
3. RANK     Beri skor tiap node (FR-05), ambil top-N
```

**Symbol index:** indeks teks ringan (SQLite FTS5) atas identifier yang sudah dipecah per konvensi (`camelCase`, `snake_case`, `PascalCase`). Ini bukan embedding; hanya pencocokan token untuk menemukan titik awal graph.

**Menangani sinonim** (mis. task "approval" vs kode `authorize`):

- Glossary opsional di `.scopecairn/glossary.yml` (alias istilah domain).
- Memory (G6) mempelajari alias dari task sebelumnya.
- Agent dapat mengulang query dengan istilah lain.

**Contoh:** input `"approval request"` → seed: `approveRequest()`, `ApprovalService`, `approval_status` → ekspansi: `RequestController`, `RequestRepository`, `Approval.test.ts`.

### FR-05 — Ranking

Skor akhir menggabungkan sinyal berikut. **Bobot awal adalah hipotesis** dan harus dikalibrasi lewat benchmark:

```text
Final Score = 0.30 × Seed Match        (kecocokan keyword ke symbol index)
            + 0.35 × Graph Proximity   (jarak & bobot relasi dari seed)
            + 0.15 × Centrality        (fan-in / pentingnya simbol)
            + 0.10 × Recency           (perubahan git terbaru)
            + 0.10 × Co-change         (sering berubah bersama seed, dari git log)
```

Bobot harus dapat dikonfigurasi.

### FR-06 — Context Builder

```markdown
# Task Context

## Task
Add approval workflow.

## Complexity
COMPLEX (estimasi 4 file, lintas modul)

## Relevant Files
### HIGH
- src/request/RequestService.ts
- src/request/ApprovalService.ts
- src/request/RequestController.ts
### MEDIUM
- src/auth/auth.middleware.ts

## Dependencies
RequestController → RequestService → ApprovalService → RequestRepository

## Related Tests
- RequestService.test.ts
- ApprovalService.test.ts

## Scope
Required: ... | Optional: ... | Protected: ...
```

### FR-07 — Task Scope

| Kategori | Contoh |
|---|---|
| **Required** | `RequestService.ts`, `ApprovalService.ts` |
| **Optional** | `Approval.test.ts` |
| **Protected** | Migrasi database, konfigurasi auth, `package.json` |

**Protected berbasis pola path (default):** daftar Protected dihasilkan dari pencocokan path, tanpa parsing framework. Dapat dikonfigurasi di `.scopecairn/protected.yml`.

```text
migrations/**    prisma/**    schema.prisma    *.sql    alembic/**
.env*            package.json    lockfile (package-lock.json, pnpm-lock.yaml, ...)
```

### FR-08 — Change Impact Analyzer

**Input:** file, symbol, function, atau class.
**Output:** Direct impact, indirect impact, tests, dan komponen UI.

### FR-09 — Agent Rules

`scopecairn init` menghasilkan `AGENTS.md` (isi lengkap di §8.3).

### FR-10 — Auto-Invocation

Lihat [§8](#8-auto-invocation-integrasi-antigravity).

### FR-11 — Integrasi Git

Memakai `git diff`, `git log`, dan `git blame` untuk sinyal **Recency** dan **Co-change** pada FR-05.

### FR-12 — Incremental Indexing

```text
File berubah → hash berubah?
  ├─ Tidak → lewati
  └─ Ya → parse ulang → update simbol → update relasi → update symbol index
```

Target awal: full scan ≈ 60 detik, update inkremental < 2 detik. **Harus divalidasi lewat benchmark, bukan diasumsikan.**

**Pemicu pembaruan (auto-refresh):** agent maupun user tidak perlu memanggil `scopecairn scan` secara manual. Setiap `scopecairn context` dan `scopecairn impact` menjalankan pembaruan inkremental singkat sebelum retrieval:

```text
scopecairn context "<task>"
  → bandingkan hash/mtime file dengan index
  → ada file berubah? ── Ya → parse ulang hanya file tersebut → lanjut retrieval
                      └─ Tidak → langsung retrieval
```

- Pembaruan hanya memproses file yang berubah, sehingga tidak membebani task sederhana.
- Jika jumlah file berubah sangat besar (mis. setelah `git pull` atau ganti branch), ScopeCairn memberi peringatan dan menyarankan `scopecairn scan` penuh, bukan memblokir agent.
- Flag `--no-refresh` tersedia untuk melewati pembaruan (debugging/benchmark).

### FR-13 - Framework Adapters (Diimplementasikan)

Deteksi endpoint dan referensi database lewat framework adapter **diimplementasikan**: nextjs, prisma, drizzle, express, fastapi, sqlalchemy, vue. Fungsi pengamanannya tetap dilengkapi aturan Protected berbasis pola path (FR-07).

### FR-14 — Task Complexity Classifier

Klasifikasi berdasarkan **estimasi banyaknya perubahan kode pada file**, dihitung dari hasil graph retrieval sebelum edit.

| Kriteria | SIMPLE | COMPLEX |
|---|---|---|
| Estimasi file yang diubah | ≤ 2 file | ≥ 3 file |
| Cakupan modul | 1 modul/folder | Lintas modul |
| Simbol yang diubah | Internal/lokal | Dipakai banyak tempat (fan-in tinggi) |
| Area sensitif | Tidak ada | Menyentuh file Protected (migrasi/skema DB, auth, konfigurasi) |

**Aturan:** COMPLEX bila **salah satu** kriteria COMPLEX terpenuhi. Ambang angka adalah titik awal dan dikalibrasi lewat benchmark.

**Eskalasi:** task dimulai sebagai SIMPLE; bila agent mendapati lebih dari 2 file harus diubah, ia memanggil ulang `scopecairn context --escalate` untuk konteks penuh.

---

## 8. Auto-Invocation (Integrasi Antigravity)

### 8.1 Tujuan

Ketika user memberi prompt coding, agent **otomatis** memanggil ScopeCairn tanpa diminta, tanpa MCP.

### 8.2 Keterbatasan

Pemanggilan **dipicu agent (LLM)**, bukan sistem: agent membaca instruksi lalu memutuskan menjalankannya. Hasilnya sangat konsisten bila instruksi tepat, tetapi tidak 100% deterministik. Satu-satunya pemanggilan yang deterministik adalah hook di level IDE; dukungan hook Antigravity belum terverifikasi, sehingga hook menjadi fase lanjutan (§22).

### 8.3 Tiga Lapisan

| Lapisan | File | Peran |
|---|---|---|
| 1. **Rule selalu aktif** | `AGENTS.md` | Dibaca setiap sesi; mewajibkan `scopecairn context` sebagai langkah pertama setiap task. |
| 2. **Skill** | `.agents/skills/scopecairn/SKILL.md` | Panduan lengkap; deskripsi dibuat memicu untuk **semua task coding**. |
| 3. **Workflow (opsional)** | `workflows/scopecairn.md` | Shortcut manual `/scopecairn` bila agent lupa. |

**Isi `AGENTS.md` (dibuat otomatis oleh `scopecairn init`):**

```markdown
# ScopeCairn

## Wajib untuk setiap task coding
Sebelum membaca file atau menjalankan grep, jalankan:

    scopecairn context "<permintaan user>"

Gunakan hasilnya sebagai titik awal. Jangan menjelajah repository dari nol.

## Selama bekerja
- Ubah hanya file di daftar Required dan Optional.
- Jangan sentuh file di daftar Protected tanpa persetujuan user.
- Sebelum mengubah simbol yang dipakai banyak tempat, jalankan:
  `scopecairn impact <path>`
- Butuh source sebuah fungsi? Gunakan `scopecairn read symbol <nama>`
  alih-alih membaca file penuh.

## Pengecualian
Lewati ScopeCairn hanya untuk pertanyaan non-coding.
```

**Isi `SKILL.md`:**

```markdown
---
name: scopecairn
description: Gunakan untuk SEMUA task coding (fitur baru, bug fix, refactor,
  pertanyaan tentang kode) sebelum menjelajah repository.
---

Langkah:
1. Jalankan `scopecairn context "<permintaan user>"`.
2. Baca bagian Relevant Files dan Task Scope.
3. Jika ada perubahan pada simbol bersama, jalankan `scopecairn impact <path>`.
4. Kerjakan task sesuai scope, lalu berhenti saat selesai.
```

### 8.4 Satu Entry Point Cerdas

Agent **selalu** memanggil satu perintah yang sama; ScopeCairn yang memutuskan seberapa banyak yang dikembalikan (lihat §16).

```bash
scopecairn context "<prompt user apa adanya>"
```

| Hasil klasifikasi | Output |
|---|---|
| SIMPLE | Pendek: "Task sederhana. Gunakan pencarian langsung. Kandidat: `file_a.ts`" |
| COMPLEX | Konteks lengkap + Task Scope |

Panggilan harus selesai dalam hitungan detik dan memberi output sangat ringkas untuk task sederhana.

### 8.4.1 Pembagian Peran: User vs Agent

| Siapa | Tugas |
|---|---|
| **User (sekali saja)** | Install ScopeCairn, jalankan `scopecairn init` di repository, dan (disarankan) memasukkan entri allowlist yang dicetak `init` ke pengaturan terminal Antigravity (§8.6). |
| **Agent (otomatis, tiap task)** | Menjalankan `scopecairn context`, lalu `impact` / `read symbol` bila perlu. Index diperbarui otomatis oleh ScopeCairn (AI-6). |

Setelah setup, user tidak perlu menyebut ScopeCairn atau menjalankan perintah apa pun.

### 8.5 Requirements

| ID | Requirement |
|---|---|
| AI-1 | `scopecairn init` menulis `AGENTS.md`, Skill, dan Workflow secara otomatis. |
| AI-2 | `init` mendeteksi nama folder konfigurasi Antigravity yang dipakai (`.agents/` atau `.agent/`) sesuai versi IDE. |
| AI-3 | `scopecairn doctor` memverifikasi file integrasi ada di lokasi yang benar. |
| AI-4 | Output CLI berformat Markdown ringkas agar mudah dipakai agent. |
| AI-5 | Setiap pemanggilan dicatat (lokal) untuk mengukur **compliance rate** (§18). |
| AI-6 | `scopecairn context` dan `scopecairn impact` menjalankan auto-refresh index inkremental (FR-12) agar agent tidak perlu memanggil `scan` dan konteks tidak usang. |
| AI-7 | `scopecairn init` mencetak daftar entri allowlist yang direkomendasikan (§8.6) beserta lokasi pengaturannya di Antigravity. ScopeCairn **tidak pernah menulis** ke pengaturan Antigravity secara otomatis. |
| AI-8 | Perintah untuk agent dirancang **read-only terhadap source** (hanya menulis ke folder `.scopecairn/`), sehingga aman di-allowlist. Perintah yang mengubah/menghapus data (`init`, `clean`, `rebuild`) tidak direkomendasikan masuk allowlist. |
| AI-9 | Prefix perintah di `AGENTS.md`, Skill, dan daftar allowlist harus **identik** (mis. `scopecairn context` vs `npx scopecairn context` dianggap berbeda). `init` mendeteksi cara install dan menulis prefix yang konsisten. |

### 8.6 Panduan Konfigurasi Allowlist

Antigravity memiliki kebijakan eksekusi terminal (Request Review, Auto, Always Proceed), **Allow List**, dan **Deny List**. ScopeCairn tidak mengubah izin ini sendiri; ScopeCairn **memandu user** mengaturnya.

**Prinsip:**

1. Hanya allowlist subcommand yang aman, **bukan** prefix `scopecairn` secara keseluruhan.
2. ScopeCairn hanya mencetak panduan; user yang memasukkannya sendiri di pengaturan.
3. Prefix di allowlist harus sama persis dengan yang dipakai di `AGENTS.md` (AI-9).

| Kategori | Perintah | Dijalankan oleh |
|---|---|---|
| **Direkomendasikan masuk allowlist** | `scopecairn context`, `scopecairn impact`, `scopecairn read`, `scopecairn query`, `scopecairn graph`, `scopecairn status`, `scopecairn doctor` | Agent (otomatis) |
| **Jangan di-allowlist** | `scopecairn init`, `scopecairn scan`, `scopecairn rebuild`, `scopecairn clean` | User (manual, di terminal) |

**Contoh output `scopecairn init`:**

```text
Agar agent dapat memakai ScopeCairn tanpa persetujuan per panggilan,
tambahkan entri berikut ke Terminal Allow List Antigravity
(Settings → Advanced Settings → Terminal):

  scopecairn context
  scopecairn impact
  scopecairn read
  scopecairn query
  scopecairn graph
  scopecairn status
  scopecairn doctor

Catatan: ScopeCairn tidak mengubah pengaturan IDE Anda secara otomatis.
```

**Hal yang perlu diwaspadai:**

- **Allow List terutama dipakai pada kebijakan terminal "Off/Request Review".** Pada kebijakan otomatis penuh, allowlist tidak diperlukan.
- **Strict Mode mengabaikan allowlist**; semua perintah tetap perlu persetujuan manual. `doctor` menampilkan pengingat ini.
- **Pengaturan global dan workspace bisa tidak sinkron**, dan beberapa pengguna melaporkan perintah yang sudah di-allowlist tetap meminta persetujuan. Panduan troubleshooting: cek kedua level pengaturan dan restart agent/IDE.
- **Hindari perintah berantai** (`&&`, pipe) pada instruksi di `AGENTS.md`, karena pencocokan allowlist berbasis prefix perintah. Perilaku ini perlu diverifikasi di versi target.
- Antigravity CLI memiliki berkas pengaturan terpisah dengan format entri berbeda; dukungan konfigurasinya menjadi fase lanjutan.

---

## 9. Non-Functional Requirements

| Kategori | Requirement |
|---|---|
| **Performa** | Target latensi retrieval dan indexing ditetapkan setelah benchmark awal (acuan: FR-12). |
| **Skalabilitas** | Menangani repository berukuran puluhan ribu file tanpa degradasi berarti. |
| **Keandalan** | Index rusak dapat dipulihkan dengan `scopecairn rebuild`. |
| **Portabilitas** | Windows, macOS, dan Linux; Node.js 20 atau lebih baru. |
| **Observabilitas** | `scopecairn status` dan `scopecairn doctor`. |
| **Zero network** | ScopeCairn tidak melakukan panggilan jaringan; tidak butuh API key atau model eksternal. |
| **Determinisme** | Input yang sama dan index yang sama menghasilkan output yang sama. |

---

## 10. Arsitektur

```text
┌────────────────────────────────────────────┐
│               Antigravity IDE               │
│        (AGENTS.md · Skill · Workflow)       │
└──────────────────────┬─────────────────────┘
                       │ agent menjalankan CLI
                       ▼
┌────────────────────────────────────────────┐
│            ScopeCairn Agent Layer           │
│  Complexity Classifier · Context Retriever  │
│  Task Scope Controller · Impact Analyzer    │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│              Knowledge Engine               │
│  AST Parser · Code Graph · Symbol Index     │
│  Memory                                     │
└──────────────────────┬─────────────────────┘
                       ▼
┌────────────────────────────────────────────┐
│          Storage Layer (SQLite)             │
│  files · symbols · relationships · memories │
└────────────────────────────────────────────┘
```

**Alur utama:**

```text
Prompt → scopecairn context → Complexity Check
   ├─ SIMPLE  → saran pencarian langsung (ringkas)
   └─ COMPLEX → seed → ekspansi graph → ranking → konteks + scope
→ Agent bekerja → hasil diukur
```

---

## 11. Tech Stack

| Lapisan | Pilihan | Catatan |
|---|---|---|
| Bahasa | **TypeScript** (dikompilasi ke JavaScript) | Dipublikasikan sebagai paket npm |
| Runtime | **Node.js ≥ 20** | Ditetapkan lewat field `engines` |
| CLI | `commander` | Ringan dan umum dipakai |
| AST | **`web-tree-sitter`** (WASM) | Tanpa kompilasi native; instalasi lebih aman lintas platform |
| Database | **SQLite** via `better-sqlite3` | Cepat; graph disimpan sebagai tabel simpul & relasi |
| Symbol index | **SQLite FTS5** | Pencocokan token identifier; bukan embedding |
| Build | `tsup` | Menghasilkan satu bundle CLI |
| Backend server | Tidak diperlukan di MVP | Tanpa MCP; semua lewat CLI |

### 11.1 Distribusi & Instalasi

```bash
npx scopecairn init              # coba tanpa install
npm install -g scopecairn        # install global (disarankan)
npm install -D scopecairn        # install per proyek
```

- Perintah CLI didaftarkan lewat field `bin` di `package.json`; nama perintah sama dengan nama paket (`scopecairn`).
- **Install global disarankan** untuk auto-invocation: `npx` murni bisa lebih lambat karena mengecek registry saat dijalankan.
- Untuk mode `-D`, `init` menulis prefix `npx scopecairn` ke `AGENTS.md`, Skill, dan panduan allowlist (AI-9).
- **Nama paket: `scopecairn`.** Saat dicek, nama ini (termasuk varian `scope-cairn`) belum dipakai di npm, PyPI, maupun GitHub. *Cairn* adalah tumpukan batu penanda jalur di gunung (memandu), dan *scope* mengacu pada batas kerja task. **Segera publikasikan versi `0.0.1` untuk mengamankan nama.** Pemeriksaan merek dagang resmi dan ketersediaan domain belum dilakukan.
- **Risiko native:** `better-sqlite3` adalah modul native; bila binary siap pakai tidak tersedia di suatu platform, instalasi bisa gagal. Alternatif yang perlu diverifikasi: `node:sqlite` bawaan Node (termasuk dukungan FTS5-nya).

---

## 12. Data Model

| Tabel | Kolom |
|---|---|
| `files` | id, path, language, hash, size, created_at, updated_at |
| `symbols` | id, file_id, name, type, signature, start_line, end_line |
| `relationships` | id, source_id, target_id, relationship_type, weight, confidence |
| `symbol_index` (FTS5) | symbol_id, tokens |
| `tasks` | id, description, complexity, created_at, completed_at |
| `task_context` | task_id, symbol_id, score, reason |
| `memories` | id, category, key, value, confidence, created_at, updated_at |
| `invocations` | id, task_id, command, timestamp *(untuk compliance rate)* |

---

## 13. CLI

| Perintah | Fungsi |
|---|---|
| `scopecairn init` | Indexing awal + generate `AGENTS.md`, Skill, Workflow |
| `scopecairn scan` | Update graph (inkremental) |
| `scopecairn status` | Status index |
| `scopecairn query "<teks>"` | Cari simbol/pengetahuan codebase |
| `scopecairn context "<task>"` | **Entry point utama**: auto-refresh index + klasifikasi + konteks + scope |
| `scopecairn context --escalate` | Minta konteks penuh untuk task yang membesar |
| `scopecairn impact <path>` | Analisis dampak perubahan |
| `scopecairn graph <symbol>` | Tampilkan relasi sebuah simbol |
| `scopecairn read symbol <nama>` | Ambil source sebuah simbol (on demand) |
| `scopecairn doctor` | Cek kesehatan integrasi |
| `scopecairn rebuild` | Bangun ulang seluruh knowledge |
| `scopecairn clean` | Hapus data hasil generate |

**Contoh output `scopecairn init` (angka ilustratif):**

```text
ScopeCairn
✓ Repository detected
✓ 1,284 files found
✓ 932 source files
✓ 8,421 symbols
✓ 14,230 relationships
Antigravity integration:
✓ AGENTS.md generated
✓ Skill installed
✓ Workflow installed
Ready.
```

**Contoh output `scopecairn doctor`:**

```text
✓ Node.js  ✓ Tree-sitter  ✓ Database  ✓ Repository index
✓ Symbol index  ✓ AGENTS.md  ✓ Skill  ✓ Antigravity config path
Status: HEALTHY
```

---

## 14. Optimasi Token & Konteks

ScopeCairn **tidak boleh memotong teks secara kasar**. Urutan prioritas:

1. Buang konteks yang tidak relevan
2. Hindari konteks duplikat
3. Pilih konteks level simbol, bukan level file
4. Gunakan ringkasan untuk kode yang sudah dikenal
5. Ambil source asli hanya bila diperlukan

| ❌ Buruk | ✅ Baik |
|---|---|
| Seluruh `RequestService.ts` | `RequestService.approve()` |
| Seluruh `RequestController.ts` | `RequestController.approve()` |
| Seluruh README | `ApprovalRepository.create()` |
| Seluruh skema database | Kolom relevan di `TRX_REQUEST` + test terkait |

**Context compression:** file mentah (`RequestService.ts`, 284 baris) menjadi ringkasan simbol:

```text
approveRequest()
- memvalidasi request
- memeriksa status saat ini
- memanggil repository
- membuat audit trail
```

Jika agent butuh source: `scopecairn read symbol approveRequest`.

---

## 15. Task Guard & Definition of Done

### 15.1 Aturan Task Guard (*Do Less*)

1. Jangan refactor kecuali diperlukan.
2. Jangan ubah file yang tidak terkait.
3. Jangan upgrade dependency kecuali diminta.
4. Jangan buat abstraksi prematur.
5. Jangan tulis ulang kode yang sudah berjalan.
6. Jangan tambah komentar untuk kode yang sudah jelas.
7. Jangan buat file baru kecuali perlu.
8. Berhenti saat acceptance criteria terpenuhi.

### 15.2 Definition of Done

- ✅ Fungsionalitas yang diminta terimplementasi
- ✅ Test relevan lulus
- ✅ Tidak ada file yang berubah tanpa alasan
- ✅ Tidak ada refactoring yang tidak terkait
- ✅ Acceptance criteria terpenuhi

Agent **tidak perlu**: membersihkan seluruh repository, mengupdate dependency, mendesain ulang arsitektur, atau memformat file yang tidak terkait.

---

## 16. Cost-Aware Routing

**Risiko terbesar produk:** ScopeCairn menambah kompleksitas yang biayanya lebih besar daripada manfaatnya.

```text
Task sederhana
  Tanpa ScopeCairn: grep → edit → selesai
  Dengan ScopeCairn: index → graph → retrieve → context → edit  ← gagal
```

Karena itu routing dilakukan di dalam ScopeCairn (FR-14), sehingga agent cukup memanggil satu perintah:

```text
TASK → Complexity Check
         ├─ SIMPLE  → output ringkas, tanpa ekspansi graph penuh/impact analysis
         └─ COMPLEX → seed + ekspansi graph + impact + task scope
```

| Jenis task | Contoh | Pendekatan |
|---|---|---|
| Sederhana | "Ubah warna tombol" | Kandidat file langsung |
| Kompleks | "Refactor alur autentikasi" | Graph retrieval penuh + impact + scope |

Kriteria klasifikasi: lihat FR-14.

---

## 17. Privasi & Keamanan

### 17.1 Privasi

- **Local-first dan zero network:** ScopeCairn tidak mengirim source code ke mana pun dan tidak memakai API eksternal.
- Satu-satunya data yang keluar dari mesin adalah apa yang agent/IDE kirim ke LLM-nya sendiri; ScopeCairn hanya memperkecil jumlahnya.

### 17.2 Keamanan

ScopeCairn harus:

- Tidak menjalankan source code yang dianalisis
- Tidak mengeksekusi perintah arbitrer tanpa persetujuan user/agent
- Menghormati `.gitignore` dan `.scopecairnignore`
- Tidak mengindeks secret secara default (`.env`, `.env.*`, `*.pem`, `*.key`, `credentials.*`, `secrets.*`)
- Tidak memuat nilai secret ke dalam konteks yang dihasilkan

### 17.3 `.scopecairnignore` (contoh)

```text
node_modules/
.next/
dist/
build/
coverage/
.git/

.env
.env.*
*.pem
*.key

*.min.js
*.map
```

---

## 18. Metrik & Benchmark

### 18.1 Metrik Utama

| Metrik | Rumus / Definisi | Target MVP |
|---|---|---|
| Context reduction | `1 − optimized_context / original_context` | ≥ 30% |
| Exploration reduction | Tool call baseline vs dengan ScopeCairn | ≥ 30% |
| Task success | `task berhasil / total task` | ≥ baseline |
| Irrelevant file ratio | `file tidak relevan / file diambil` | < 20% |
| **Compliance rate** | `task di mana agent memanggil ScopeCairn / total task coding` | Ditetapkan setelah benchmark awal |
| Retrieval recall | `file yang akhirnya diubah agent yang ada di konteks / total file diubah` | Ditetapkan setelah benchmark awal |

> **Prinsip:** token turun **dan** task success tidak turun.

### 18.2 Desain Benchmark

- **Dataset:** 10–50 task coding nyata
- **Perbandingan:** Agent saja vs Agent + ScopeCairn
- **Diukur:** token usage, tool call, file dibaca, waktu, task success, file dimodifikasi, modifikasi tidak perlu, compliance rate, retrieval recall

**Contoh format hasil (angka ilustratif):**

| Metrik | Baseline | ScopeCairn |
|---|---:|---:|
| Input token | 40K | 24K |
| Tool call | 31 | 18 |
| File dibaca | 27 | 11 |
| Waktu | 6 mnt | 4 mnt |
| Success | 90% | 92% |
| File tak terkait diubah | 4 | 1 |

### 18.3 Kriteria Keberhasilan

| Area | Kriteria |
|---|---|
| Eksplorasi | Penurunan ≥ 30% |
| Konteks tidak relevan | Penurunan ≥ 30% |
| Token | Rata-rata input token turun ≥ 20% |
| Kualitas | Task success tidak turun lebih dari 5% |
| Developer experience | Agent terasa lebih cepat, fokus, tidak repetitif, dan tidak destruktif |

---

## 19. Scope MVP & Roadmap

### 19.1 MVP — Termasuk

1. Repository scanner
2. Tree-sitter parsing
3. Code graph + symbol index (FTS5)
4. Graph-based retrieval & ranking
5. Task complexity classifier
6. Aturan Protected berbasis pola path (migrasi, skema DB, auth, konfigurasi)
7. Generate `AGENTS.md`, Skill, Workflow
8. Aturan task scope
9. CLI

### 19.2 MVP — Tidak Termasuk

Dashboard web, cloud, multi-user, memory kompleks, perencanaan otonom lanjutan, multi-agent, hook IDE.

### 19.3 Roadmap

> Estimasi waktu adalah perkiraan awal.

| Fase | Minggu | Fokus | Output |
|---|---|---|---|
| 1. Foundation | 1 | CLI, scanner, Tree-sitter, sistem ignore, SQLite | Repo terindeks |
| 2. Knowledge Graph | 2 | Simbol, relasi, penyimpanan & traversal graph | Graph dapat di-query |
| 3. Context Engine | 3 | Symbol index, graph retrieval, ranking, complexity classifier, context builder | `scopecairn context` berfungsi |
| 4. Agent Optimization | 4 | Task scope, Task Guard, aturan kerja minimal | Agent terarahkan |
| 5. Auto-Invocation | 5 | `AGENTS.md`, Skill, Workflow, `init`/`doctor`, logging invocation | Agent memanggil ScopeCairn otomatis |
| 6. Benchmark | 6 | Baseline, benchmark, token, akurasi, compliance, recall, kalibrasi bobot | Laporan benchmark |

---

## 20. Risiko & Asumsi

| # | Risiko / Asumsi | Mitigasi |
|---|---|---|
| R1 | Kompleksitas ScopeCairn melebihi manfaatnya | Cost-aware routing (§16); ukur lewat benchmark |
| R2 | Agent tidak selalu memanggil ScopeCairn (non-deterministik) | Tiga lapisan instruksi; ukur compliance rate; hook di fase lanjutan |
| R3 | Nama folder/format konfigurasi Antigravity berbeda antar versi | Deteksi di `init`; verifikasi di `doctor` |
| R4 | Tanpa embedding, query bersinonim bisa meleset dari seed node | Tokenisasi identifier, glossary, memory alias, agent mengulang query; ukur retrieval recall |
| R5 | Konteks terlalu dikompresi sehingga akurasi turun | Gerbang metrik task success; mode `SAFE` (masa depan) |
| R6 | Bobot ranking tidak optimal | Bobot configurable; kalibrasi dengan benchmark |
| R7 | Index usang setelah perubahan kode | Auto-refresh inkremental berbasis hash di setiap `scopecairn context` / `impact` (FR-12, AI-6) |
| R8 | Kebocoran secret ke index/konteks | Ignore default, scanner secret |
| R9 | Akurasi graph rendah di bahasa/framework dinamis | Skor `confidence`; mulai dari TS/JS/Python; ukur precision relasi |
| R10 | Allowlist belum dikonfigurasi, atau tidak berlaku (Strict Mode, pengaturan global/workspace tidak sinkron), sehingga agent tetap meminta persetujuan per perintah | Panduan allowlist di `init` (AI-7, §8.6); perintah agent read-only (AI-8); prefix konsisten (AI-9); pengingat di `doctor`; dokumentasi troubleshooting |
| R11 | Instalasi `better-sqlite3` gagal di platform tertentu (modul native) | Binary prebuilt; instruksi troubleshooting; evaluasi `node:sqlite`; `doctor` mendeteksi masalah |
| R12 | Nama paket `scopecairn` diambil pihak lain sebelum dipublikasikan, atau ternyata bentrok dengan merek lain | Publikasikan `0.0.1` segera; cek merek dagang dan domain (§11.1) |

---

## 21. Pertanyaan Terbuka

| # | Pertanyaan | Status |
|---|---|---|
| 1 | Apakah Antigravity versi target mendukung hook untuk pemanggilan deterministik? | Terbuka |
| 2 | Folder konfigurasi mana yang dipakai versi target (`.agents/` atau `.agent/`)? | Terbuka, diverifikasi saat implementasi |
| 3 | Apakah seed matching berbasis FTS5 + glossary cukup tanpa embedding? | Divalidasi lewat retrieval recall di benchmark |
| 4 | Berapa compliance rate minimum yang dapat diterima? | Ditetapkan setelah benchmark awal |
| 5 | Ambang angka FR-14 (≤ 2 file dst.) sudah tepat? | Dikalibrasi lewat benchmark |
| 6 | Apakah allowlist Antigravity mencocokkan perintah berantai (`&&`, pipe) dan argumen panjang dengan benar, serta apakah ada cara resmi mendistribusikan allowlist per proyek? | Terbuka, diverifikasi di versi target |

**Sudah diputuskan:** tanpa MCP (D1), tanpa embedding (D2), open source MIT (D3), kriteria SIMPLE/COMPLEX (FR-14), dengan framework adapter FR-13 (D5 direvisi), TypeScript/Node.js (D7), nama produk dan paket `scopecairn` (D8).

---

## 22. Fitur Masa Depan

| Fitur | Deskripsi |
|---|---|
| **Hook IDE** | Pemanggilan `scopecairn context` otomatis dan deterministik di awal task, bila Antigravity mendukung. |
| **Codebase memory lanjutan** | Menyimpan keputusan arsitektur, mis. "Kami memakai Repository Pattern untuk akses database." |
| **Architecture detection** | Mendeteksi lapisan Frontend → API → Service → Repository → Database. |
| **Dependency risk** | Menandai file berisiko tinggi, mis. direferensikan 18 komponen. |
| **Automated change impact** | Analisis dampak sebelum edit dan analisis regresi potensial setelah edit. |
| **Smart test selection** | Menjalankan hanya test yang relevan, bukan seluruh test suite. |
| **Mode agent** | `NORMAL`, `FAST`, `SAFE`, `AUDIT` untuk mengatur agresivitas filter konteks. |
| **Framework adapter** | Deteksi endpoint (`ROUTES_TO`) dan referensi database (`QUERIES`) untuk Next.js, FastAPI, Express, Prisma, SQLAlchemy, dan framework lain lewat kontribusi komunitas. |
| **Web dashboard** | `http://localhost:8787` — kesehatan index, token yang dihemat. |

---

## 23. Rekomendasi Implementasi

Mulai dari **satu core loop**, jangan membangun semuanya sekaligus:

```text
Prompt user
 ↓
Agent memanggil `scopecairn context` (otomatis via AGENTS.md)
 ↓
ScopeCairn: seed → ekspansi graph → konteks minimal + scope
 ↓
Agent memodifikasi kode
 ↓
Ukur hasil (token, tool call, success, compliance, recall)
```

Validasi core loop ini dengan benchmark kecil sebelum menambah fitur lain. Dua hal yang paling perlu dibuktikan lebih dulu: **agent benar-benar memanggil ScopeCairn** (compliance rate) dan **graph tanpa embedding cukup menemukan file yang tepat** (retrieval recall).
