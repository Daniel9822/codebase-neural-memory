import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories } from "../src/core/memory-capture.js";
import { correctMemory } from "../src/core/memory-correct.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-correct-"));
  const rootPath = resolve(root);
  location = { id: "correct-test-project", rootPath, dataDirectory: join(rootPath, ".cnm-data"),
    databasePath: join(rootPath, ".cnm-data", "memory.sqlite") };
  openDatabase(location).close();
}
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

function create(): { knowledgeId: string; versionId: string; fragmentIds: string[] } {
  const captured = captureMemories(location, {
    idempotencyKey: "correction-seed", actor: "seed-agent",
    items: [{
      title: "Deployment behavior", content: "The service deploys with command A.",
      type: "procedure", epistemicState: "verified",
      fragments: [{ heading: "Rollback", content: "Rollback uses command B." }],
      evidence: [{ evidenceType: "test_result", testCommand: "npm test", testResult: "passed" }],
    }],
  });
  const knowledgeId = captured.outcomes[0]!.knowledgeId;
  const db = openDatabase(location);
  try {
    const item = db.prepare("SELECT current_version_id AS versionId FROM knowledge_items WHERE id=?")
      .get(knowledgeId) as { versionId: string };
    const fragments = db.prepare("SELECT id FROM knowledge_fragments WHERE version_id=? ORDER BY ordinal")
      .all(item.versionId) as Array<{ id: string }>;
    return { knowledgeId, versionId: item.versionId, fragmentIds: fragments.map(f => f.id) };
  } finally { db.close(); }
}

