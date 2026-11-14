import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A merge can drop a closing brace without breaking the build: the browser then nests every later
// rule inside the open block and they stop applying. Walk the stylesheet (skipping comments and
// strings) and check every block closes, and that plain rules are never opened inside plain rules.
function cssProblems(css: string): string[] {
  const problems: string[] = [];
  const stack: { at: boolean; line: number }[] = [];
  let line = 1;
  let prelude = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "\n") line++;
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      line += (css.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== c) j += css[j] === "\\" ? 2 : 1;
      prelude += css.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "{") {
      const at = prelude.trim().startsWith("@");
      const parent = stack[stack.length - 1];
      if (parent && !parent.at && !at) problems.push(`line ${line}: rule opened inside the block from line ${parent.line}`);
      stack.push({ at, line });
      prelude = "";
    } else if (c === "}") {
      if (!stack.pop()) problems.push(`line ${line}: "}" with no open block`);
      prelude = "";
    } else if (c === ";") {
      prelude = "";
    } else {
      prelude += c;
    }
  }
  for (const open of stack) problems.push(`line ${open.line}: block never closed`);
  return problems;
}

describe("stylesheet", () => {
  it("closes every block it opens", () => {
    const css = readFileSync(join(import.meta.dirname, "src", "styles.css"), "utf8");
    expect(cssProblems(css)).toEqual([]);
  });

  it("catches a block left open by a merge", () => {
    expect(cssProblems(".a {\n  margin: 0;\n.b { padding: 0; }\n")).toEqual([
      "line 3: rule opened inside the block from line 1",
      "line 1: block never closed",
    ]);
    expect(cssProblems("@media (min-width: 1px) { .a { color: red; } }\n/* { */ .b { content: \"}\"; }")).toEqual([]);
  });
});
