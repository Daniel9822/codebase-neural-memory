import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { captureMemories } from "../src/core/memory-capture.js";
import { updateMemoryVersion } from "../src/core/memory-update.js";
import type { ProjectLocation } from "../src/core/project.js";

let root: string | undefined;
let location: ProjectLocation;
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "cnm-memory-update-"));
  const rootPath = resolve(root);
  location = { id:"update-test-project",rootPath,dataDirectory:join(rootPath,".cnm-data"),databasePath:join(rootPath,".cnm-data","memory.sqlite") };
  const db=openDatabase(location); db.close();
}
afterEach(()=>{ if(root) rmSync(root,{recursive:true,force:true}); root=undefined; });

function create(): { knowledgeId:string; expectedVersionId:string } {
  const result=captureMemories(location,{
    idempotencyKey:"initial",actor:"test-agent",
    items:[{title:"Index invariant",content:"Initial behavior.",type:"architecture",epistemicState:"observed"}],
  });
  const db=openDatabase(location);
  try {
    const row=db.prepare("SELECT id,current_version_id AS expectedVersionId FROM knowledge_items WHERE id=?").get(result.outcomes[0]!.knowledgeId) as {id:string;expectedVersionId:string};
    return {knowledgeId:row.id,expectedVersionId:row.expectedVersionId};
  } finally { db.close(); }
}