describe("versioned memory correction", () => {
  it("corrects only the selected fragment and preserves prior version, evidence, and provenance", () => {
    setup();
    const initial = create();
    const result = correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "The service deploys with command C.",
      reason: "The user corrected the documented deployment command.",
      correctionSource: "user", epistemicState: "user_asserted", actor: "user",
    });
    expect(result).toMatchObject({ status: "corrected", correctionSource: "user", versionNumber: 2 });
    const db = openDatabase(location);
    try {
      expect(db.prepare("SELECT content FROM knowledge_fragments WHERE version_id=? ORDER BY ordinal")
        .all(initial.versionId)).toEqual([
          { content: "The service deploys with command A." },
          { content: "Rollback uses command B." },
        ]);
      expect(db.prepare("SELECT content FROM knowledge_fragments WHERE version_id=? ORDER BY ordinal")
        .all(result.currentVersionId)).toEqual([
          { content: "The service deploys with command C." },
          { content: "Rollback uses command B." },
        ]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE version_id=?")
        .get(result.currentVersionId)).toEqual({ count: 1 });
      expect(db.prepare("SELECT event_type,reason,payload_json FROM knowledge_events WHERE knowledge_id=? AND event_type='corrected'")
        .get(initial.knowledgeId)).toMatchObject({
          event_type: "corrected", reason: "The user corrected the documented deployment command.",
        });
      const event = db.prepare("SELECT payload_json FROM knowledge_events WHERE knowledge_id=? AND event_type='corrected'")
        .get(initial.knowledgeId) as { payload_json: string };
      expect(JSON.parse(event.payload_json)).toMatchObject({
        previousVersionId: initial.versionId, targetFragmentId: initial.fragmentIds[0],
        correctionSource: "user", correctedOrdinal: 0,
      });
    } finally { db.close(); }
  });

  it("requires evidence for agent corrections marked verified", () => {
    setup();
    const initial = create();
    expect(() => correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "Corrected command.",
      reason: "Agent verified the command.", correctionSource: "agent", epistemicState: "verified",
    })).toThrow("require evidence");
  });

  it("allows an agent correction to be verified when evidence is supplied", () => {
    setup();
    const initial = create();
    const result = correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "Verified corrected command.",
      reason: "Source and focused tests confirm the corrected command.",
      correctionSource: "agent", epistemicState: "verified", actor: "agent",
      evidence: [{ evidenceType: "test_result", testCommand: "npm test -- memory-correct", testResult: "passed" }],
    });
    expect(result).toMatchObject({ status: "corrected", correctionSource: "agent", versionNumber: 2 });
    const db = openDatabase(location);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence WHERE version_id=?")
        .get(result.currentVersionId)).toEqual({ count: 2 });
    } finally { db.close(); }
  });

  it("rejects user corrections that falsely claim verified implementation", () => {
    setup();
    const initial = create();
    expect(() => correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "Corrected command.",
      reason: "User correction.", correctionSource: "user", epistemicState: "verified",
    })).toThrow("must be user_asserted or pending_validation");
  });

  it("returns a stale conflict without writes and treats identical content as no-op", () => {
    setup();
    const initial = create();
    const noOp = correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "The service deploys with command A.",
      reason: "No actual change.", correctionSource: "user", epistemicState: "user_asserted",
    });
    expect(noOp.status).toBe("no_op");
    const first = correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "The service deploys with command C.",
      reason: "Corrected command.", correctionSource: "user", epistemicState: "pending_validation",
    });
    const stale = correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "Stale overwrite.",
      reason: "Stale correction.", correctionSource: "user", epistemicState: "user_asserted",
    });
    expect(first.status).toBe("corrected");
    expect(stale).toMatchObject({ status: "conflict", currentVersionId: first.currentVersionId });
    const db = openDatabase(location);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions WHERE knowledge_id=?")
        .get(initial.knowledgeId)).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE knowledge_id=?")
        .get(initial.knowledgeId)).toEqual({ count: 2 });
    } finally { db.close(); }
  });

  it("rejects fragments outside the current version and cross-project identities", () => {
    setup();
    const initial = create();
    expect(() => correctMemory(location, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: "fragment:unknown", replacementContent: "Corrected.",
      reason: "Bad target.", correctionSource: "user", epistemicState: "user_asserted",
    })).toThrow("does not belong");
    const other = { ...location, id: "other-project" };
    expect(() => correctMemory(other, {
      knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId,
      targetFragmentId: initial.fragmentIds[0]!, replacementContent: "Corrected.",
      reason: "Cross-project.", correctionSource: "user", epistemicState: "user_asserted",
    })).toThrow("not found in this project");
  });
  it("rolls back the corrected version, fragments, evidence, pointer, and event when a version insert fails",()=>{
    setup(); const initial=create();
    const db=openDatabase(location);
    db.exec(`CREATE TRIGGER fail_memory_correct_version BEFORE INSERT ON knowledge_versions
      WHEN NEW.knowledge_id = (SELECT id FROM knowledge_items LIMIT 1)
      BEGIN SELECT RAISE(ABORT, 'injected correction version failure'); END;`);
    db.close();
    const beforeDb=openDatabase(location);
    const before={
      items:beforeDb.prepare("SELECT id,current_version_id,tags_json,aliases_json,updated_at FROM knowledge_items").all(),
      versions:beforeDb.prepare("SELECT id,version_number FROM knowledge_versions ORDER BY version_number").all(),
      fragments:beforeDb.prepare("SELECT id,version_id,content FROM knowledge_fragments ORDER BY id").all(),
      evidence:beforeDb.prepare("SELECT id,version_id FROM knowledge_evidence ORDER BY id").all(),
      events:beforeDb.prepare("SELECT id,event_type FROM knowledge_events ORDER BY id").all(),
    };
    beforeDb.close();
    expect(()=>correctMemory(location,{
      knowledgeId:initial.knowledgeId,expectedVersionId:initial.versionId,targetFragmentId:initial.fragmentIds[0]!,
      replacementContent:"Must not persist",reason:"Injected failure",correctionSource:"user",epistemicState:"user_asserted",
      evidence:[{evidenceType:"test_result",testCommand:"npm test",testResult:"must roll back"}],
    })).toThrow("injected correction version failure");
    const afterDb=openDatabase(location);
    expect({
      items:afterDb.prepare("SELECT id,current_version_id,tags_json,aliases_json,updated_at FROM knowledge_items").all(),
      versions:afterDb.prepare("SELECT id,version_number FROM knowledge_versions ORDER BY version_number").all(),
      fragments:afterDb.prepare("SELECT id,version_id,content FROM knowledge_fragments ORDER BY id").all(),
      evidence:afterDb.prepare("SELECT id,version_id FROM knowledge_evidence ORDER BY id").all(),
      events:afterDb.prepare("SELECT id,event_type FROM knowledge_events ORDER BY id").all(),
    }).toEqual(before);
    afterDb.close();
  });

  it("fails without writes while an independent process holds the write lock, then retries successfully", async () => {
    setup(); const initial = create();
    const targetFragmentId = initial.fragmentIds[0]!;
    const snapshot = () => {
      const db = openDatabase(location);
      try {
        return {
          items: db.prepare("SELECT id,current_version_id,tags_json,aliases_json,updated_at FROM knowledge_items").all(),
          versions: db.prepare("SELECT id,version_number FROM knowledge_versions ORDER BY version_number").all(),
          fragments: db.prepare("SELECT id,version_id,content FROM knowledge_fragments ORDER BY id").all(),
          evidence: db.prepare("SELECT id,version_id FROM knowledge_evidence ORDER BY id").all(),
          events: db.prepare("SELECT id,event_type FROM knowledge_events ORDER BY id").all(),
        };
      } finally { db.close(); }
    };
    const before = snapshot();
    const script = `
      import { openDatabase } from "./src/storage/database.js";
      const location = JSON.parse(process.env.CNM_TEST_LOCATION ?? "null");
      const db = openDatabase(location);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("LOCKED\\n");
      setTimeout(() => { try { db.exec("ROLLBACK"); } finally { db.close(); } }, 6500);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CNM_TEST_LOCATION: JSON.stringify(location) },
    });
    child.stdout.setEncoding("utf8");
    const childExit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", (chunk: string) => chunk.includes("LOCKED") ? resolve() : reject(new Error("Unexpected lock-holder output: " + chunk)));
        child.once("error", reject);
        child.once("exit", (code, signal) => reject(new Error("Lock-holder exited before acquiring lock: " + code + "/" + signal)));
      });
      const probe = openDatabase(location); probe.close();
      let lockError: unknown;
      try {
        correctMemory(location, {
          knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId, targetFragmentId,
          replacementContent: "Must not be committed.", reason: "Contended correction",
          correctionSource: "user", epistemicState: "user_asserted",
        });
      } catch (error) { lockError = error; }
      const [exitCode, signal] = await childExit;
      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
      expect(lockError).toBeInstanceOf(Error);
      expect(String(lockError)).toMatch(/database is locked/i);
      expect(snapshot()).toEqual(before);
      expect(correctMemory(location, {
        knowledgeId: initial.knowledgeId, expectedVersionId: initial.versionId, targetFragmentId,
        replacementContent: "Committed after retry.", reason: "Retry after lock release",
        correctionSource: "user", epistemicState: "user_asserted",
      })).toMatchObject({ status: "corrected", versionNumber: 2 });
      expect(snapshot().versions).toHaveLength(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null) await childExit;
    }
  });

});
