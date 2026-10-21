// SPDX-License-Identifier: GPL-3.0-only
// In-memory search over the list stage. Every query token must match some field; results carry the
// matched ranges per field so the UI can highlight them. Accents fold ("cafe" finds "Café").

export interface SearchDoc {
  id: string;
  name: string;
  username?: string | null;
  /** Hostnames or URIs, shown and matched as plain text. */
  urls?: string[];
  /** Optional: only present if the caller chose to index notes. */
  notes?: string | null;
  /** Folder name: "crypto" finds what's in the Crypto folder. */
  folder?: string | null;
  favorite?: boolean;
}

export type Field = 'name' | 'username' | 'url' | 'notes' | 'folder';
export type Range = [start: number, end: number];

export interface SearchHit<T extends SearchDoc = SearchDoc> {
  doc: T;
  score: number;
  /** Ranges into the original strings. For `url`, keyed by index into doc.urls. */
  ranges: { name: Range[]; username: Range[]; url: Map<number, Range[]>; notes: Range[]; folder: Range[] };
}

/** Lowercase and strip accents one character at a time so indexes still line up with the original. */
export function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const base = ch.normalize('NFD')[0] ?? ch;
    // keep one UTF-16 unit per original unit so ranges map back
    out += ch.length === 1 ? base.toLowerCase().slice(0, 1) || ch : ch.toLowerCase();
  }
  return out;
}

interface Indexed<T> {
  doc: T;
  name: string;
  username: string;
  urls: string[];
  notes: string;
  folder: string;
}

const isWordStart = (s: string, i: number) => i === 0 || /[\s._@\-/·:()]/.test(s[i - 1]!);

/** Subsequence match ("ghb" in "github"), returns ranges or null. Only used on names. */
function subsequence(hay: string, needle: string): Range[] | null {
  const out: Range[] = [];
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) {
      const last = out[out.length - 1];
      if (last && last[1] === i) last[1] = i + 1;
      else out.push([i, i + 1]);
      j++;
    }
  }
  if (j < needle.length) return null;
  // A match scattered across a long name ("blue" in "...bravo...lima...uniform...echo") is noise, not a hit.
  const span = out[out.length - 1]![1] - out[0]![0];
  return span <= needle.length * 3 ? out : null;
}

function merge(rs: Range[]): Range[] {
  rs.sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

export class SearchIndex<T extends SearchDoc = SearchDoc> {
  private rows: Indexed<T>[] = [];

  constructor(docs: T[] = []) {
    this.set(docs);
  }

  set(docs: T[]): void {
    this.rows = docs.map((doc) => ({
      doc,
      name: fold(doc.name),
      username: fold(doc.username ?? ''),
      urls: (doc.urls ?? []).map(fold),
      notes: fold(doc.notes ?? ''),
      folder: fold(doc.folder ?? ''),
    }));
  }

  get size(): number {
    return this.rows.length;
  }

  search(query: string, limit = Infinity): SearchHit<T>[] {
    const tokens = fold(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const hits: SearchHit<T>[] = [];
    for (const r of this.rows) {
      const hit = this.scoreRow(r, tokens);
      if (hit) hits.push(hit);
    }
    hits.sort((a, b) => b.score - a.score || a.doc.name.length - b.doc.name.length || a.doc.name.localeCompare(b.doc.name));
    return hits.slice(0, limit);
  }

  private scoreRow(r: Indexed<T>, tokens: string[]): SearchHit<T> | null {
    const ranges: SearchHit<T>['ranges'] = { name: [], username: [], url: new Map(), notes: [], folder: [] };
    let score = 0;
    for (const t of tokens) {
      let best = 0;
      const i = r.name.indexOf(t);
      if (i >= 0) {
        best = r.name.startsWith(t) ? 40 : isWordStart(r.name, i) ? 30 : 20;
        ranges.name.push([i, i + t.length]);
      }
      const u = r.username.indexOf(t);
      if (u >= 0) {
        best = Math.max(best, r.username.startsWith(t) ? 15 : 12);
        ranges.username.push([u, u + t.length]);
      }
      r.urls.forEach((url, k) => {
        const p = url.indexOf(t);
        if (p >= 0) {
          best = Math.max(best, 10);
          ranges.url.set(k, [...(ranges.url.get(k) ?? []), [p, p + t.length]]);
        }
      });
      const f = r.folder.indexOf(t);
      if (f >= 0) {
        // Below the item's own fields: a folder holds many items, the name says which one.
        best = Math.max(best, r.folder.startsWith(t) || isWordStart(r.folder, f) ? 8 : 7);
        ranges.folder.push([f, f + t.length]);
      }
      const n = r.notes.indexOf(t);
      if (n >= 0) {
        // An exact hit in the notes beats a fuzzy guess at the name.
        best = Math.max(best, 6);
        ranges.notes.push([n, n + t.length]);
      }
      if (!best && t.length >= 3) {
        const sub = subsequence(r.name, t);
        if (sub) {
          best = 5;
          ranges.name.push(...sub);
        }
      }
      if (!best) return null;
      score += best;
    }
    if (r.doc.favorite) score += 1;
    ranges.name = merge(ranges.name);
    ranges.username = merge(ranges.username);
    ranges.notes = merge(ranges.notes);
    ranges.folder = merge(ranges.folder);
    for (const [k, v] of ranges.url) ranges.url.set(k, merge(v));
    return { doc: r.doc, score, ranges };
  }
}
