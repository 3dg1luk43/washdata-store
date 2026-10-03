// The landing's merged approved + pending brand list must paginate (audit STORE-08):
// it used to stop at 60 with no cursor, hiding every brand after the 60th.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBrandPages } from '../lib/brand_pages.js';

const B = (lc, status) => ({ id: lc, brand_lc: lc, status });

// Simulate the two Firestore streams and walk the pages through the cursor.
function walk(approved, pending, pageSize) {
  const seen = [];
  let cursor = null;
  for (let guard = 0; guard < 100; guard++) {
    const after = (xs) => xs.filter((b) => cursor === null || b.brand_lc > cursor).slice(0, pageSize);
    const { items, cursor: next } = mergeBrandPages(after(approved), after(pending), pageSize);
    seen.push(...items.map((b) => b.brand_lc));
    if (!next) break;
    cursor = next;
  }
  return seen;
}

test('every brand is reached exactly once, in order', () => {
  const names = Array.from({ length: 157 }, (_, i) => `b${String(i).padStart(3, '0')}`);
  const approved = names.filter((_, i) => i % 3 === 0).map((n) => B(n, 'approved'));
  const pending = names.filter((_, i) => i % 3 !== 0).map((n) => B(n, 'pending'));
  assert.deepEqual(walk(approved, pending, 60), names);
  assert.deepEqual(walk(approved, pending, 7), names);
});

test('a page never ends past what a full stream has fetched', () => {
  // Pending is dense early, approved late: the bound is pending's last fetched name.
  const pending = ['a1', 'a2', 'a3'].map((n) => B(n, 'pending'));
  const approved = ['a0', 'z1', 'z2'].map((n) => B(n, 'approved'));
  const { items, cursor } = mergeBrandPages(approved, pending, 3);
  assert.deepEqual(items.map((b) => b.brand_lc), ['a0', 'a1', 'a2']);
  assert.equal(cursor, 'a2');
});

test('a short last page has no cursor', () => {
  const { cursor } = mergeBrandPages([B('a', 'approved')], [B('b', 'pending')], 60);
  assert.equal(cursor, null);
});
