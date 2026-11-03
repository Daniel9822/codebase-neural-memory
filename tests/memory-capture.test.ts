import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories, type MemoryCaptureInput } from "../src/core/memory-capture.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;

function setupProject(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-capture-"));
  const canonicalRoot = resolve(root);
  location = {
    id: "capture-test-project",
    rootPath: canonicalRoot,
    dataDirectory: join(canonicalRoot, ".cnm-data"),
    databasePath: join(canonicalRoot, ".cnm-data", "memory.sqlite"),
  };
  const db = openDatabase(location);
  db.close();
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function sampleInput(overrides: Partial<MemoryCaptureInput> = {}): MemoryCaptureInput {
  return {
    idempotencyKey: "capture-001",
    actor: "test-agent",
    origin: "test-suite",
    items: [{
      title: "Safe source reads",
      content: "Source files are opened through the verified reader.",
      type: "architecture",
      summary: "Verified source-read invariant.",
      epistemicState: "verified",
      confidence: 0.98,
      confidenceReason: "Covered by safe-file regression tests.",
      tags: ["security"],
      aliases: ["verified source reads"],
      fragments: [{ heading: "Invariant", summary: "Reader boundary", content: "Open and verify the same file descriptor." }],
      evidence: [{
        evidenceType: "test_result",
        sourcePath: "src/core/safe-file.ts",
        commitSha: "abc123",
        testCommand: "npm test",
        testResult: "passed",
        metadata: { suite: "safe-file", attempt: 1 },
      }],
    }],
    ...overrides,
  };
}

describe("versioned memory capture", () => {
  it("creates an identity, immutable version, fragments, evidence, and event atomically", () => {
    setupProject();
    const result = captureMemories(location, sampleInput());
    expect(result).toMatchObject({ idempotentReplay: false, created: 1, duplicates: 0, conflicts: 0 });
    const db = openDatabase(location);
    try {
      const item = db.prepare("SELECT id, project_id, knowledge_type, lifecycle, current_version_id FROM knowledge_items").get() as {
        id: string; project_id: string; knowledge_type: string; lifecycle: string; current_version_id: string;
      };
      expect(item).toMatchObject({ id: result.outcomes[0].knowledgeId, project_id: location.id, knowledge_type: "architecture", lifecycle: "active" });
      const version = db.prepare("SELECT version_number, epistemic_state, confidence, confidence_reason, title, summary, created_by FROM knowledge_versions WHERE id = ?")
        .get(item.current_version_id);
      expect(version).toEqual({
        version_number: 1, epistemic_state: "verified", confidence: 0.98,
        confidence_reason: "Covered by safe-file regression tests.", title: "Safe source reads",
        summary: "Verified source-read invariant.", created_by: "test-agent",
      });
      expect(db.prepare("SELECT heading, summary, content FROM knowledge_fragments WHERE version_id = ?").all(item.current_version_id))
        .toEqual([{ heading: "Invariant", summary: "Reader boundary", content: "Open and verify the same file descriptor." }]);
      expect(db.prepare("SELECT evidence_type, source_path, commit_sha, test_command, test_result, actor FROM knowledge_evidence WHERE version_id = ?").all(item.current_version_id))
        .toEqual([{
          evidence_type: "test_result", source_path: "src/core/safe-file.ts", commit_sha: "abc123",
          test_command: "npm test", test_result: "passed", actor: "test-agent",
        }]);
      expect(db.prepare("SELECT event_type, actor, reason FROM knowledge_events WHERE knowledge_id = ?").get(item.id))
        .toEqual({ event_type: "captured", actor: "test-agent", reason: "Captured through memory_capture" });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("replays an idempotent request without creating additional rows", () => {
    setupProject();
    const input = sampleInput();
    const first = captureMemories(location, input);
    const replay = captureMemories(location, input);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    const db = openDatabase(location);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE event_type = 'captured'").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
    expect(() => captureMemories(location, {
      ...input,
      items: [{ ...input.items[0], content: "Changed payload under same key." }],
    })).toThrow("Idempotency key was already used");
  });

  it("classifies exact content as duplicate and different content under the same identity as conflict", () => {
    setupProject();
    const first = captureMemories(location, sampleInput());
    const duplicate = captureMemories(location, {
      ...sampleInput({ idempotencyKey: "capture-002" }),
    });
    const conflict = captureMemories(location, {
      ...sampleInput({ idempotencyKey: "capture-003" }),
      items: [{ ...sampleInput().items[0], content: "A conflicting assertion." }],
    });
    expect(first.created).toBe(1);
    expect(duplicate).toMatchObject({ created: 0, duplicates: 1, conflicts: 0 });
    expect(conflict).toMatchObject({ created: 0, duplicates: 0, conflicts: 1 });
    const db = openDatabase(location);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it("rejects invalid bounds and confidence before persisting any part of a batch", () => {
    setupProject();
    const input = sampleInput({
      items: [
        sampleInput().items[0],
        { ...sampleInput().items[0], confidence: 1.1 },
      ],
    });
    expect(() => captureMemories(location, input)).toThrow("Invalid confidence");
    const db = openDatabase(location);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_items").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_idempotency").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
