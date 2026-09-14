// Small typo-tolerance helpers for the combobox "Did you mean:" row. No
// dependency — the option lists are tiny, so a plain DP Levenshtein is fine.
export function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[t.length];
}

// Options within `maxDistance` edits of the query, closest first. Short queries
// get a tighter budget so "ace" doesn't suggest half the list.
export function nearMatches(query: string, options: string[], maxDistance = 2): string[] {
  const q = query.trim();
  if (q.length < 3) return [];
  const budget = Math.min(maxDistance, Math.max(1, Math.floor(q.length / 3)));
  return options
    .map((option) => ({ option, distance: levenshtein(q, option) }))
    .filter(({ distance }) => distance > 0 && distance <= budget)
    .sort((a, b) => a.distance - b.distance)
    .map(({ option }) => option);
}
