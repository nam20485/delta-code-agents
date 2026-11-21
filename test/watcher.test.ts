import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../src/sidecar/inbox.js";
import { WatchView } from "../src/sidecar/watcher.js";

function freshInbox(): Inbox {
  return new Inbox(mkdtempSync(join(tmpdir(), "dq-inbox-")));
}

function effects(): { superseded: number; worktrees: number; logs: string[]; onSuperseded(): void; onWorktreesChanged(): void; log(l: string): void } {
  const state = {
    superseded: 0,
    worktrees: 0,
    logs: [] as string[],
    onSuperseded() {
      state.superseded += 1;
    },
    onWorktreesChanged() {
      state.worktrees += 1;
    },
    log(l: string) {
      state.logs.push(l);
    },
  };
  return state;
}

test("watch frames feed the inbox; append extends, remove deletes", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({ type: "ready", thread_id: "t", producer: null });
  view.apply({
    type: "item",
    item: { id: "i1", kind: "agent_message", after_id: null, author: { name: "Ada" }, content: { text: "Hello" } },
  });
  view.apply({ type: "item.append", id: "i1", text: " world" });
  view.apply({ type: "live" });
  const batch = inbox.nextBatch();
  assert.notEqual(batch, null);
  assert.match(batch!.text, /Ada: Hello world/);
  assert.match(batch!.text, /delivery="d-/);
  // Add a second, undelivered item so the remove frame is actually exercised
  // (marking i1 delivered would empty the pending set on its own).
  view.apply({ type: "item", item: { id: "i2", after_id: null, author: { name: "Bob" }, content: { text: "another" } } });
  assert.equal(inbox.pendingCount(), 2);
  view.apply({ type: "remove", id: "i2" });
  assert.equal(inbox.pendingCount(), 1);
  inbox.markDelivered(batch!.ids);
  assert.equal(inbox.nextBatch(), null);
  view.apply({ type: "remove", id: "i1" });
  assert.equal(inbox.pendingCount(), 0);
});

test("every batch has a unique delivery id (qwen dedupe guard)", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({ type: "item", item: { id: "i1", after_id: null, author: { name: "Ada" }, content: { text: "same" } } });
  view.apply({ type: "live" });
  const first = inbox.nextBatch()!;
  // Simulate a cancelled turn: not marked delivered, redelivered later.
  const second = inbox.nextBatch()!;
  assert.notEqual(first.deliveryId, second.deliveryId);
  assert.notEqual(first.text, second.text);
});

test("after_id ordering holds unresolved predecessors until live", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({ type: "item", item: { id: "i2", after_id: "i1", author: { name: "Ada" }, content: { text: "second" } } });
  // Predecessor i1 not in view (hidden own item): held before live.
  assert.equal(inbox.pendingCount(), 0);
  view.apply({ type: "live" });
  assert.equal(inbox.pendingCount(), 1);
  view.apply({ type: "item", item: { id: "i1", after_id: null, author: { name: "Bob" }, content: { text: "first" } } });
  const batch = inbox.nextBatch()!;
  const firstIdx = batch.text.indexOf("Bob: first");
  const secondIdx = batch.text.indexOf("Ada: second");
  assert.ok(firstIdx !== -1 && secondIdx !== -1 && firstIdx < secondIdx);
});

test("producer.turn superseded and worktrees frames fire effects", () => {
  const inbox = freshInbox();
  const fx = effects();
  const view = new WatchView(inbox, fx);
  view.apply({ type: "producer.turn", sequence: 1, status: "finished" });
  assert.equal(fx.superseded, 0);
  view.apply({ type: "producer.turn", sequence: 1, status: "superseded" });
  assert.equal(fx.superseded, 1);
  view.apply({ type: "worktrees", worktrees: [{ reference: "r#t=1", name: "delta" }] });
  assert.equal(fx.worktrees, 1);
  // Unknown frames are skipped, not fatal.
  view.apply({ type: "future.frame", whatever: true });
});

