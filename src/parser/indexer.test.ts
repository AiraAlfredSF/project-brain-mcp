// Tests for parser/indexer.ts — file-tree walker + PSR-4 resolver.
//
// Covers every EC-PHP-NN edge case from Spec 10 §7.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPsr4Resolvers, buildPerFileResolvers, listSourceFiles } from "./indexer.js";

let root: string;

beforeEach(() => {
  root = "/tmp/spec10-test-indexer";
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// listSourceFiles — vendor ignored
// ---------------------------------------------------------------------------

describe("listSourceFiles — vendor/ ignored (EC-PHP-08)", () => {
  it("skips vendor/ entirely", () => {
    mkdirSync(root + "/src", { recursive: true });
    mkdirSync(root + "/vendor/foo", { recursive: true });
    writeFileSync(root + "/src/index.php", "<?php\n");
    writeFileSync(root + "/vendor/foo/bar.php", "<?php\n");

    const files = listSourceFiles(root);
    expect(files).toContain(root + "/src/index.php");
    expect(files).not.toContain(root + "/vendor/foo/bar.php");
  });
});

// ---------------------------------------------------------------------------
// buildPsr4Resolvers
// ---------------------------------------------------------------------------

describe("buildPsr4Resolvers", () => {
  it("happy path: single PSR-4 prefix (EC-PHP-01)", () => {
    mkdirSync(root + "/app/Models", { recursive: true });
    writeFileSync(root + "/composer.json", JSON.stringify({
      autoload: { "psr-4": { "App\\": "app/" } }
    }));
    writeFileSync(root + "/app/Models/User.php", "<?php\n");

    const files = listSourceFiles(root);
    const psr4 = buildPsr4Resolvers(root, files);
    expect(psr4.get("App\\Models\\User")).toBe("app/Models/User.php");
  });

  it("grouped `use` members resolve independently (EC-PHP-05)", () => {
    mkdirSync(root + "/app/Http/Controllers", { recursive: true });
    mkdirSync(root + "/app/Http/Requests", { recursive: true });
    writeFileSync(root + "/composer.json", JSON.stringify({
      autoload: { "psr-4": { "App\\": "app/" } }
    }));
    writeFileSync(root + "/app/Http/Controllers/HomeController.php", "<?php\n");
    writeFileSync(root + "/app/Http/Requests/LoginRequest.php", "<?php\n");

    const files = listSourceFiles(root);
    const psr4 = buildPsr4Resolvers(root, files);
    expect(psr4.get("App\\Http\\Controllers\\HomeController")).toBe("app/Http/Controllers/HomeController.php");
    expect(psr4.get("App\\Http\\Requests\\LoginRequest")).toBe("app/Http/Requests/LoginRequest.php");
  });

  it("longest-matching prefix wins (EC-PHP-03)", () => {
    mkdirSync(root + "/app/Admin", { recursive: true });
    writeFileSync(root + "/composer.json", JSON.stringify({
      autoload: {
        "psr-4": {
          "App\\": "app/",
          "App\\Admin\\": "app/Admin/"
        }
      }
    }));
    writeFileSync(root + "/app/Admin/Foo.php", "<?php\n");

    const files = listSourceFiles(root);
    const psr4 = buildPsr4Resolvers(root, files);
    // app/Admin/Foo.php is under the longer prefix "app/Admin/" → namespace App\Admin\.
    expect(psr4.get("App\\Admin\\Foo")).toBe("app/Admin/Foo.php");
    // It should NOT be registered under the shorter "App\\" prefix.
    expect(psr4.get("App\\Foo")).toBeUndefined();
  });

  it("missing composer.json → empty map (EC-PHP-01)", () => {
    mkdirSync(root + "/app", { recursive: true });
    writeFileSync(root + "/app/User.php", "<?php\n");

    const files = listSourceFiles(root);
    const psr4 = buildPsr4Resolvers(root, files);
    expect(psr4.size).toBe(0);
  });

  it("malformed composer.json → empty map (EC-PHP-01)", () => {
    writeFileSync(root + "/composer.json", "not json");
    const files = listSourceFiles(root);
    const psr4 = buildPsr4Resolvers(root, files);
    expect(psr4.size).toBe(0);
  });

  it("composer.json with no psr-4 key → empty map (EC-PHP-01)", () => {
    writeFileSync(root + "/composer.json", JSON.stringify({ autoload: {} }));
    const files = listSourceFiles(root);
    const psr4 = buildPsr4Resolvers(root, files);
    expect(psr4.size).toBe(0);
  });

  it("non-PHP files are ignored by PSR-4 resolver", () => {
    mkdirSync(root + "/app", { recursive: true });
    writeFileSync(root + "/composer.json", JSON.stringify({
      autoload: { "psr-4": { "App\\": "app/" } }
    }));
    writeFileSync(root + "/app/User.js", "// js\n");

    const files = listSourceFiles(root);
    const psr4 = buildPsr4Resolvers(root, files);
    expect(psr4.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildPerFileResolvers — PSR-4 entries merged
// ---------------------------------------------------------------------------

describe("buildPerFileResolvers — PSR-4 merged", () => {
  it("FQCN resolver entries are present in every per-file resolver", () => {
    mkdirSync(root + "/app/Models", { recursive: true });
    writeFileSync(root + "/composer.json", JSON.stringify({
      autoload: { "psr-4": { "App\\": "app/" } }
    }));
    writeFileSync(root + "/app/Models/User.php", "<?php\n");
    writeFileSync(root + "/app/Controller.php", "<?php\n");

    const files = listSourceFiles(root);
    const perFile = buildPerFileResolvers(root, files);

    for (const rel of ["app/Models/User.php", "app/Controller.php"]) {
      const resolver = perFile.get(rel);
      expect(resolver).toBeDefined();
      expect(resolver!.get("App\\Models\\User")).toBe("app/Models/User.php");
    }
  });
});
