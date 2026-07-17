import { spawnSync } from "node:child_process";

// Invokes a Convex function by string name — the graph must count this as a
// live reference even though no `api.`/`internal.` chain appears.
spawnSync("npx", ["convex", "run", "funcs:stringCalled", "{}"]);

// Colon-bearing strings that do NOT resolve to a function must stay inert.
const notARef = "https://example.com:8080/path";
const alsoNotARef = "12:30";
console.log(notARef, alsoNotARef);
