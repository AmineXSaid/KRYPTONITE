import * as path from "node:path";
import * as fs from "node:fs";
import * as vm from "node:vm";
import type { EndpointProfile } from "./profile";

/**
 * The escape hatch. If a gateway is shaped in a way no adapter anticipates,
 * the profile points at a .js file in the workspace that reshapes the request
 * on the way out and the response on the way in. No PR to this repo required.
 *
 * THIS IS TRUSTED CODE, AND THE COMMENT HERE USED TO IMPLY OTHERWISE.
 *
 * The `require` shim below is narrow, and the note beside it said transforms
 * "don't need the filesystem or the network" as though that were enforced. It
 * is not, and cannot be: `vm.runInNewContext` is an isolation primitive for
 * accidents, not for adversaries, and every host object handed into the
 * context is a door out of it - `Buffer.constructor.constructor("return
 * process")()` is the whole exploit. A transform runs with the full authority
 * of the extension host, exactly like `.agent/mcp.json`, which spawns
 * processes by design.
 *
 * So the shim stays, because it catches the honest mistake of reaching for
 * `fs` in a function that only has to reshape JSON, and the pretence goes. A
 * profile with a `transform:` is code you are choosing to run.
 */
export interface Transform {
  transformRequest?: (body: any, profile: EndpointProfile) => any;
  transformResponse?: (body: any, profile: EndpointProfile) => any;
}

export function loadTransform(rel: string, workspaceRoot: string): Transform {
  const file = path.isAbsolute(rel) ? rel : path.join(workspaceRoot, rel);
  if (!fs.existsSync(file)) {
    throw new Error(`Transform module not found at ${file}.`);
  }
  const source = fs.readFileSync(file, "utf8");
  const module = { exports: {} as any };
  const sandbox = {
    module,
    exports: module.exports,
    console,
    Buffer,
    URL,
    URLSearchParams,
    require: (id: string) => {
      // A guardrail, not a boundary - see the note on Transform above. It
      // exists so a transform that reaches for `fs` fails with a sentence
      // saying it should not need it, rather than quietly working.
      if (["node:path", "path"].includes(id)) return path;
      throw new Error(
        `Transforms may not require "${id}". A transform reshapes JSON; if it needs to do ` +
          `more than that, the work belongs in the gateway or in a profile field.`
      );
    },
  };
  try {
    vm.runInNewContext(source, sandbox, { filename: file, timeout: 5000 });
  } catch (e: any) {
    throw new Error(`Transform ${path.basename(file)} failed to load: ${e.message}`);
  }
  const t = module.exports as Transform;
  if (typeof t.transformRequest !== "function" && typeof t.transformResponse !== "function") {
    throw new Error(
      `Transform ${path.basename(file)} exports neither transformRequest nor transformResponse.`
    );
  }
  return guard(t, path.basename(file));
}

/** How long one transform call may take before it is treated as a hang. */
const CALL_BUDGET_MS = 2000;

/**
 * Wrap the exported functions so one bad transform cannot take the host with it.
 *
 * `runInNewContext`'s `timeout` bounds the LOAD and nothing else. These
 * functions are then called on every request and on every streamed frame, with
 * no bound at all, on the extension host's only thread - so a loop in a
 * transform wedged the whole window, with no message and no way back except
 * killing VS Code. A synchronous call cannot be interrupted once it is running,
 * so what this can do is notice and refuse to keep calling it: the first
 * overrun turns the transform off for the rest of the session and says why.
 */
function guard(t: Transform, name: string): Transform {
  let broken = "";
  const wrap = <A extends any[], R>(fn: ((...a: A) => R) | undefined) => {
    if (!fn) return undefined;
    return (...args: A): R => {
      if (broken) throw new Error(broken);
      const t0 = Date.now();
      const out = fn(...args);
      const ms = Date.now() - t0;
      if (ms > CALL_BUDGET_MS) {
        broken =
          `Transform ${name} took ${ms}ms for a single call and has been disabled for this ` +
          `session. It runs on every request and on every streamed frame, on the same thread ` +
          `as the editor. Fix the transform and reload the window.`;
      }
      return out;
    };
  };
  return {
    transformRequest: wrap(t.transformRequest),
    transformResponse: wrap(t.transformResponse),
  };
}
