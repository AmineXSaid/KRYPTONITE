/**
 * Configuration that was accepted and then quietly did the wrong thing.
 *
 * Three failures, all of them silent, all of them things a hundred people
 * writing YAML by hand will produce between them within a week:
 *
 *   capabilities.contextWindow: 128k
 *     YAML makes that the STRING "128k". `fitToWindow` computes
 *     `limit - reserve` and gets NaN; every comparison against NaN is false,
 *     so the early return is skipped AND the drop loop never runs, and the
 *     function inserts "Earlier turns were dropped to stay within the context
 *     window" on every single request having dropped nothing. The meter reads
 *     `x / NaN` next to it. `fitImages` guards its own budget explicitly and
 *     says why; this field had no such guard.
 *
 *   maxOutputTokens >= contextWindow
 *     The budget goes negative, history is cut to the last two messages on
 *     every turn, and the model appears to forget the conversation it is
 *     having. The two fields sit adjacent in every example profile.
 *
 *   two profiles with the same name
 *     `name` is what activeProfile looks up, what the client pool is keyed on,
 *     and what the auth cache is keyed on - so a duplicate serves one
 *     profile's cached token over the other's transport, and which one won
 *     depended on readdir order.
 *
 * Plus `retries`, which was parsed, defaulted, shown in the Control Center and
 * read by nothing - so the people this extension is for set it against a flaky
 * gateway and concluded the gateway was worse than it is.
 *
 * Run: npx esbuild test/profile-config.ts --bundle --outfile=dist/profile-config.cjs \
 *        --format=cjs --platform=node --target=node20 --alias:vscode=./test/vscode-stub.ts
 *      node dist/profile-config.cjs
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { loadProfile, loadAllProfiles, ProfileError } from "../src/endpoints/profile";
import { EndpointClient } from "../src/providers/client";
import { App } from "../src/core/app";
import { reset, makeContext, __cfg } from "./vscode-stub";

let pass = 0;
const failures: string[] = [];
function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) pass++;
  else failures.push(label + (detail ? "  — " + detail : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail && !cond ? "  — " + detail : ""}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kx-cfg-"));
const EXT = path.resolve(".");

/** Write a profile and try to load it. Returns the error message, or "". */
function refuses(yaml: string, name = "p.yaml"): string {
  const at = path.join(TMP, name);
  fs.writeFileSync(at, yaml, "utf8");
  try {
    loadProfile(at);
    return "";
  } catch (e) {
    return e instanceof ProfileError ? e.message : String(e);
  }
}

const BASE = "name: p\nwire: openai\nbaseUrl: https://x\nmodel: m\n";

/**
 * Remove the scratch directory, and never fail the run over it.
 *
 * The shadow repository spawns git, and a git process can still be flushing
 * objects when the last assertion has already passed - so the recursive delete
 * races it and throws ENOTEMPTY. `force: true` covers a directory that is
 * already gone; it does not cover one that is still being written to.
 *
 * A leftover directory in the system temp folder is not a defect in the thing
 * under test, and reporting it as one turns a green suite red for a reason
 * nobody can act on.
 */
function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* a temp directory outliving the test is not a failure */
  }
}

