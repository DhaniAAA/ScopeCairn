// Tokenizer identifier (PRD FR-04): pecah camelCase, PascalCase,
// snake_case, kebab-case, dan path — untuk SEED matching di FTS5.
// Ini pencocokan token, bukan embedding.

const STOP = new Set([
  "the", "a", "an", "of", "to", "in", "for", "on", "with", "and", "or",
  "src", "lib", "app", "test", "tests", "spec",
]);

/** Bentuk dasar ringan untuk pencocokan FTS5: jamak → tunggal,
 *  -ing → dasar, -ation/-tion → dasar (configuration → config).
 *  Bukan stemmer penuh — hanya varian aman untuk recall seed. */
function stemVariants(t: string): string[] {
  const out = new Set<string>([t]);
  // Jamak: dependencies → dependency, weights → weight, configs → config.
  if (t.endsWith("ies") && t.length > 4) out.add(t.slice(0, -3) + "y");
  else if (t.endsWith("es") && t.length > 4 && /(s|x|z|ch|sh)es$/.test(t)) out.add(t.slice(0, -2));
  else if (t.endsWith("s") && t.length > 3 && !t.endsWith("ss")) out.add(t.slice(0, -1));
  // -ing: ranking → rank; tambah varian +e untuk tuning → tune.
  // Varian sampah (ranke) tak masalah: FTS5 OR hanya cocok bila ada di index.
  if (t.endsWith("ing") && t.length > 5) {
    const base = t.slice(0, -3);
    out.add(base);
    out.add(base + "e");
  }
  // -ation/-tion: configuration → config, classification → classific (parsial).
  if (t.endsWith("ation") && t.length > 7) {
    const base = t.slice(0, -5);
    out.add(base);
    // configuration → configur + e? tidak — petakan eksplisit di bawah.
  }
  // -er/-ed: tokenizer → tokenize, parser → parse.
  if ((t.endsWith("er") || t.endsWith("ed")) && t.length > 5) {
    out.add(t.slice(0, -1));
    out.add(t.slice(0, -2));
  }
  return [...out];
}

// Alias eksplisit yang tak tercakup aturan di atas.
const EXPLICIT_STEM = new Map<string, string>([
  ["configuration", "config"],
  ["configurations", "config"],
  ["configured", "config"],
  ["ranking", "rank"],
  ["ranked", "rank"],
  ["weights", "weight"],
  ["dependencies", "dependency"],
  ["dependency", "depend"],
  ["extraction", "extract"],
  ["extracted", "extract"],
]);

// Sinonim domain minimal (recall seed): istilah domain <-> istilah kode.
// Bidirectional: kupon <-> voucher, invoice <-> billing, dst. Hanya tambah
// mapping — tidak menghapus EXPLICIT_STEM di atas.
const DOMAIN_SYNONYMS = new Map<string, string>([
  // Kupon / diskon
  ["kupon", "voucher"],
  ["voucher", "kupon"],
  ["coupon", "voucher"],
  ["promo", "voucher"],
  ["diskon", "discount"],
  ["discount", "diskon"],
  // Penagihan
  ["invoice", "billing"],
  ["billing", "invoice"],
  ["tagihan", "invoice"],
  ["pembayaran", "payment"],
  ["payment", "pembayaran"],
  ["pelunasan", "payment"],
  // Pengguna / akun
  ["pengguna", "user"],
  ["akun", "account"],
  ["account", "akun"],
  // Keranjang / pesanan
  ["keranjang", "cart"],
  ["cart", "keranjang"],
  ["troli", "cart"],
  ["pesanan", "order"],
  ["order", "pesanan"],
  ["checkout", "order"],
  // Pengiriman / stok
  ["pengiriman", "shipping"],
  ["shipping", "pengiriman"],
  ["ongkir", "shipping"],
  ["stok", "stock"],
  ["stock", "stok"],
  ["inventaris", "stock"],
  // Produk / harga
  ["harga", "price"],
  ["price", "harga"],
  ["produk", "product"],
  ["product", "produk"],
  // Auth umum
  ["masuk", "login"],
  ["login", "masuk"],
  ["daftar", "signup"],
  ["logout", "signout"],
  ["signout", "logout"],
]);

export function tokenizeIdentifier(raw: string): string[] {
  const parts = raw
    .replace(/[\\/]/g, " ")
    .replace(/[.:\-_"']/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  const out = new Set<string>();
  for (const t of parts) {
    out.add(t);
    for (const v of stemVariants(t)) {
      if (v.length >= 2 && !STOP.has(v)) out.add(v);
    }
    const e = EXPLICIT_STEM.get(t);
    if (e && !STOP.has(e)) out.add(e);
    const d = DOMAIN_SYNONYMS.get(t);
    if (d && !STOP.has(d)) out.add(d);
  }
  return [...out];
}

export function tokenizeTask(text: string): string[] {
  return tokenizeIdentifier(text);
}
