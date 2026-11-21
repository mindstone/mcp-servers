/** Match concrete data paths; ** spans schema-recursive descendants. */
export function matchesFieldPath(declared, path) {
  const memo = new Map();
  function match(i, j) {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key);
    const result = i === declared.length ? j === path.length
      : declared[i] === '**' ? match(i + 1, j) || (j < path.length && match(i, j + 1))
      : j < path.length && (declared[i] === '*' || declared[i] === path[j]) && match(i + 1, j + 1);
    memo.set(key, result);
    return result;
  }
  return match(0, 0);
}
