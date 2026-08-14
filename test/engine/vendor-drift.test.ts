// P0-T04 — a local edit to vendored engine code fails the build (ADR-0003).
//
// The rule only means anything if the check actually catches an edit, so this test proves it on a
// fixture rather than trusting the script: it builds a tiny vendored tree, verifies it passes, then
// edits one byte and asserts the check goes red. Without this, "we have a drift check" is a claim
// about a script nobody has ever seen fail.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { checkVendor } from "../../scripts/check-vendor.mjs";

const dirs: string[] = [];

function fixture(): { dir: string; manifest: string } {
  const dir = mkdtempSync(join(tmpdir(), "vendor-fixture-"));
  dirs.push(dir);
  mkdirSync(join(dir, "engine"), { recursive: true });
  writeFileSync(join(dir, "engine", "sim.js"), "export function tick() {}\n");
  writeFileSync(join(dir, "data.js"), "export const COM = {};\n");

  const files: Record<string, string> = {};
  for (const rel of ["engine/sim.js", "data.js"]) {
    files[rel] = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
  }
  const manifest = join(dir, "VENDOR.json");
  writeFileSync(manifest, JSON.stringify({ upstream: "fixture", ref: "main", commit: "abc123", files }));
  return { dir, manifest };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("vendor drift check", () => {
  it("is quiet on an untouched tree", () => {
    const { dir, manifest } = fixture();
    expect(checkVendor(dir, manifest)).toEqual([]);
  });

  it("fails on an edited vendored file, and says why", () => {
    const { dir, manifest } = fixture();
    writeFileSync(join(dir, "engine", "sim.js"), "export function tick() { /* just a small fix */ }\n");
    const problems = checkVendor(dir, manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("engine/sim.js");
    // The message has to point at the fix — upstream first — or the next person just edits the
    // manifest to make the build green again.
    expect(problems[0]).toMatch(/upstream/i);
  });

  it("fails on a whitespace-only edit", () => {
    // A reformat is still a fork. Hashing bytes rather than parsed content is what catches it.
    const { dir, manifest } = fixture();
    writeFileSync(join(dir, "engine", "sim.js"), "export function tick() {}\r\n");
    expect(checkVendor(dir, manifest)).toHaveLength(1);
  });

  it("fails on a deleted vendored file", () => {
    const { dir, manifest } = fixture();
    rmSync(join(dir, "data.js"));
    expect(checkVendor(dir, manifest)[0]).toContain("deleted");
  });

  it("fails on a new file smuggled into the vendored tree", () => {
    const { dir, manifest } = fixture();
    writeFileSync(join(dir, "engine", "patch.js"), "export const hack = 1;\n");
    expect(checkVendor(dir, manifest)[0]).toContain("untracked");
  });

  it("fails when the manifest itself is missing", () => {
    const { dir } = fixture();
    expect(checkVendor(dir, join(dir, "nope.json"))[0]).toMatch(/sync:engine/);
  });
});

describe("the real vendored tree", () => {
  it("is in sync", async () => {
    const { checkVendor: check } = await import("../../scripts/check-vendor.mjs");
    expect(check(), "the vendored engine has been edited — run `npm run check:vendor` for detail").toEqual([]);
  });

  it("records where it came from", async () => {
    const manifest = JSON.parse(readFileSync(new URL("../../src/engine/VENDOR.json", import.meta.url), "utf8"));
    expect(manifest.upstream).toContain("SpaceExploration-RTS");
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(manifest.files).length).toBeGreaterThan(50);
    // Every omitted upstream test names the path that disqualified it, so the omission is a
    // reviewable fact rather than someone's judgement call (see scripts/vendor-manifest.mjs).
    for (const entry of manifest.excludedTests) {
      expect(entry.file).toMatch(/\.test\.js$/);
      expect(entry.reachesOutside, `${entry.file} was excluded without a reason`).toBeTruthy();
    }
  });
});
