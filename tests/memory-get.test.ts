import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories } from "../src/core/memory-capture.js";
import { getMemory, expandMemory } from "../src/core/memory-get.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-get-"));
  const rootPath = resolve(root);
  location = { id: "get-test-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"), databasePath: join(rootPath, ".cnm-data", "memory.sqlite") };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function seed(): string {
  return captureMemories(location, {
    idempotencyKey: "get-seed",
    items: [{
      title: "Selective retrieval", content: "Primary content", type: "architecture", summary: "Short summary",
      epistemicState: "verified", tags: ["retrieval"], aliases: ["fragment retrieval"],
      fragments: [
        { heading: "One", summary: "First", content: "First fragment content" },
        { heading: "Two", summary: "Second", content: "Second fragment content" },
      ],
      evidence: [{ evidenceType: "test_result", testCommand: "npm test", testResult: "passed", metadata: { suite: "memory" } }],
    }],
  }).outcomes[0]!.knowledgeId;
}

describe("versioned memory get and expand", () => {
  it("returns current version metadata and optional bounded evidence without fragment bodies", () => {
    setup();
    const id = seed();
    const result = getMemory(location, { knowledgeId: id, includeEvidence: true });
    expect(result).toMatchObject({
      knowledgeId: id, type: "architecture", lifecycle: "active", version: { versionNumber: 1, title: "Selective retrieval", epistemicState: "verified" },
      tags: ["retrieval"], aliases: ["fragment retrieval"], fragmentCount: 3, evidenceReturned: 1,
    });
    expect(JSON.stringify(result)).not.toContain("First fragment content");
  });

  it("expands only selected stable fragment IDs and rejects IDs from another version", () => {
    setup();
    const id = seed();
    const db = openDatabase(location);
    let ids: string[];
    try {
      const version = (db.prepare("SELECT current_version_id AS id FROM knowledge_items WHERE id=?").get(id) as { id: string }).id;
      ids = (db.prepare("SELECT id FROM knowledge_fragments WHERE version_id=? ORDER BY ordinal").all(version) as Array<{ id: string }>).map(row => row.id);
    } finally { db.close(); }
    expect(expandMemory(location, { knowledgeId: id, fragmentIds: [ids[2]!] }).fragments).toMatchObject([
      { id: ids[2], ordinal: 2, heading: "Two", content: "Second fragment content" },
    ]);
    expect(() => expandMemory(location, { knowledgeId: id, fragmentIds: ["missing-fragment"] })).toThrow("do not belong");
  });

  it("pages fragments deterministically and reports character-budget truncation", () => {
    setup();
    const id = seed();
    const first = expandMemory(location, { knowledgeId: id, limit: 2 });
    expect(first.fragments.map(fragment => fragment.ordinal)).toEqual([0, 1]);
    expect(first.hasMore).toBe(true);
    const second = expandMemory(location, { knowledgeId: id, beforeOrdinal: first.nextBeforeOrdinal!, limit: 2 });
    expect(second.fragments.map(fragment => fragment.ordinal)).toEqual([2]);
    expect(second.hasMore).toBe(false);
    const budget = expandMemory(location, { knowledgeId: id, limit: 3, maxChars: 500 });
    expect(budget.serializedChars).toBeLessThanOrEqual(500);
    expect(budget.truncatedByCharacterBudget).toBe(true);
  });

  it("enforces project isolation and bounded inputs", () => {
    setup();
    const id = seed();
    expect(() => getMemory({ ...location, id: "other-project" }, { knowledgeId: id })).toThrow("not found in this project");
    expect(() => expandMemory(location, { knowledgeId: id, limit: 21 })).toThrow("limit");
    expect(() => expandMemory(location, { knowledgeId: id, maxChars: 12_001 })).toThrow("maxChars");
  });
});