describe("versioned memory update",()=>{
  it("appends an immutable version and event while retaining the previous version",()=>{
    setup(); const initial=create();
    const result=updateMemoryVersion(location,{
      ...initial,reason:"Verified after regression tests",actor:"agent",
      content:"Verified behavior.",epistemicState:"verified",confidence:0.95,
      confidenceReason:"Focused regression test passed.",
      evidence:[{evidenceType:"test_result",testCommand:"npm test",testResult:"passed"}],
    });
    expect(result).toMatchObject({status:"updated",previousVersionId:initial.expectedVersionId,versionNumber:2});
    const db=openDatabase(location);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions WHERE knowledge_id=?").get(initial.knowledgeId)).toEqual({count:2});
      expect(db.prepare("SELECT title,epistemic_state,confidence,confidence_reason,change_reason FROM knowledge_versions WHERE id=?").get(result.currentVersionId))
        .toMatchObject({title:"Index invariant",epistemic_state:"verified",confidence:0.95,change_reason:"Verified after regression tests"});
      expect(db.prepare("SELECT content FROM knowledge_fragments WHERE version_id=?").all(initial.expectedVersionId)).toEqual([{content:"Initial behavior."}]);
      expect(db.prepare("SELECT event_type,reason FROM knowledge_events WHERE knowledge_id=? ORDER BY CASE event_type WHEN 'captured' THEN 0 ELSE 1 END").all(initial.knowledgeId))
        .toEqual([{event_type:"captured",reason:"Captured through memory_capture"},{event_type:"updated",reason:"Verified after regression tests"}]);
      expect(db.prepare("SELECT current_version_id FROM knowledge_items WHERE id=?").get(initial.knowledgeId)).toEqual({current_version_id:result.currentVersionId});
    } finally { db.close(); }
  });

  it("returns a conflict for stale expected versions without writing",()=>{
    setup(); const initial=create();
    const first=updateMemoryVersion(location,{...initial,reason:"first update",summary:"new summary"});
    const stale=updateMemoryVersion(location,{...initial,reason:"stale update",title:"Lost update"});
    expect(first.status).toBe("updated");
    expect(stale).toMatchObject({status:"conflict",currentVersionId:first.currentVersionId});
    const db=openDatabase(location);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions WHERE knowledge_id=?").get(initial.knowledgeId)).toEqual({count:2});
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE knowledge_id=?").get(initial.knowledgeId)).toEqual({count:2});
    } finally { db.close(); }
  });

  it("does not create a version for a no-op",()=>{
    setup(); const initial=create();
    const result=updateMemoryVersion(location,{...initial,reason:"no changes"});
    expect(result).toMatchObject({status:"no_op",currentVersionId:initial.expectedVersionId,versionNumber:1});
    const db=openDatabase(location);
    try { expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions").get()).toEqual({count:1}); }
    finally { db.close(); }
  });

  it("rejects confidence without a rationale and cross-project identities",()=>{
    setup(); const initial=create();
    expect(()=>updateMemoryVersion(location,{...initial,reason:"bad",confidence:0.8})).toThrow("Confidence reason is required");
    const other={...location,id:"other-project"};
    expect(()=>updateMemoryVersion(other,{...initial,reason:"cross-project"})).toThrow("not found in this project");
  });
  it("rolls back the version, fragments, evidence, pointer, and event when a version insert fails",()=>{
    setup(); const initial=create();
    const db=openDatabase(location);
    db.exec(`CREATE TRIGGER fail_memory_update_version BEFORE INSERT ON knowledge_versions
      WHEN NEW.knowledge_id = (SELECT id FROM knowledge_items LIMIT 1)
      BEGIN SELECT RAISE(ABORT, 'injected update version failure'); END;`);
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
    expect(()=>updateMemoryVersion(location,{...initial,reason:"Injected failure",content:"Must not persist",
      evidence:[{evidenceType:"test_result",testCommand:"npm test",testResult:"must roll back"}]}))
      .toThrow("injected update version failure");
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
        updateMemoryVersion(location, { ...initial, reason: "Contended update", content: "Must not be committed." });
      } catch (error) { lockError = error; }
      const [exitCode, signal] = await childExit;
      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
      expect(lockError).toBeInstanceOf(Error);
      expect(String(lockError)).toMatch(/database is locked/i);
      expect(snapshot()).toEqual(before);
      expect(updateMemoryVersion(location, { ...initial, reason: "Retry after lock release", content: "Committed after retry." }))
        .toMatchObject({ status: "updated", versionNumber: 2 });
      expect(snapshot().versions).toHaveLength(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null) await childExit;
    }
  });


  it("serializes simultaneous writers for the same identity and rejects the stale writer", async () => {
    setup(); const initial = create();
    const script = `
      import { updateMemoryVersion } from "./src/core/memory-update.js";
      const payload = JSON.parse(process.env.CNM_RACE_INPUT ?? "{}");
      process.stdout.write("READY");
      process.stdin.once("data", () => {
        try {
          const result = updateMemoryVersion(payload.location, {
            knowledgeId: payload.knowledgeId,
            expectedVersionId: payload.expectedVersionId,
            reason: payload.reason,
            content: payload.content,
          });
          process.stdout.write("RESULT:" + JSON.stringify(result));
          process.exit(0);
        } catch (error) {
          process.stderr.write(String(error));
          process.exit(1);
        }
      });
    `;
    const workers = ["writer-a", "writer-b"].map((name) => spawn(
      process.execPath, ["--import", "tsx", "--input-type=module", "-e", script],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CNM_RACE_INPUT: JSON.stringify({
        location, knowledgeId: initial.knowledgeId, expectedVersionId: initial.expectedVersionId,
        reason: name, content: `Concurrent result from ${name}`,
      }) } },
    ));
    const waitForReady = (worker: ReturnType<typeof spawn>) => new Promise<void>((resolve, reject) => {
      let output = "";
      worker.stdout.setEncoding("utf8");
      worker.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("READY")) resolve();
      });
      worker.once("error", reject);
      worker.once("exit", (code, signal) => reject(new Error(`Writer exited before ready: ${code}/${signal}; output=${output}`)));
    });
    try {
      await Promise.all(workers.map(waitForReady));
      const resultsPromise = workers.map((worker) => new Promise<Record<string, unknown>>((resolve, reject) => {
        let output = "";
        worker.stdout.on("data", (chunk: string) => {
          output += chunk;
          const marker = output.indexOf("RESULT:");
          if (marker >= 0) {
            try { resolve(JSON.parse(output.slice(marker + "RESULT:".length)) as Record<string, unknown>); }
            catch (error) { reject(error); }
          }
        });
        worker.once("error", reject);
        worker.once("exit", (code, signal) => {
          if (code !== 0) reject(new Error(`Writer failed: ${code}/${signal}; output=${output}`));
        });
      }));
      for (const worker of workers) worker.stdin.write("GO");
      const results = await Promise.all(resultsPromise);
      expect(results.map((result) => result.status).sort()).toEqual(["conflict", "updated"]);
      const winner = results.find((result) => result.status === "updated")!;
      const loser = results.find((result) => result.status === "conflict")!;
      expect(loser.currentVersionId).toBe(winner.currentVersionId);
      const db = openDatabase(location);
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_versions WHERE knowledge_id=?")
          .get(initial.knowledgeId)).toEqual({ count: 2 });
        expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_events WHERE knowledge_id=?")
          .get(initial.knowledgeId)).toEqual({ count: 2 });
        expect(db.prepare("SELECT current_version_id FROM knowledge_items WHERE id=?")
          .get(initial.knowledgeId)).toEqual({ current_version_id: winner.currentVersionId });
      } finally { db.close(); }
    } finally {
      for (const worker of workers) if (worker.exitCode === null && worker.signalCode === null) worker.kill();
      await Promise.all(workers.map((worker) => worker.exitCode === null && worker.signalCode === null
        ? once(worker, "exit").then(() => undefined) : Promise.resolve()));
    }
  });

});
