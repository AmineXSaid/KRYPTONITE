/**
 * The archive reader, against archives a real zip writer produced.
 *
 * Written against real output rather than a hand-built byte fixture on
 * purpose: the bugs this code can have are all about where a field actually
 * sits - the local header's name and extra lengths differing from the central
 * directory's, zip64 sentinels, a stored entry beside a deflated one - and a
 * fixture built from the same misreading passes a broken reader.
 *
 * The one hand-built case is the bomb, because no ordinary writer produces
 * one and it is the input the bounds exist for.
 *
 * Run: npx esbuild test/zip.ts --bundle --outfile=dist/zip.cjs \
 *        --format=cjs --platform=node --target=node20 && node dist/zip.cjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { readZip, guessTextType } from "../src/core/zip";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}${detail ? "  — " + detail : ""}`);
    return;
  }
  failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`FAIL  ${label}${detail ? "  — " + detail : ""}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kx-zip-"));
const has = (() => {
  try { execFileSync("zip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
})();

/** Build an archive from a {path: contents} map using the system zip. */
function makeZip(name: string, files: Record<string, string>, extra: string[] = []): Buffer {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const out = path.join(tmp, `${name}.zip`);
  execFileSync("zip", ["-q", "-r", ...extra, out, "."], { cwd: dir });
  return fs.readFileSync(out);
}

/* ── 1. an ordinary archive ────────────────────────────────────────────── */
if (!has) {
  console.log("SKIP  no `zip` on PATH");
} else {
  const buf = makeZip("plain", {
    "README.md": "# Title\n\nSome prose.\n",
    "src/index.ts": "export const x = 1;\n",
    "src/deep/nested/thing.py": "print('hi')\n",
  });
  const { entries, problems } = readZip(buf);
  ok("no problems reading an ordinary archive", problems.length === 0, problems.join("; "));

  const byName = new Map(entries.filter((e) => !e.directory).map((e) => [e.name, e]));
  ok("every file is listed", byName.size === 3,
    [...byName.keys()].join(", "));
  ok("nested paths keep their shape", byName.has("src/deep/nested/thing.py"),
    [...byName.keys()].join(", "));

  // The content, which is the only thing that proves the data offset is right.
  // A reader that lands a few bytes off inflates to garbage rather than
  // throwing, so comparing bytes is the assertion and listing names is not.
  ok("a file's contents come back exactly",
    byName.get("README.md")!.read().toString("utf8") === "# Title\n\nSome prose.\n",
    JSON.stringify(byName.get("README.md")!.read().toString("utf8")));
  ok("and so does a nested one",
    byName.get("src/index.ts")!.read().toString("utf8") === "export const x = 1;\n");

  // Directory records carry no data and must be marked, or the caller reads
  // them and attaches a run of empty files named after folders.
  ok("directory records are marked", entries.some((e) => e.directory), String(entries.length));
  ok("and directories are not counted as files",
    [...byName.keys()].every((n) => !n.endsWith("/")));
}

/* ── 2. stored entries, beside deflated ones ───────────────────────────── */
if (has) {
  // `-0` stores without compressing. A reader that assumes method 8 inflates
  // stored bytes as a raw deflate stream and throws; one that assumes method 0
  // hands back compressed bytes as text. Both are silent until you read the
  // content, which is why this reads it.
  const buf = makeZip("stored", { "a.txt": "stored contents\n" }, ["-0"]);
  const e = readZip(buf).entries.find((x) => x.name === "a.txt");
  ok("a stored (uncompressed) entry is read", !!e);
  ok("and its bytes are the file's bytes",
    e!.read().toString("utf8") === "stored contents\n",
    JSON.stringify(e!.read().toString("utf8")));
}

/* ── 3. a file big enough to actually compress ─────────────────────────── */
if (has) {
  // The short files above may be stored even without `-0`, because deflate can
  // be larger than the input. This one is unambiguously deflated, so it is the
  // case that exercises inflateRawSync.
  const body = "The quick brown fox jumps over the lazy dog. ".repeat(500);
  const buf = makeZip("big", { "big.txt": body });
  const e = readZip(buf).entries.find((x) => x.name === "big.txt")!;
  ok("a deflated entry inflates to the original", e.read().toString("utf8") === body,
    `${e.read().length} vs ${body.length}`);
  ok("and the archive is smaller than its contents", buf.length < body.length,
    `${buf.length} vs ${body.length}`);
}

