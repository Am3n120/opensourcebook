import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  /** Loads again; keeps the current data on screen meanwhile. */
  reload: () => Promise<void>;
  /** Replaces the data with what an edit returned. */
  set: (data: T) => void;
}

/** Runs `load` when `key` changes; a slower, older answer never overwrites a newer one. */
export function useLoad<T>(load: () => Promise<T>, key: unknown[]): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });

  const run = useCallback(async () => {
    const mine = ++seq.current;
    await Promise.resolve();
    if (mine !== seq.current) return;
    setLoading(true);
    try {
      const value = await loadRef.current();
      if (mine === seq.current) {
        setData(value);
        setError(undefined);
      }
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, key);

  const set = useCallback((value: T) => {
    seq.current++;
    setData(value);
    setError(undefined);
    setLoading(false);
  }, []);

  return { data, error, loading, reload: run, set };
}
