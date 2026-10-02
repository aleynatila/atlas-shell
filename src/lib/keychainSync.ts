/**
 * Decide which OS keychain call (if any) a save needs for one entry, and record
 * the new state in `known` (last password written to / read from the keychain).
 *
 * - unchanged password            -> nothing
 * - new or changed password       -> "set"
 * - password cleared              -> "delete", but only for an entry we have seen
 *   with a password; an entry we know nothing about yet (startup still reading the
 *   keychain) is never deleted.
 */
export function planKeychainWrite(
  known: Map<string, string | undefined>,
  id: string,
  pass: string | undefined,
): "set" | "delete" | null {
  const prev = known.get(id);
  if (pass) {
    if (prev === pass) return null;
    known.set(id, pass);
    return "set";
  }
  if (prev !== undefined) {
    known.set(id, undefined);
    return "delete";
  }
  return null;
}
