import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "../lib/fsx.js";

export interface InboxEntry {
  id: string;
  kind: "item" | "comment";
  text: string;
  author: string;
  /** Predecessor item id for ordering; null = root. */
  afterId: string | null;
  delivered: boolean;
}

export interface InboxBatch {
  deliveryId: string;
  ids: string[];
  text: string;
}

const MAX_BATCH_CHARS = 8_000;
const MAX_ENTRY_CHARS = 1_000;

interface PersistedInbox {
  version: 1;
  entries: InboxEntry[];
}

/**
 * Remote activity awaiting delivery to the agent (plan: "Receive shared
 * activity"). The watch stream already hides items our own producer
 * recorded, so everything here is teammate activity. Delivered flags persist
 * so a watch reconnect (fresh snapshot) never re-injects old activity.
 */
export class Inbox {
  private entries = new Map<string, InboxEntry>();
  private readonly file: string;
  /** Set once the watch reaches `live`: unresolved predecessors are ours
   * (hidden) or removed, so pending items become renderable roots. */
  private live = false;

  constructor(dir: string) {
    this.file = join(dir, "inbox.json");
    const saved = readJson<PersistedInbox>(this.file);
    if (saved !== null && Array.isArray(saved.entries)) {
      for (const entry of saved.entries) this.entries.set(entry.id, entry);
    }
  }

  markLive(): void {
    this.live = true;
  }

  upsertItem(id: string, text: string, author: string, afterId: string | null): void {
    const existing = this.entries.get(id);
    this.entries.set(id, {
      id,
      kind: "item",
      text,
      author,
      afterId,
      delivered: existing?.delivered ?? false,
    });
    this.persist();
  }

  appendItem(id: string, text: string): void {
    const existing = this.entries.get(id);
    if (existing === undefined) return;
    existing.text += text;
    this.persist();
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.persist();
  }

  upsertComment(id: string, text: string, author: string): void {
    const existing = this.entries.get(id);
    this.entries.set(id, {
      id,
      kind: "comment",
      text,
      author,
      afterId: null,
      delivered: existing?.delivered ?? false,
    });
    this.persist();
  }

  private persist(): void {
    const value: PersistedInbox = { version: 1, entries: [...this.entries.values()] };
    atomicWriteJson(this.file, value);
  }

  private renderable(entry: InboxEntry): boolean {
    if (entry.delivered) return false;
    if (entry.afterId === null) return true;
    if (this.entries.has(entry.afterId)) return true;
    // Predecessor not in view: hold until the snapshot is complete, then
    // treat it as a hidden/removed root.
    return this.live;
  }

  /** Order by after_id where both ends are present; arrival order otherwise. */
  private ordered(): InboxEntry[] {
    const pending = [...this.entries.values()].filter((e) => this.renderable(e));
    const byId = new Map(pending.map((e) => [e.id, e]));
    const out: InboxEntry[] = [];
    const placed = new Set<string>();
    const place = (entry: InboxEntry): void => {
      if (placed.has(entry.id)) return;
      const pred = entry.afterId !== null ? byId.get(entry.afterId) : undefined;
      if (pred !== undefined && !placed.has(pred.id)) place(pred);
      placed.add(entry.id);
      out.push(entry);
    };
    for (const entry of pending) place(entry);
    return out;
  }

  pendingCount(): number {
    return this.ordered().length;
  }

  /**
   * Build the next injection batch. Every batch carries a unique delivery
   * id: Qwen drops byte-identical additionalContext blocks after the first
   * delivery per session, unconditionally.
   */
  nextBatch(): InboxBatch | null {
    const ordered = this.ordered();
    if (ordered.length === 0) return null;
    const deliveryId = `d-${randomBytes(6).toString("hex")}`;
    const lines: string[] = [];
    const ids: string[] = [];
    let size = 0;
    for (const entry of ordered) {
      const body =
        entry.text.length > MAX_ENTRY_CHARS
          ? `${entry.text.slice(0, MAX_ENTRY_CHARS - 1)}…`
          : entry.text;
      const line =
        entry.kind === "comment"
          ? `- ${entry.author} commented: ${body}`
          : `- ${entry.author}: ${body}`;
      if (size + line.length > MAX_BATCH_CHARS) break;
      lines.push(line);
      ids.push(entry.id);
      size += line.length;
    }
    if (ids.length === 0) return null;
    const text =
      `<delta-inbox delivery="${deliveryId}">\n` +
      "Teammate activity on this Delta thread since your last turn:\n" +
      lines.join("\n") +
      "\nTake this into account in your reply; it does not by itself request new work.\n" +
      "</delta-inbox>";
    return { deliveryId, ids, text };
  }

  markDelivered(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry !== undefined && !entry.delivered) {
        entry.delivered = true;
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}
