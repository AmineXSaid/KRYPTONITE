/**
 * A minimal ZIP reader, for attachments.
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY
 *
 * The panel ships two runtime dependencies, `undici` and `yaml`, and a zip
 * library would be a third carried for one feature on one code path. Reading
 * an archive is a central directory, a local header per entry, and
 * `zlib.inflateRawSync` - all of which node already has. The whole reader is
 * below and it is shorter than the notice file entry would be.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not write anything to disk, so the classic zip-slip escape does not
 * apply. Entry names are still refused when they are absolute or contain
 * `..`, because those names are printed and go into the prompt, and a path
 * that claims to be `/etc/passwd` is worth refusing on the way in rather than
 * explaining later.
 *
 * It does not support encryption, multi-disk archives, or the compression
 * methods nobody uses. An entry it cannot read is reported by name rather
 * than skipped silently: "you attached an archive and got fewer files than it
 * holds" is the failure worth making visible.
 */
import * as zlib from "node:zlib";

/** Signatures, little-endian, as they appear in the file. */
const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The comment is a 16-bit length, so the EOCD starts within this of the end. */
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
  /** The path as recorded in the archive, with `\` normalised to `/`. */
  name: string;
  /** Bytes once expanded. */
  size: number;
  /** True for a directory record, which carries no data. */
  directory: boolean;
  /** Reads and decompresses this entry. Throws with the entry named. */
  read(): Buffer;
}

export interface ZipListing {
  entries: ZipEntry[];
  /** Entries that could not be listed, each with the reason. */
  problems: string[];
}

function isZip(buf: Buffer): boolean {
  // "PK\x03\x04" for an ordinary archive, "PK\x05\x06" for an empty one.
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b &&
    ((buf[2] === 3 && buf[3] === 4) || (buf[2] === 5 && buf[3] === 6) ||
     (buf[2] === 7 && buf[3] === 8));
}

/** Scan backwards for the end-of-central-directory record. */
function findEocd(buf: Buffer): number {
  const floor = Math.max(0, buf.length - MAX_COMMENT - 22);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

/**
 * Where the central directory starts, and how many entries it holds.
 *
 * Zip64 is read rather than refused: an archive with more than 65,535 entries
 * or crossing 4GB stores those two numbers as sentinels in the 32-bit record
 * and the real ones in a second record before it. Ignoring that reads the
 * sentinel `0xFFFF` as an entry count and produces sixty-five thousand
 * failures instead of a listing.
 */
function locateDirectory(buf: Buffer, eocd: number): { offset: number; count: number } {
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count !== 0xffff && offset !== 0xffffffff) return { offset, count };

  // The zip64 locator sits immediately before the EOCD.
  const loc = eocd - 20;
  if (loc < 0 || buf.readUInt32LE(loc) !== EOCD64_LOCATOR) return { offset, count };
  const rec = Number(buf.readBigUInt64LE(loc + 8));
  if (rec < 0 || rec + 56 > buf.length || buf.readUInt32LE(rec) !== EOCD64) {
    return { offset, count };
  }
  count = Number(buf.readBigUInt64LE(rec + 32));
  offset = Number(buf.readBigUInt64LE(rec + 48));
  return { offset, count };
}

/**
 * A name that is safe to print and to use as a label.
 *
 * Returns null for anything absolute, anything walking upwards, and anything
 * carrying a NUL or a drive letter.
 */
function safeName(raw: string): string | null {
  const name = raw.replace(/\\/g, "/");
  if (!name || name.includes("\0")) return null;
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  if (name.split("/").some((seg) => seg === "..")) return null;
  return name;
}

/**
 * Read an entry's data.
 *
 * The filename and extra-field lengths are read from the LOCAL header, not
 * from the central directory: the two are allowed to differ, and several
 * writers put a different extra field in each. Taking the central directory's
 * lengths lands the read a few bytes off the start of the data, which
 * inflates to garbage or throws - intermittently, depending on the writer.
 */
function readEntry(buf: Buffer, localOffset: number, method: number,
                   compressedSize: number, name: string): Buffer {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) {
    throw new Error(`${name}: local header missing or corrupt`);
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const end = start + compressedSize;
  if (end > buf.length) throw new Error(`${name}: truncated`);
  const raw = buf.subarray(start, end);
  if (method === 0) return Buffer.from(raw);
  if (method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`${name}: unsupported compression method ${method}`);
}

/**
 * List an archive without expanding anything.
 *
 * Nothing is decompressed here on purpose: the caller decides which entries
 * are worth reading, and a listing that inflated every entry to answer "what
 * is in this file" would expand a zip bomb to answer a question about its
 * table of contents.
 */
export function readZip(buf: Buffer): ZipListing {
  const problems: string[] = [];
  if (!isZip(buf)) throw new Error("not a zip archive");

  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error("no end-of-central-directory record - truncated or not a zip");

  const { offset, count } = locateDirectory(buf, eocd);
  const entries: ZipEntry[] = [];
  let p = offset;

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) {
      problems.push(`central directory ends after ${i} of ${count} entries`);
      break;
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    const name = safeName(rawName);
    if (name === null) {
      problems.push(`${JSON.stringify(rawName)} was skipped - the name escapes the archive`);
      continue;
    }
    // A directory record is a name ending in `/` with no data. Kept in the
    // listing so a caller can show the shape of the archive, and marked so
    // nobody tries to read it.
    const directory = name.endsWith("/");
    entries.push({
      name, size, directory,
      read: () => directory
        ? Buffer.alloc(0)
        : readEntry(buf, localOffset, method, compressedSize, name),
    });
  }
  return { entries, problems };
}

/**
 * The media type for a file inside an archive whose extension the MIME table
 * does not name.
 *
 * The table is deliberately short - it exists so a dragged `.png` is offered
 * as an image - and an archive of a project is mostly extensions nobody would
 * put in it: `.ts`, `.py`, `.go`, `.rs`, `.toml`, `Dockerfile`, `Makefile`.
 * Treating those as `application/octet-stream` means the pipeline decodes
 * them, fails, and reports "not a text file" for the whole source tree.
 *
 * Returns null for anything that is genuinely not worth attaching, which is
 * how the caller decides to skip it.
 */
const TEXTUAL = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".scala", ".swift",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".m", ".mm",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
  ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte",
  ".sql", ".graphql", ".proto", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".gradle", ".tf", ".tfvars", ".lua", ".pl", ".php", ".r", ".jl", ".ex", ".exs",
  ".txt", ".md", ".markdown", ".rst", ".adoc", ".csv", ".tsv",
  ".yaml", ".yml", ".xml", ".svg", ".log", ".diff", ".patch",
]);

/** Extensionless files that are text by convention. */
const TEXTUAL_NAMES = new Set([
  "dockerfile", "makefile", "rakefile", "gemfile", "procfile",
  "license", "licence", "readme", "changelog", "authors", "notice",
  "codeowners", "gitignore", "dockerignore", "npmrc", "nvmrc", "editorconfig",
]);

export function guessTextType(name: string): string | null {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot <= 0 ? "" : base.slice(dot);
  if (ext && TEXTUAL.has(ext)) return "text/plain";
  // `.gitignore` and friends are all extension and no stem, so the leading
  // dot is stripped before the by-name lookup rather than adding every
  // dotfile to the extension set twice.
  const stem = dot === 0 ? base.slice(1) : dot === -1 ? base : "";
  if (stem && TEXTUAL_NAMES.has(stem)) return "text/plain";
  return null;
}
