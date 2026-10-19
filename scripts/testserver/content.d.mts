// SPDX-License-Identifier: GPL-3.0-only
// Types for content.mjs (plaintext seed items; the seeder encrypts them).
export interface SeedUri { uri: string; match: number | null }
export interface SeedItem {
  type: number;
  name: string;
  notes: string | null;
  favorite?: boolean;
  reprompt?: number;
  login?: { username: string | null; password: string | null; totp: string | null; uris: SeedUri[] };
  card?: Record<string, string>;
  identity?: Record<string, string>;
  secureNote?: { type: number };
  fields?: Array<{ name: string; value: string; type: number }> | null;
  folderIdx?: number | null;
  itemKey?: boolean;
  collectionIdx?: number;
  seq?: number;
}
export const FOLDERS: string[];
export const ORG_COLLECTIONS: string[];
export const TEST_SITES: string[];
export function mulberry32(seed: number): () => number;
export function genPersonalItems(seed?: number, count?: number): SeedItem[];
export function genOrgItems(seed?: number, count?: number): SeedItem[];
