import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories } from "../src/core/memory-capture.js";
import { updateMemoryVersion } from "../src/core/memory-update.js";
import { correctMemory } from "../src/core/memory-correct.js";
import { getMemoryHistory } from "../src/core/memory-history.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-history-"));
  const rootPath = resolve(root);
  location = { id: "history-test-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"), databasePath: join(rootPath, ".cnm-data", "memory.sqlite") };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function create(): { knowledgeId: string; versionId: string; fragmentId: string } {
  const result = captureMemories(location, {
    idempotencyKey: "history-seed",
    items: [{ title: "History subject", content: "Initial content", type: "behavior", epistemicState: "observed" }],
  });
  const knowledgeId = result.outcomes[0]!.knowledgeId;
  const db = openDatabase(location);
  try {
    const row = db.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?").get(knowledgeId) as { versionId: string };
    const fragment = db.prepare("SELECT id FROM knowledge_fragments WHERE version_id=?").get(row.versionId) as { id: string };
    return { knowledgeId, versionId: row.versionId, fragmentId: fragment.id };
  } finally { db.close(); }
}

describe("versioned memory history", () => {
  it("returns immutable versions and events in deterministic paginated order", () => {
    setup();
    const initial = create();
    const updated = updateMemoryVersion(location, { ...initial, expectedVersionId: initial.versionId, reason: "Verified update", content: "Updated content", epistemicState: "verified" });
    expect(updated.status).toBe("updated");
    const corrected = correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: updated.currentVersionId!, targetFragmentId: initial.fragmentId,
      replacementContent: "Corrected content", reason: "User correction", correctionSource: "user", epistemicState: "user_asserted",
    });
    expect(corrected.status).toBe("corrected");
    const page = getMemoryHistory(location, { knowledgeId: initial.knowledgeId, versionLimit: 2, eventLimit: 2 });
    expect(page.versions.map((version) => version.versionNumber)).toEqual([3, 2]);
    expect(page.events).toHaveLength(2);
    expect(page.pagination).toMatchObject({ hasMoreVersions: true, hasMoreEvents: true, nextBeforeVersionNumber: 2 });
    const older = getMemoryHistory(location, {
      knowledgeId: initial.knowledgeId, versionLimit: 2, eventLimit: 2,
      beforeVersionNumber: page.pagination.nextBeforeVersionNumber!,
      beforeEventCreatedAt: page.pagination.nextBeforeEvent!.createdAt,
      beforeEventId: page.pagination.nextBeforeEvent!.id,
    });
    expect(older.versions.map((version) => version.versionNumber)).toEqual([1]);
    expect(older.events.map((event) => event.eventType)).toEqual(["captured"]);
    expect(older.versions[0]!.changeReason).toBe("Captured through memory_capture");
  });

  it("enforces project isolation and bounded pagination inputs", () => {
    setup();
    const initial = create();
    expect(() => getMemoryHistory({ ...location, id: "another-project" }, { knowledgeId: initial.knowledgeId })).toThrow("not found in this project");
    expect(() => getMemoryHistory(location, { knowledgeId: initial.knowledgeId, versionLimit: 51 })).toThrow("versionLimit");
    expect(() => getMemoryHistory(location, { knowledgeId: initial.knowledgeId, beforeEventId: "event-only" })).toThrow("must be supplied together");
  });
});
