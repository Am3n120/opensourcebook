import { useCallback, useEffect, useRef, useState } from "react";
import type { Chat, Json, Message, ThreadCount, ThreadView } from "../api/types";
import { useApi } from "../app/context";
import { runningReply } from "../project/pieces";

/** How often a thread with a reply being written is read again: as often as the chat reads it. */
const POLL_MS = 600;
/** How often an open thread checks whether the person moved in the thing, to say the new spot. */
const HERE_MS = 1000;

/** Messages with fresh copies put in place and new ones added after, by seq. */
export function mergeMessages(list: Message[], fresh: Message[]): Message[] {
  if (fresh.length === 0) return list;
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of fresh) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * One made thing's thread (engine/docs/api.md, "Threads"): its messages, the
 * chat they live in, sending, and reading again while a reply is written,
 * the way the chat does. `where` says where the person is in the thing now
 * (the player's report), read when a message is sent; while the thread is
 * open the spot is said in words (`here`) as the person moves.
 */
export function useThread(planId: string, itemId: string, where: () => Json | undefined) {
  const client = useApi();
  const [messages, setMessages] = useState<Message[]>([]);
  const [chat, setChat] = useState<Chat>();
  const [item, setItem] = useState<ThreadView["item"]>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>();
  const [sending, setSending] = useState(false);
  const [here, setHere] = useState<string>();
  const whereRef = useRef(where);
  useEffect(() => {
    whereRef.current = where;
  });

  useEffect(() => {
    // A thread is drawn per thing (keyed by it), so this reads once per thing.
    let live = true;
    const at = whereRef.current();
    client
      .getThread(planId, itemId, at === undefined ? {} : { at })
      .then((t) => {
        if (!live) return;
        setMessages(t.messages);
        setChat(t.chat);
        setItem(t.item);
        setHere(t.here?.label);
        setLoaded(true);
      })
      .catch((e) => live && (setError(e), setLoaded(true)));
    return () => {
      live = false;
    };
  }, [client, planId, itemId]);

  const running = messages.filter(runningReply).map((m) => m.id).join(",");
  const last = messages.at(-1)?.seq ?? -1;
  const lastRef = useRef(last);
  useEffect(() => {
    lastRef.current = last;
  }, [last]);
  useEffect(() => {
    if (!running) return;
    const waiting = new Set(running.split(","));
    const seqs = messages.filter((m) => waiting.has(m.id)).map((m) => m.seq);
    const after = Math.min(...seqs) - 1;
    let live = true;
    let reading = false;
    const timer = setInterval(() => {
      if (reading) return;
      reading = true;
      client
        .getThread(planId, itemId, { after })
        .then((t) => {
          if (!live) return;
          setMessages((list) => mergeMessages(list, t.messages));
          if (t.chat) setChat(t.chat);
        })
        .catch(() => undefined)
        .finally(() => (reading = false));
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Only which replies are running restarts the reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, planId, itemId, running]);

  // The spot in words as the person moves in the thing (a video playing, the next question).
  useEffect(() => {
    let key = JSON.stringify(whereRef.current() ?? null);
    let live = true;
    const timer = setInterval(() => {
      const at = whereRef.current();
      const now = JSON.stringify(at ?? null);
      if (now === key || at === undefined) return;
      key = now;
      client
        .getThread(planId, itemId, { at, after: lastRef.current })
        .then((t) => {
          if (!live) return;
          setHere(t.here?.label);
          setMessages((list) => mergeMessages(list, t.messages));
        })
        .catch(() => undefined);
    }, HERE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [client, planId, itemId]);

  const send = useCallback(
    async (text: string, at?: Json): Promise<string | undefined> => {
      setSending(true);
      setError(undefined);
      try {
        const spot = at ?? whereRef.current();
        const r = await client.sendThread(planId, itemId, { text, ...(spot !== undefined ? { at: spot } : {}) });
        setChat(r.chat);
        setMessages((list) => mergeMessages(list, r.messages));
        return r.chat.id;
      } catch (e) {
        setError(e);
        return undefined;
      } finally {
        setSending(false);
      }
    },
    [client, planId, itemId],
  );

  return { messages, chat, item, loaded, error, sending, here, send, busy: sending || running !== "" };
}

/**
 * Which made things have a thread and how many messages each holds, by item
 * id: one project's, or every one of the person's. `bump` reads them again
 * (after a message is sent); a change of `again` reads them again too.
 */
export function useThreadCounts(projectId?: string, again?: unknown): { counts: Map<string, number>; bump: () => void } {
  const client = useApi();
  const [list, setList] = useState<ThreadCount[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    client
      .threads(projectId)
      .then((threads) => live && setList(threads))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, projectId, tick, again]);
  const counts = new Map<string, number>();
  for (const t of list) counts.set(t.itemId, (counts.get(t.itemId) ?? 0) + t.count);
  return { counts, bump: useCallback(() => setTick((n) => n + 1), []) };
}

/** Whether the person left a thing's thread open, kept on this device only; storage may be off. */
export function rememberedOpen(itemId: string): boolean {
  try {
    return window.localStorage.getItem(`opensourcebook.thread.${itemId}`) === "open";
  } catch {
    return false;
  }
}

export function rememberOpen(itemId: string, open: boolean): void {
  try {
    if (open) window.localStorage.setItem(`opensourcebook.thread.${itemId}`, "open");
    else window.localStorage.removeItem(`opensourcebook.thread.${itemId}`);
  } catch {
    // Not kept; it opens closed next time.
  }
}
