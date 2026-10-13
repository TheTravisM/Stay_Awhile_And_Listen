import { test } from 'node:test';
import assert from 'node:assert';
import { chunkText } from '../chunker.js';

test('empty and whitespace-only input returns no chunks', () => {
  assert.deepStrictEqual(chunkText(''), { chunks: [], truncated: false });
  assert.deepStrictEqual(chunkText('   \n\t  '), { chunks: [], truncated: false });
});

test('one short sentence becomes a single chunk', () => {
  const { chunks, truncated } = chunkText('Stay awhile and listen.');
  assert.strictEqual(truncated, false);
  assert.deepStrictEqual(chunks, ['Stay awhile and listen.']);
});

test('first chunk stays under 120 and the rest under 300', () => {
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  const raw = sentence.repeat(20); // ~1600 chars, no truncation
  const { chunks, truncated } = chunkText(raw, { maxChars: 300, firstMaxChars: 120 });
  assert.strictEqual(truncated, false);
  assert.ok(chunks.length > 1, 'expected several chunks');
  assert.ok(chunks[0].length <= 120, `first chunk ${chunks[0].length} > 120`);
  for (const c of chunks.slice(1)) {
    assert.ok(c.length <= 300, `chunk ${c.length} > 300`);
  }
});

test('a 400-char sentence with no punctuation splits below the limit', () => {
  // 12 words of 30 chars + 1 word of 28 chars + 12 spaces = 400 chars
  const sentence = Array.from({ length: 12 }, () => 'a'.repeat(30))
    .concat('b'.repeat(28)).join(' ');
  assert.strictEqual(sentence.length, 400);
  assert.ok(!/[.!?…\n]/.test(sentence), 'expected no sentence punctuation');
  const { chunks } = chunkText(sentence, { maxChars: 300, firstMaxChars: 120 });
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= 300, `chunk ${c.length} > 300`);
  }
});

test('input longer than cap is truncated and kept under cap', () => {
  const raw = 'a'.repeat(6000);
  const { chunks, truncated } = chunkText(raw, { maxChars: 300, firstMaxChars: 120, cap: 5000 });
  assert.strictEqual(truncated, true);
  assert.ok(chunks.reduce((n, c) => n + c.length, 0) <= 5000);
  for (const c of chunks) {
    assert.ok(c.length <= 300, `chunk ${c.length} > 300`);
  }
});

test('joined chunks lose no words', () => {
  const raw =
    'First paragraph with several words. Second paragraph ' +
    'keeps going and on and on until it is long enough to ' +
    'require more than one chunk for reading aloud.';
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const { chunks } = chunkText(raw);
  const joined = chunks.join(' ');
  assert.strictEqual(joined, normalized);
});