test("comments enter the inbox and comment.remove deletes them", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({
    type: "comment",
    comment: { id: "c1", text: "Why this?", author: { name: "Ada" }, target: { item_id: "i1", kind: "transcript", quote: "Hello" } },
  });
  view.apply({ type: "live" });
  const batch = inbox.nextBatch()!;
  assert.match(batch.text, /Ada commented: Why this\?/);
  view.apply({ type: "comment.remove", id: "c1" });
  assert.equal(inbox.pendingCount(), 0);
});

test("delivered flags survive a reload (watch reconnect)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dq-inbox-"));
  const inbox = new Inbox(dir);
  const view = new WatchView(inbox, effects());
  view.apply({ type: "item", item: { id: "i1", after_id: null, author: { name: "Ada" }, content: { text: "hello" } } });
  view.apply({ type: "live" });
  inbox.markDelivered(inbox.nextBatch()!.ids);
  // Reconnect: fresh snapshot replays the same item into a new Inbox.
  const reloaded = new Inbox(dir);
  const view2 = new WatchView(reloaded, effects());
  view2.apply({ type: "item", item: { id: "i1", after_id: null, author: { name: "Ada" }, content: { text: "hello" } } });
  view2.apply({ type: "live" });
  assert.equal(reloaded.nextBatch(), null);
});

test("null item/comment payloads are skipped, not fatal", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({ type: "item", item: null });
  view.apply({ type: "comment", comment: null });
  view.apply({ type: "live" });
  assert.equal(inbox.pendingCount(), 0);
});

test("after_id cycles and self-references do not overflow ordering", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({ type: "item", item: { id: "a", after_id: "b", author: { name: "Ada" }, content: { text: "A" } } });
  view.apply({ type: "item", item: { id: "b", after_id: "a", author: { name: "Bob" }, content: { text: "B" } } });
  view.apply({ type: "item", item: { id: "s", after_id: "s", author: { name: "Self" }, content: { text: "S" } } });
  view.apply({ type: "live" });
  const batch = inbox.nextBatch();
  assert.notEqual(batch, null);
  assert.equal(batch!.ids.length, 3);
});

test("a held parent holds its child across batches (transitive)", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  // P's predecessor is missing pre-live, so P is held; C points at P.
  view.apply({ type: "item", item: { id: "P", after_id: "ghost", author: { name: "Ada" }, content: { text: "parent" } } });
  view.apply({ type: "item", item: { id: "C", after_id: "P", author: { name: "Bob" }, content: { text: "child" } } });
  assert.equal(inbox.pendingCount(), 0);
  view.apply({ type: "live" });
  const batch = inbox.nextBatch()!;
  assert.ok(batch.text.indexOf("parent") < batch.text.indexOf("child"));
});

test("an over-long author cannot stall the batch", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({ type: "item", item: { id: "i1", after_id: null, author: { name: "x".repeat(50_000) }, content: { text: "hi" } } });
  view.apply({ type: "live" });
  const batch = inbox.nextBatch();
  assert.notEqual(batch, null);
  assert.ok(batch!.text.length <= 8_200);
  // Causal: the 80-char author cap must actually remove the long run; the
  // first-entry slice alone would still pass a loose length bound.
  assert.ok(!batch!.text.includes("x".repeat(100)));
});

test("watch children/child/child.remove frames track subthreads", () => {
  const inbox = freshInbox();
  const view = new WatchView(inbox, effects());
  view.apply({ type: "children", children: [
    { thread_id: "c1", reference: "t#s=1", kind: "subagent", name: "Scout", status: "running" },
    { thread_id: "c2", reference: "t#s=2", kind: "subthread", name: "Investigation", status: "unknown" },
  ] });
  assert.equal(view.children().length, 2);
  view.apply({ type: "child", child: { thread_id: "c1", reference: "t#s=1", kind: "subagent", name: "Scout", status: "completed" } });
  const c1 = view.children().find((c) => c["thread_id"] === "c1");
  assert.equal(c1?.["status"], "completed");
  view.apply({ type: "child.remove", thread_id: "c2" });
  assert.equal(view.children().length, 1);
  // A fresh children snapshot replaces the list.
  view.apply({ type: "children", children: [] });
  assert.equal(view.children().length, 0);
});