/* ── 4. what is not an archive ─────────────────────────────────────────── */
{
  let threw = "";
  try { readZip(Buffer.from("this is just text, not a zip at all")); }
  catch (e) { threw = e instanceof Error ? e.message : String(e); }
  ok("a non-archive is refused by signature", /not a zip/.test(threw), threw);

  // Truncation is the realistic corruption: a partial download has the right
  // first four bytes and no central directory.
  if (has) {
    const full = makeZip("trunc", { "a.txt": "x".repeat(2000) });
    let msg = "";
    try { readZip(full.subarray(0, 64)); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    ok("a truncated archive is refused with a reason", msg.length > 0 && !/undefined/.test(msg), msg);
  }
}

/* ── 5. names that escape the archive ──────────────────────────────────── */
{
  /* Hand-built, because no ordinary writer emits these. The reader never
     writes to disk, so this is not zip-slip - but the names are printed and
     reach the prompt, and a file claiming to be `/etc/passwd` is worth
     refusing on the way in. */
  const mk = (name: string) => {
    const nameBuf = Buffer.from(name, "utf8");
    const body = Buffer.from("x");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);            // stored
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42);
    const cdStart = local.length + nameBuf.length + body.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBuf.length, 12);
    eocd.writeUInt32LE(cdStart, 16);
    return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
  };

  for (const bad of ["../../etc/passwd", "/etc/passwd", "C:\\Windows\\system32\\x", "..\\..\\x"]) {
    const r = readZip(mk(bad));
    ok(`"${bad}" is refused rather than listed`,
      r.entries.length === 0 && r.problems.length === 1,
      JSON.stringify({ entries: r.entries.map((e) => e.name), problems: r.problems }));
  }
  // And the control: a name that only LOOKS alarming is fine, because it does
  // not escape. Refusing this would be a reader nobody can put a project into.
  const okName = readZip(mk("src/..thing/a..b.txt"));
  ok("a name containing dots but escaping nothing is kept",
    okName.entries.length === 1 && okName.entries[0].name === "src/..thing/a..b.txt",
    JSON.stringify(okName.entries.map((e) => e.name)));
}

/* ── 6. a bomb is bounded by the CALLER, and the listing stays cheap ───── */
{
  /* The listing must not decompress anything. If it did, answering "what is
     in this archive" would expand the bomb - so this builds one entry whose
     declared size is a gigabyte and checks that listing it costs nothing. */
  const payload = zlib.deflateRawSync(Buffer.alloc(1024 * 1024));
  const nameBuf = Buffer.from("bomb.bin");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(1024 * 1024 * 1024, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(1024 * 1024 * 1024, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + nameBuf.length + payload.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  const buf = Buffer.concat([local, nameBuf, payload, central, nameBuf, eocd]);

  const t0 = Date.now();
  const r = readZip(buf);
  const ms = Date.now() - t0;
  ok("listing an archive does not decompress it", ms < 200, `${ms}ms`);
  ok("and the declared size is reported for the caller to bound on",
    r.entries[0].size === 1024 * 1024 * 1024, String(r.entries[0].size));
}

/* ── 7. which files inside an archive are worth attaching ──────────────── */
{
  // The MIME table in app.ts is short by design - it exists so a dragged .png
  // is offered as an image. An archive of a project is mostly extensions
  // nobody would drag on their own, and treating those as octet-stream makes
  // the pipeline report "not a text file" for a whole source tree.
  for (const n of ["a.ts", "b.py", "c.go", "d.rs", "e.toml", "f.sql", "g.tf"]) {
    ok(`${n} inside an archive is treated as text`, guessTextType(n) === "text/plain");
  }
  for (const n of ["Dockerfile", "Makefile", "src/.gitignore", "LICENSE"]) {
    ok(`${n} is treated as text despite having no useful extension`,
      guessTextType(n) === "text/plain", String(guessTextType(n)));
  }
  for (const n of ["a.exe", "b.so", "c.class", "d.wasm", "e.bin"]) {
    ok(`${n} is not offered as text`, guessTextType(n) === null, String(guessTextType(n)));
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n──── ${pass} passed, ${failures.length} failed ────`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(1);
}
