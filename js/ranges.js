// Interval-set helpers for the "included" ranges, plus source <-> output time mapping.
// A range set is a sorted array of non-overlapping {s, e} (seconds, source time).

const EPS = 1e-4;

export function normalize(ranges) {
  const r = ranges
    .filter(x => x.e - x.s > EPS)
    .map(x => ({ s: x.s, e: x.e }))
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const x of r) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e + EPS) last.e = Math.max(last.e, x.e);
    else out.push(x);
  }
  return out;
}

export function addRange(ranges, s, e) {
  if (e < s) [s, e] = [e, s];
  return normalize([...ranges, { s, e }]);
}

export function subtractRange(ranges, s, e) {
  if (e < s) [s, e] = [e, s];
  const out = [];
  for (const r of ranges) {
    if (r.e <= s || r.s >= e) { out.push({ ...r }); continue; }
    if (r.s < s) out.push({ s: r.s, e: s });
    if (r.e > e) out.push({ s: e, e: r.e });
  }
  return normalize(out);
}

/** Fraction of [s,e] that is covered by the set. */
export function coverage(ranges, s, e) {
  let c = 0;
  for (const r of ranges) c += Math.max(0, Math.min(r.e, e) - Math.max(r.s, s));
  return (e - s) > 0 ? c / (e - s) : 0;
}

export function totalDuration(ranges) {
  return ranges.reduce((a, r) => a + (r.e - r.s), 0);
}

/** Clip the set so the total length is at most maxLen (keeps earliest material). */
export function capRanges(ranges, maxLen) {
  const out = [];
  let acc = 0;
  for (const r of ranges) {
    if (acc >= maxLen - EPS) break;
    const len = Math.min(r.e - r.s, maxLen - acc);
    out.push({ s: r.s, e: r.s + len });
    acc += len;
  }
  return out;
}

/** Source time -> output time, or null if the source time is excluded. */
export function srcToOut(ranges, t) {
  let acc = 0;
  for (const r of ranges) {
    if (t >= r.s - EPS && t < r.e) return acc + Math.max(0, t - r.s);
    acc += r.e - r.s;
  }
  return null;
}

/** Source time -> output time, snapping forward to the next kept range if excluded. */
export function srcToOutSnap(ranges, t) {
  let acc = 0;
  for (const r of ranges) {
    if (t < r.s) return acc;
    if (t < r.e) return acc + (t - r.s);
    acc += r.e - r.s;
  }
  return acc;
}

/** Output time -> source time. */
export function outToSrc(ranges, o) {
  let acc = 0;
  for (const r of ranges) {
    const len = r.e - r.s;
    if (o < acc + len) return r.s + (o - acc);
    acc += len;
  }
  const last = ranges[ranges.length - 1];
  return last ? last.e : 0;
}

/** The kept range containing t, or the next one after t. */
export function rangeAtOrAfter(ranges, t) {
  for (const r of ranges) if (t < r.e - EPS) return r;
  return null;
}
