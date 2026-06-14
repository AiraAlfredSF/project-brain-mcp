// Tests for parser/treesitter.ts — the AST → edges walker.

import { describe, expect, it } from "vitest";

import {
  getLanguageForExtension,
  isEntryPointPath,
  parseFileEdges,
  SUPPORTED_EXTENSIONS,
} from "./treesitter.js";


describe("getLanguageForExtension / SUPPORTED_EXTENSIONS", () => {
  it("returns a language factory for every supported extension", () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      const f = getLanguageForExtension(ext);
      expect(f).not.toBeNull();
    }
  });

  it("returns null for unsupported extensions", () => {
    expect(getLanguageForExtension(".md")).toBeNull();
    expect(getLanguageForExtension(".json")).toBeNull();
    expect(getLanguageForExtension(".html")).toBeNull();
  });

  it("is case-insensitive on extension match", () => {
    expect(getLanguageForExtension(".TS")).not.toBeNull();
    expect(getLanguageForExtension(".JS")).not.toBeNull();
  });
});

describe("isEntryPointPath (Spec 02 §9 heuristic)", () => {
  it("matches index.<ext> anywhere in the path (basename)", () => {
    expect(isEntryPointPath("index.ts")).toBe(true);
    expect(isEntryPointPath("src/index.ts")).toBe(true);
    expect(isEntryPointPath("src/api/index.js")).toBe(true);
  });
  it("matches main.<ext>", () => {
    expect(isEntryPointPath("main.go")).toBe(true);
    expect(isEntryPointPath("src/main.py")).toBe(true);
  });
  it("matches cli.<ext>", () => {
    expect(isEntryPointPath("cli.js")).toBe(true);
    expect(isEntryPointPath("src/cli.ts")).toBe(true);
  });
  it("does not match random names", () => {
    expect(isEntryPointPath("lib/utils.ts")).toBe(false);
    expect(isEntryPointPath("foo.ts")).toBe(false);
  });
  it("handles Windows-style backslashes", () => {
    expect(isEntryPointPath("src\\index.ts")).toBe(true);
    expect(isEntryPointPath("src\\main.go")).toBe(true);
  });
  it("does not match `index_foo.ts` (only the exact basename `index.<ext>`)", () => {
    expect(isEntryPointPath("src/index_foo.ts")).toBe(false);
  });
});

describe("parseFileEdges — JavaScript / TypeScript", () => {
  it("emits 'depends' for `import` statements", () => {
    const edges = parseFileEdges(
      "main.js",
      `import { x } from './x.js';\n`,
      ".js",
      new Map([["./x.js", "x.js"]])
    );
    expect(edges).toEqual([
      { from: "main.js", to: "x.js", edge_type: "depends" },
    ]);
  });

  it("emits 'depends' for `export { x } from ...`", () => {
    const edges = parseFileEdges(
      "main.js",
      `export { x } from './x.js';\n`,
      ".js",
      new Map([["./x.js", "x.js"]])
    );
    expect(edges).toEqual([
      { from: "main.js", to: "x.js", edge_type: "depends" },
    ]);
  });

  it("emits 'calls' for `someFn()` when `someFn` is a known module", () => {
    const edges = parseFileEdges(
      "main.js",
      `foo();\n`,
      ".js",
      new Map([["foo", "foo.js"]])
    );
    expect(edges).toEqual([
      { from: "main.js", to: "foo.js", edge_type: "calls" },
    ]);
  });

  it("drops imports that don't resolve in the resolvers map", () => {
    const edges = parseFileEdges(
      "main.js",
      `import { x } from './unknown.js';\n`,
      ".js",
      new Map() // empty
    );
    expect(edges).toEqual([]);
  });

  it("dedupes identical edges", () => {
    const edges = parseFileEdges(
      "main.js",
      `import { x } from './x.js';\nimport { y } from './x.js';\n`,
      ".js",
      new Map([["./x.js", "x.js"]])
    );
    expect(edges).toEqual([
      { from: "main.js", to: "x.js", edge_type: "depends" },
    ]);
  });

  it("drops self-imports", () => {
    const edges = parseFileEdges(
      "main.js",
      `import './main.js';\n`,
      ".js",
      new Map([["./main.js", "main.js"]])
    );
    expect(edges).toEqual([]);
  });

  it("works for TypeScript (.ts)", () => {
    const edges = parseFileEdges(
      "app.ts",
      `import { x } from "./y";\n`,
      ".ts",
      // The parser strips quotes from the spec before looking it up,
      // so the resolver key should be the un-quoted spec.
      new Map([["./y", "y.ts"]])
    );
    expect(edges).toEqual([
      { from: "app.ts", to: "y.ts", edge_type: "depends" },
    ]);
  });
});

describe("parseFileEdges — Python", () => {
  it("emits 'depends' for `from x.y import z`", () => {
    const edges = parseFileEdges(
      "main.py",
      "from x.y import z\n",
      ".py",
      new Map([["x.y", "x/y.py"]])
    );
    expect(edges).toEqual([
      { from: "main.py", to: "x/y.py", edge_type: "depends" },
    ]);
  });
});

describe("parseFileEdges — Rust", () => {
  it("emits 'depends' for `use std::io;`", () => {
    const edges = parseFileEdges(
      "main.rs",
      "use std::io;\n",
      ".rs",
      new Map([["std::io", "std/io.rs"]])
    );
    expect(edges).toEqual([
      { from: "main.rs", to: "std/io.rs", edge_type: "depends" },
    ]);
  });
});

