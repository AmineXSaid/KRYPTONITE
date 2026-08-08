import * as path from "node:path";
import * as fs from "node:fs";
import * as vm from "node:vm";
import type { EndpointProfile } from "./profile";

/**
 * The escape hatch. If a gateway is shaped in a way no adapter anticipates,
 * the profile points at a .js file in the workspace that reshapes the request
 * on the way out and the response on the way in. No PR to this repo required.
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
      // Deliberately narrow. Transforms reshape JSON; they don't need the
      // filesystem or the network.
      if (["node:path", "path"].includes(id)) return path;
      throw new Error(`Transforms may not require "${id}".`);
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
