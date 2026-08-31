import * as path from "node:path";
import * as fs from "node:fs";
import * as vm from "node:vm";
import type { EndpointProfile } from "./profile";

/**
 * The escape hatch. If a gateway is shaped in a way no adapter anticipates,
 * the profile points at a .js file in the workspace that reshapes the request
 * on the way out and the response on the way in. No PR to this repo required.
 *
 * A TRANSFORM IS ARBITRARY CODE RUNNING IN THE EXTENSION HOST.
 *
 * It is loaded with `node:vm`, and the narrow `require` below used to carry a
 * comment saying transforms "don't need the filesystem or the network" - which
 * reads as a claim that they cannot reach them. They can. `vm` is an isolation
 * primitive, not a security boundary: the sandbox is handed real host objects
 * (`Buffer`, `console`) and `Buffer.constructor.constructor("return process")()`
 * walks straight back out to the host regardless of what `require` returns.
 * Node's own documentation says so.
 *
 * The `require` gate is kept because it is genuinely useful - it turns an
 * honest mistake into a clear error rather than a working dependency on
 * something that will not be there on the next machine - but it is a
 * guardrail, not a wall, and nothing here should be relied on to contain a
 * hostile file.
 *
 * What actually contains this is VS Code's workspace trust: the manifest
 * declares `untrustedWorkspaces.supported: false`, so Genesis does not run at
 * all in a folder the user has not trusted. That is the boundary. This is a
 * convenience layer inside it.
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
      // Deliberately narrow, as a guardrail rather than a wall - see the note
      // at the top of this file about what `vm` does and does not contain. A
      // transform that reaches for `fs` has almost always misunderstood the
      // job, and a clear error here beats a working dependency that is absent
      // on the next machine.
      if (["node:path", "path"].includes(id)) return path;
      throw new Error(
        `Transforms may not require "${id}". They reshape a JSON body and nothing else; ` +
          `anything needing the filesystem or the network belongs in an exec credential ` +
          `helper or a gateway in front of the endpoint.`
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
  return t;
}
