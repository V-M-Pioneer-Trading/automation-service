/**
 * An index read on a record, typed for what it can return: `undefined` when
 * the key is absent. `Record<string, V>[key]` is typed `V`, which makes a
 * `?? fallback` or an `=== undefined` on it look dead to the type checker
 * while it is the whole point at runtime.
 */
export function lookup<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
  return record[key];
}