describe("parseFileEdges — Go", () => {
  it("emits 'depends' for `import \"fmt\"`", () => {
    const edges = parseFileEdges(
      "main.go",
      'import "fmt"\n',
      ".go",
      new Map([["fmt", "fmt.go"]])
    );
    expect(edges).toEqual([
      { from: "main.go", to: "fmt.go", edge_type: "depends" },
    ]);
  });
});

describe("parseFileEdges — C/C++", () => {
  it("emits 'depends' for `#include <stdio.h>`", () => {
    const edges = parseFileEdges(
      "main.c",
      "#include <stdio.h>\n",
      ".c",
      new Map([["stdio.h", "stdio.h"]])
    );
    expect(edges).toEqual([
      { from: "main.c", to: "stdio.h", edge_type: "depends" },
    ]);
  });
});

describe("parseFileEdges — Java", () => {
  it("emits 'depends' for `import java.util.List;`", () => {
    const edges = parseFileEdges(
      "Main.java",
      "import java.util.List;\nclass Main {}\n",
      ".java",
      new Map([["java.util.List", "java/util/List.java"]])
    );
    expect(edges).toEqual([
      { from: "Main.java", to: "java/util/List.java", edge_type: "depends" },
    ]);
  });
});

describe("parseFileEdges — PHP", () => {
  it("emits 'depends' for `use App\\Models\\User;` (EC-PHP-01 / happy path)", () => {
    const edges = parseFileEdges(
      "app/Http/Controller.php",
      "<?php\nuse App\\Models\\User;\n",
      ".php",
      new Map([["App\\Models\\User", "app/Models/User.php"]])
    );
    expect(edges).toEqual([
      { from: "app/Http/Controller.php", to: "app/Models/User.php", edge_type: "depends" },
    ]);
  });

  it("grouped `use` produces multiple edges (EC-PHP-05)", () => {
    const edges = parseFileEdges(
      "app/Http/Controller.php",
      "<?php\nuse App\\Http\\{Controllers\\HomeController, Requests\\LoginRequest};\n",
      ".php",
      new Map([
        ["App\\Http\\Controllers\\HomeController", "app/Http/Controllers/HomeController.php"],
        ["App\\Http\\Requests\\LoginRequest", "app/Http/Requests/LoginRequest.php"],
      ])
    );
    expect(edges).toEqual([
      { from: "app/Http/Controller.php", to: "app/Http/Controllers/HomeController.php", edge_type: "depends" },
      { from: "app/Http/Controller.php", to: "app/Http/Requests/LoginRequest.php", edge_type: "depends" },
    ]);
  });

  it("`use ... as Alias` resolves via original FQCN, ignoring alias (EC-PHP-04)", () => {
    const edges = parseFileEdges(
      "app/Http/Controller.php",
      "<?php\nuse App\\Cbo\\CommonURL as URL;\n",
      ".php",
      new Map([["App\\Cbo\\CommonURL", "app/Cbo/CommonURL.php"]])
    );
    expect(edges).toEqual([
      { from: "app/Http/Controller.php", to: "app/Cbo/CommonURL.php", edge_type: "depends" },
    ]);
  });

  it("unresolved `use` (no PSR-4 match) is silently dropped (EC-PHP-02)", () => {
    const edges = parseFileEdges(
      "app/Http/Controller.php",
      "<?php\nuse PHPMailer\\PHPMailer\\PHPMailer;\n",
      ".php",
      new Map() // empty — no PSR-4 match
    );
    expect(edges).toEqual([]);
  });

  it("dynamic `require` (non-literal) is skipped (EC-PHP-06)", () => {
    const edges = parseFileEdges(
      "app/Http/Controller.php",
      "<?php\nrequire_once __DIR__ . '/../vendor/autoload.php';\n",
      ".php",
      new Map()
    );
    expect(edges).toEqual([]);
  });

  it("literal `require_once` resolves via relative-path resolver (EC-PHP-01)", () => {
    const edges = parseFileEdges(
      "app/Http/Controller.php",
      "<?php\nrequire_once 'helpers.php';\n",
      ".php",
      new Map([["helpers.php", "helpers.php"]])
    );
    expect(edges).toEqual([
      { from: "app/Http/Controller.php", to: "helpers.php", edge_type: "depends" },
    ]);
  });

  it("literal `include` also resolves (EC-PHP-01)", () => {
    const edges = parseFileEdges(
      "app/Http/Controller.php",
      "<?php\ninclude 'config.php';\n",
      ".php",
      new Map([["config.php", "config.php"]])
    );
    expect(edges).toEqual([
      { from: "app/Http/Controller.php", to: "config.php", edge_type: "depends" },
    ]);
  });
});

describe("parseFileEdges — error handling", () => {
  it("returns [] for unsupported extensions (EC-CG-03)", () => {
    const edges = parseFileEdges(
      "README.md",
      "# hello\n",
      ".md",
      new Map()
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for a syntactically broken JS file (EC-CG-04 — tree-sitter is permissive)", () => {
    // tree-sitter is error-tolerant; even garbage code typically
    // produces an AST (with ERROR nodes). The parser skips those.
    const edges = parseFileEdges(
      "broken.js",
      "function f( ))) (( )){{{{\n",
      ".js",
      new Map()
    );
    expect(Array.isArray(edges)).toBe(true);
  });
});
