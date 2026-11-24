/**
 * What this browser kept under the app's old name. The app's keys in localStorage began with "re." and now begin
 * with "opensourcebook.". Once, when the app loads, each old key is copied to its new name unless the new one is
 * already there, so a person's theme, reminders switch, audio speed and open threads are kept. The old keys stay
 * where they are: a copy from before the change that is opened in the same browser still finds them. It happens
 * once (DONE marks it), because a new key that is absent later is a choice too: "system" as the theme, a closed thread.
 * (index.html reads the old theme key itself until then, so the first page after updating does not flash.)
 */
const OLD = "re.";
const NEW = "opensourcebook.";
/** Set once the copy has been made. index.html names it too. */
export const DONE = "opensourcebook.carried";

/** Copies every old key to its new name when the new one is absent. Answers how many it copied. */
export function carryOldStorage(storage: Storage | undefined = safeStorage()): number {
  if (!storage) return 0;
  let copied = 0;
  try {
    if (storage.getItem(DONE) !== null) return 0;
    const old: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(OLD)) old.push(key);
    }
    for (const key of old) {
      const next = NEW + key.slice(OLD.length);
      const value = storage.getItem(key);
      if (value === null || storage.getItem(next) !== null) continue;
      storage.setItem(next, value);
      copied++;
    }
    storage.setItem(DONE, "1");
  } catch {
    // Storage that cannot be read or is full (a private window): the app runs with its defaults.
  }
  return copied;
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
