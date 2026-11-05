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
    const db = openDatabase(location);
    let currentFragmentId: string;
    try {
      currentFragmentId = (db.prepare("SELECT id FROM knowledge_fragments WHERE version_id=?").get(updated.currentVersionId) as { id: string }).id;
    } finally { db.close(); }
    const corrected = correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: updated.currentVersionId!, targetFragmentId: currentFragmentId,
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
    expect(() => getMemoryHistory(location, { knowledgeId: initial.knowledgeId, beforeEventId: "event-only" })).toThrow("requires a valid beforeEventCreatedAt and beforeEventId");
  });
  it("bounds the complete serialized response and reports exact totals and omissions", () => {
    setup();
    const initial = create();
    const db = openDatabase(location);
    try {
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO knowledge_events
          (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, 'history_fixture', NULL, NULL, ?, ?)
      `);
      const add = db.transaction(() => {
        for (let index = 0; index < 12; index++) {
          insert.run(`history-event-${index.toString().padStart(2, "0")}`, location.id, initial.knowledgeId,
            initial.versionId, JSON.stringify({ detail: "x".repeat(700) }), now);
        }
      });
      add();
    } finally { db.close(); }
    const page = getMemoryHistory(location, { knowledgeId: initial.knowledgeId, versionLimit: 20, eventLimit: 20, maxChars: 1500 });
    expect(page.totalVersions).toBe(1);
    expect(page.totalEvents).toBe(13);
    expect(page.truncated).toBe(true);
    expect(page.budgetOmittedEvents).toBeGreaterThan(0);
    expect(page.pagination.hasMoreEvents).toBe(true);
    expect(page.serializedChars).toBe(JSON.stringify(page).length);
    expect(page.serializedChars).toBeLessThanOrEqual(2500);
  });

  it("continues through every event across repeated character-constrained pages without skips or duplicates", () => {
    setup();
    const initial = create();
    const db = openDatabase(location);
    try {
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO knowledge_events
          (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, 'history_page_fixture', NULL, NULL, ?, ?)
      `);
      const add = db.transaction(() => {
        for (let index = 0; index < 7; index++) {
          insert.run(`page-event-${index.toString().padStart(2, "0")}`, location.id, initial.knowledgeId,
            initial.versionId, JSON.stringify({ detail: "p".repeat(700) }), now);
        }
      });
      add();
    } finally { db.close(); }

    const seen: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    for (let pageNumber = 0; pageNumber < 12; pageNumber++) {
      const page = getMemoryHistory(location, {
        knowledgeId: initial.knowledgeId, eventLimit: 20, maxChars: 2500,
        ...(cursor ? { beforeEventCreatedAt: cursor.createdAt, beforeEventId: cursor.id } : {}),
      });
      expect(page.serializedChars).toBe(JSON.stringify(page).length);
      expect(page.serializedChars).toBeLessThanOrEqual(2500);
      seen.push(...page.events.filter((event) => event.eventType === "history_page_fixture").map((event) => event.id));
      if (!page.pagination.hasMoreEvents) break;
      expect(page.pagination.nextBeforeEvent).not.toBeNull();
      cursor = page.pagination.nextBeforeEvent;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, index) => `page-event-${index.toString().padStart(2, "0")}`).reverse());
  });

  it("reports and advances past an individually oversized event without exceeding the budget", () => {
    setup();
    const initial = create();
    const oversizedId = "zz-oversized-history-event";
    const olderId = "older-than-oversized-history-event";
    const db = openDatabase(location);
    try {
      const insert = db.prepare(`
        INSERT INTO knowledge_events
          (id, project_id, knowledge_id, version_id, event_type, actor, reason, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      `);
      insert.run(oversizedId, location.id, initial.knowledgeId, initial.versionId, "oversized_fixture",
        JSON.stringify({ detail: "z".repeat(4_000) }), "2000-01-01T00:00:00.000Z");
      insert.run(olderId, location.id, initial.knowledgeId, initial.versionId, "older_fixture",
        "{}", "1999-01-01T00:00:00.000Z");
    } finally { db.close(); }

    const page = getMemoryHistory(location, { knowledgeId: initial.knowledgeId, eventLimit: 20, maxChars: 1_000 });
    expect(page.truncated).toBe(true);
    expect(page.budgetOmittedEvents).toBeGreaterThan(0);
    expect(page.events.some((event) => event.id === oversizedId)).toBe(false);
    expect(page.events.some((event) => event.eventType === "captured")).toBe(true);
    expect(page.pagination.hasMoreEvents).toBe(true);
    expect(page.pagination.nextBeforeEvent).toEqual({ createdAt: "2000-01-01T00:00:00.000Z", id: oversizedId });
    expect(page.serializedChars).toBe(JSON.stringify(page).length);
    expect(page.serializedChars).toBeLessThanOrEqual(1_000);

    const olderPage = getMemoryHistory(location, {
      knowledgeId: initial.knowledgeId, eventLimit: 20, maxChars: 1_000,
      beforeEventCreatedAt: page.pagination.nextBeforeEvent!.createdAt,
      beforeEventId: page.pagination.nextBeforeEvent!.id,
    });
    expect(olderPage.events.map((event) => event.id)).toContain(olderId);
    expect(olderPage.events.some((event) => event.id === oversizedId)).toBe(false);
  });

  it("rejects character budgets below the supported minimum", () => {
    setup();
    const initial = create();
    expect(() => getMemoryHistory(location, { knowledgeId: initial.knowledgeId, maxChars: 499 })).toThrow("maxChars");
  });
});
