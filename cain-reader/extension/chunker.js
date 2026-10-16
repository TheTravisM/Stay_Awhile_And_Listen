const TERMINATORS = new Set(['.', '!', '?', '…']);

function splitSentences(text) {
  const sentences = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!TERMINATORS.has(text[i])) continue;
    let j = i;
    while (j < text.length && TERMINATORS.has(text[j])) j++;
    const boundaryOk = j >= text.length || /\s/.test(text[j]);
    if (boundaryOk) {
      const sentence = text.slice(start, j).trim();
      if (sentence) sentences.push(sentence);
      start = j;
      i = j - 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function splitToFits(sentence, limit) {
  const pieces = [];
  let rest = sentence;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf(' ', limit);
    if (cut >= 1) {
      pieces.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut + 1).trimStart();
    } else {
      pieces.push(rest.slice(0, limit).trimEnd());
      rest = rest.slice(limit).trimStart();
    }
  }
  if (rest) pieces.push(rest.trimEnd());
  return pieces.filter(Boolean);
}

export function chunkText(raw, { maxChars = 300, firstMaxChars = 80, cap = 5000 } = {}) {
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return { chunks: [], truncated: false };

  const truncated = text.length > cap;
  const words = text.length > cap ? text.slice(0, cap).split(' ') : text.split(' ');

  const queue = [];
  for (const sentence of splitSentences(words.join(' '))) {
    queue.push(...splitToFits(sentence, maxChars));
  }

  const chunks = [];
  let current = '';
  for (const piece of queue) {
    const bucketLimit = chunks.length === 0 ? firstMaxChars : maxChars;
    if (!current) {
      current = piece;
    } else if (current.length + 1 + piece.length <= bucketLimit) {
      current += ' ' + piece;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);

  if (truncated) {
    let budget = cap;
    const out = [];
    for (const c of chunks) {
      const cost = c.length + (out.length ? 1 : 0);
      if (budget < cost) {
        budget -= Math.min(budget, 1);
        out.push(c.slice(0, Math.max(0, budget)).trimEnd());
        break;
      }
      budget -= cost;
      out.push(c);
    }
    return { chunks: out.filter(Boolean), truncated };
  }

  return { chunks, truncated };
}
