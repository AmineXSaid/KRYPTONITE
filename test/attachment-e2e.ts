/**
 * Does an attached file actually reach the model? Real API, real answer.
 *
 * Run: npx esbuild test/attachment-e2e.ts --bundle --outfile=dist/att.cjs \n *        --format=cjs --platform=node --target=node20 && OR_KEY=... node dist/att.cjs
 *
 * compose() mirrors SessionController.send() exactly. If that diverges this
 * test stops proving anything, so keep them together.
 */
import { decodeTextAttachment } from "../src/ui/session";
import { EndpointClient } from "../src/providers/client";
import { draftProfile } from "../src/endpoints/check";

const KEY = process.env.OR_KEY ?? "";
let pass = 0, fail = 0;
const ck = (ok: boolean, l: string, d = "") => { ok ? pass++ : fail++; console.log(`${ok?"PASS":"FAIL"}  ${l}${d?"  — "+d:""}`); };

/** The exact composition session.send() performs. */
function compose(text: string, files: { name: string; mediaType: string; data: string }[]) {
  const parts: string[] = [];
  const notes: string[] = [];
  for (const a of files.filter(f => !f.mediaType.startsWith("image/"))) {
    const decoded = decodeTextAttachment(a.data);
    if (decoded === undefined) { notes.push(`${a.name} is not text`); continue; }
    const CAP = 60_000;
    const body = decoded.length > CAP ? decoded.slice(0, CAP) : decoded;
    const cut = decoded.length > CAP ? `\n… truncated at ${CAP} of ${decoded.length} characters` : "";
    parts.push(`Attached file \`${a.name}\`:\n\n\`\`\`\n${body}${cut}\n\`\`\``);
  }
  return { composed: [text, ...parts].filter(Boolean).join("\n\n"), notes };
}

async function main() {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  // A fact the model cannot know unless it read the file.
  const secret = "The mooring coefficient is 47.219 kryptons.";
  const file = { name: "spec.txt", mediaType: "text/plain", data: b64(`# Spec\n\n${secret}\n`) };

  const { composed, notes } = compose("What is the mooring coefficient? Answer with the number only.", [file]);
  ck(composed.includes(secret), "composed message contains the file body");
  ck(composed.includes("Attached file `spec.txt`"), "file is labelled by name");
  ck(notes.length === 0, "no skip notes for a text file");

  const big = { name: "big.txt", mediaType: "text/plain", data: b64("x".repeat(70000)) };
  const r2 = compose("hi", [big]);
  ck(r2.composed.includes("truncated at 60000 of 70000"), "oversize file states its truncation");
  ck(r2.composed.length < 61000, "and is actually cut", String(r2.composed.length));

  const png = { name: "a.png", mediaType: "image/png", data: b64("\x89PNG\r\n\x1a\n") };
  const r3 = compose("hi", [png]);
  ck(!r3.composed.includes("Attached file"), "an image is not inlined as text");

  const bin = { name: "a.pdf", mediaType: "application/pdf", data: Buffer.from([0x25,0x50,0x44,0x46,0,1,2]).toString("base64") };
  const r4 = compose("hi", [bin]);
  ck(r4.notes.length === 1 && !r4.composed.includes("Attached file"), "binary is reported, not pasted");

  if (!KEY) { console.log("\nOR_KEY unset; skipping live read."); return done(); }

  console.log("\n──── live: can the model read the attached file? ────");
  const profile = draftProfile({ id:"openrouter", name:"OpenRouter", url:"https://openrouter.ai/api/v1",
    type:"openai-compatible", model:"openrouter/free", timeoutMs: 90000 } as any);
  const client = new EndpointClient(profile, (k)=> k==="openrouter/api_key" ? KEY : undefined, process.cwd());
  let out = "";
  try {
    for await (const ev of client.complete({ messages:[{ role:"user", content: composed }], stream:false, maxTokens:64 })) {
      if (ev.type === "text") out += ev.text;
    }
  } catch (e:any) { ck(false, "live call", e.message); await client.close(); return done(); }
  console.log(`   model said: ${JSON.stringify(out.trim().slice(0,120))}`);
  ck(/47\.219|47,219/.test(out), "the model answered from the file's contents");
  await client.close();
  done();
}
function done(){ console.log(`\n──── ${pass} passed, ${fail} failed ────`); process.exit(fail?1:0); }
main().catch(e=>{ console.error("THREW", e); process.exit(1); });