(async () => {
  console.log("──── capabilities that are not numbers ────");
  {
    // The exact thing a person writes, and the exact thing YAML does with it.
    const k = refuses(BASE + "capabilities:\n  contextWindow: 128k\n");
    ok("128k is refused rather than becoming NaN", k !== "", "it was accepted");
    ok("and the message names the field", /contextWindow/.test(k), k);
    ok("and says how to write it", /128000/.test(k), k);

    ok("a quoted number is refused too",
      refuses(BASE + 'capabilities:\n  contextWindow: "128000"\n') !== "");
    ok("so is a negative window",
      refuses(BASE + "capabilities:\n  contextWindow: -1\n") !== "");
    ok("so is zero", refuses(BASE + "capabilities:\n  contextWindow: 0\n") !== "");
    ok("and maxImageBytes is held to the same rule",
      refuses(BASE + "capabilities:\n  maxImageBytes: 2mb\n") !== "");

    ok("a real number is accepted",
      refuses(BASE + "capabilities:\n  contextWindow: 128000\n  maxOutputTokens: 8192\n") === "");
  }

  console.log("\n──── a reply that cannot fit in its own window ────");
  {
    const m = refuses(BASE + "capabilities:\n  contextWindow: 32000\n  maxOutputTokens: 32000\n");
    ok("equal values are refused", m !== "", "accepted, and every turn would forget everything");
    ok("and both numbers are in the message", /32000/.test(m), m);
    ok("larger is refused too",
      refuses(BASE + "capabilities:\n  contextWindow: 8000\n  maxOutputTokens: 16000\n") !== "");
    ok("and a sane pair is fine",
      refuses(BASE + "capabilities:\n  contextWindow: 32000\n  maxOutputTokens: 4096\n") === "");
  }

  console.log("\n──── two profiles claiming one name ────");
  {
    const dir = path.join(TMP, "dupes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "a.yaml"), BASE.replace("name: p", "name: gateway"), "utf8");
    fs.writeFileSync(path.join(dir, "b.yaml"), BASE.replace("name: p", "name: gateway"), "utf8");
    fs.writeFileSync(path.join(dir, "c.yaml"), BASE.replace("name: p", "name: other"), "utf8");

    const { profiles, errors } = loadAllProfiles(dir);
    ok("only one of the two is loaded", profiles.filter((p) => p.name === "gateway").length === 1);
    ok("the other is reported as an error", errors.some((e) => /Two profiles are called/.test(e.message)));
    ok("naming both files", errors.some((e) => /a\.yaml/.test(e.message) && /b\.yaml/.test(e.message)),
      errors.map((e) => e.message).join(" | "));
    ok("and the unrelated profile is unaffected", profiles.some((p) => p.name === "other"));
  }

  console.log("\n──── a selection that no longer resolves ────");
  {
    const root = path.join(TMP, "ws");
    fs.mkdirSync(path.join(root, ".agent", "endpoints"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".agent", "endpoints", "internal.yaml"),
      "name: internal-gw\nwire: openai\nbaseUrl: https://gw.corp\nmodel: m\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, ".agent", "endpoints", "hosted.yaml"),
      "name: hosted\nwire: openai\nbaseUrl: https://api.example.com\nmodel: m\n",
      "utf8"
    );

    reset(root);
    __cfg.set("activeProfile", "internal-gw");
    const storage = path.join(TMP, "st");
    fs.mkdirSync(storage, { recursive: true });
    const app = new App(makeContext(storage, EXT) as any);
    await app.init();
    ok("the configured profile is selected", app.activeProfile()?.name === "internal-gw");

    // Now break it, exactly as a typo in the YAML would.
    fs.writeFileSync(
      path.join(root, ".agent", "endpoints", "internal.yaml"),
      "name: internal-gw\nwire: openai\nbaseUrl: https://gw.corp\nmodel: m\n  bad: [indent\n",
      "utf8"
    );
    await app.reload("test");

    /* THE POINT OF THE WHOLE SECTION.
     *
     * `?? this.profiles[0]` used to be unconditional, so this returned the
     * OTHER profile and the next message - and everything in it - went to a
     * different company's endpoint with nothing on screen saying so. */
    ok(
      "a broken selection does not silently fall through to another endpoint",
      app.activeProfile() === undefined,
      `selected ${app.activeProfile()?.name}`
    );
    const why = app.activeProfileProblem();
    ok("it says which profile is missing", /internal-gw/.test(why?.message ?? ""), why?.message);
    ok("and points at the file that failed to load", /did not load/.test(why?.fix ?? ""), why?.fix);
    ok("naming it", /internal\.yaml/.test(why?.fix ?? ""), why?.fix);
    ok("and saying which profiles did load", /hosted did load/.test(why?.fix ?? ""), why?.fix);

    // Nothing selected at all is a different case and still picks the one
    // profile there is: asking someone to choose from a list of one is a step
    // for nothing.
    __cfg.set("activeProfile", "");
    ok("with nothing selected, the first profile is used", app.activeProfile()?.name === "hosted");
    ok("and that is not reported as a problem", app.activeProfileProblem() === undefined);

    // A name that never existed gets its own sentence.
    __cfg.set("activeProfile", "typo-gw");
    const gone = app.activeProfileProblem();
    ok("a name that matches nothing is reported", gone !== undefined);
    ok("and the message lists what IS available", /hosted/.test(gone?.fix ?? ""), gone?.fix);

    await app.dispose();
  }

  console.log("\n──── retries, which used to do nothing at all ────");
  {
    let hits = 0;
    let failUntil = 0;
    const srv = http.createServer((req, res) => {
      hits++;
      if (hits <= failUntil) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("upstream unavailable");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as any).port;

    const write = (retries: number) => {
      const at = path.join(TMP, `r${retries}.yaml`);
      fs.writeFileSync(
        at,
        `name: r${retries}\nwire: openai\nbaseUrl: http://127.0.0.1:${port}\nmodel: m\n` +
          `retries: ${retries}\ncapabilities:\n  streaming: true\n`,
        "utf8"
      );
      return loadProfile(at);
    };

    const drain = async (client: EndpointClient) => {
      let text = "";
      for await (const ev of client.complete({ messages: [{ role: "user", content: "hi" }] })) {
        if (ev.type === "text") text += ev.text;
      }
      return text;
    };

    // Two transient 503s, with a budget of two retries.
    hits = 0; failUntil = 2;
    const c2 = new EndpointClient(write(2), () => undefined, TMP);
    ok("a 5xx is retried and the turn succeeds", (await drain(c2)) === "ok");
    ok("it took exactly three attempts", hits === 3, `${hits} requests`);
    await c2.close();

    // The same failure with retries off must still fail, and say 503.
    hits = 0; failUntil = 2;
    const c0 = new EndpointClient(write(0), () => undefined, TMP);
    let msg = "";
    try { await drain(c0); } catch (e: any) { msg = e.message; }
    ok("with retries: 0 the failure is surfaced", /503/.test(msg), msg);
    ok("and only one request was made", hits === 1, `${hits} requests`);
    await c0.close();

    // A budget that cannot cover the failure reports the real status rather
    // than a retry count.
    hits = 0; failUntil = 9;
    const c1 = new EndpointClient(write(1), () => undefined, TMP);
    msg = "";
    try { await drain(c1); } catch (e: any) { msg = e.message; }
    ok("exhausting the budget reports the endpoint's own status", /503/.test(msg), msg);
    ok("after the configured number of attempts", hits === 2, `${hits} requests`);
    await c1.close();

    // A 4xx is the request being wrong. Sending it again is a slower way to be
    // told so, and on a 429 it is actively unhelpful.
    const four = http.createServer((req, res) => {
      hits++;
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
    });
    await new Promise<void>((r) => four.listen(0, "127.0.0.1", r));
    const p4 = (four.address() as any).port;
    const at4 = path.join(TMP, "four.yaml");
    fs.writeFileSync(
      at4,
      `name: four\nwire: openai\nbaseUrl: http://127.0.0.1:${p4}\nmodel: m\nretries: 3\n`,
      "utf8"
    );
    hits = 0;
    const c4 = new EndpointClient(loadProfile(at4), () => undefined, TMP);
    try { await drain(c4); } catch { /* expected */ }
    ok("a 4xx is never retried", hits === 1, `${hits} requests`);
    await c4.close();
    four.close();
    srv.close();
  }

  cleanup(TMP);
  console.log(`\n${pass} passed, ${failures.length} failed`);
  for (const f of failures) console.log("  FAIL " + f);
  process.exit(failures.length ? 1 : 0);
})();
