/**
 * Minimal Nostr client with NIP-01 queries and NIP-42 AUTH.
 *
 * Maintains one authenticated WebSocket per relay URL, shared by all
 * queries, so NIP-42 auth — and any NIP-07 extension approval prompt —
 * happens once per page load instead of once per query. Queries are
 * multiplexed over the shared socket by subscription id.
 */

import { makeAuthEvent } from "nostr-tools/nip42";
import {
  type SignedNostrEvent,
  signNostrEvent,
} from "@/shared/lib/nostr-signer";

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

export type NostrEvent = SignedNostrEvent;

const QUERY_TIMEOUT_MS = 10_000;
/**
 * Budget for the connect + NIP-42 handshake, including the time a human
 * takes to approve an extension signing prompt. Must stay below the relay's
 * own unauthenticated-connection timeout.
 */
const AUTH_TIMEOUT_MS = 55_000;
/** How long to wait for an AUTH challenge before treating the relay as open. */
const NO_CHALLENGE_GRACE_MS = 500;

type PendingQuery = {
  events: NostrEvent[];
  resolve: (events: NostrEvent[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ManagedSocket = {
  ws: WebSocket;
  ready: Promise<void>;
  queries: Map<string, PendingQuery>;
};

const sockets = new Map<string, ManagedSocket>();
let subCounter = 0;

function openSocket(wsUrl: string): ManagedSocket {
  const ws = new WebSocket(wsUrl);
  const queries = new Map<string, PendingQuery>();

  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Queries that arrive later re-await `ready`; absorb the rejection here so
  // a failed handshake with no queries in flight isn't an unhandled rejection.
  ready.catch(() => {});

  const managed: ManagedSocket = { ws, ready, queries };

  let readySettled = false;
  let authEventId: string | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearHandshakeTimers = () => {
    clearTimeout(authBudget);
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const finishReady = () => {
    if (!readySettled) {
      readySettled = true;
      clearHandshakeTimers();
      readyResolve();
    }
  };

  const failSocket = (error: Error) => {
    if (!readySettled) {
      readySettled = true;
      clearHandshakeTimers();
      readyReject(error);
    }
    if (sockets.get(wsUrl) === managed) {
      sockets.delete(wsUrl);
    }
    for (const [subId, query] of queries) {
      clearTimeout(query.timer);
      query.reject(error);
      queries.delete(subId);
    }
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  const authBudget = setTimeout(() => {
    failSocket(
      new Error(`Relay authentication timed out after ${AUTH_TIMEOUT_MS}ms`),
    );
  }, AUTH_TIMEOUT_MS);

  ws.addEventListener("open", () => {
    graceTimer = setTimeout(finishReady, NO_CHALLENGE_GRACE_MS);
  });

  ws.addEventListener("message", async (msg) => {
    let data: unknown;
    try {
      data = JSON.parse(String(msg.data));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;

    const [type] = data;

    if (type === "AUTH" && typeof data[1] === "string") {
      // NIP-42 challenge — sign and respond. Also covers a re-challenge on
      // an already-ready socket (auth expiry): the signed response is sent
      // transparently without disturbing in-flight queries.
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      const challenge = data[1];
      try {
        const signed = await signNostrEvent(makeAuthEvent(wsUrl, challenge));
        if (ws.readyState !== WebSocket.OPEN) return;
        authEventId = signed.id;
        ws.send(JSON.stringify(["AUTH", signed]));
      } catch (error) {
        failSocket(
          error instanceof Error
            ? error
            : new Error("Failed to sign relay authentication."),
        );
      }
      return;
    }

    if (type === "OK" && data[1] === authEventId) {
      if (data[2] === true) {
        finishReady();
      } else {
        failSocket(
          new Error(
            typeof data[3] === "string"
              ? data[3]
              : "Relay authentication failed.",
          ),
        );
      }
      return;
    }

    if (typeof data[1] !== "string") return;
    const query = queries.get(data[1]);
    if (!query) return;

    if (type === "EVENT" && data[2]) {
      query.events.push(data[2] as NostrEvent);
    } else if (type === "EOSE") {
      clearTimeout(query.timer);
      queries.delete(data[1]);
      try {
        ws.send(JSON.stringify(["CLOSE", data[1]]));
      } catch {
        // ignore
      }
      query.resolve(query.events);
    } else if (type === "CLOSED") {
      clearTimeout(query.timer);
      queries.delete(data[1]);
      query.reject(
        new Error(
          typeof data[2] === "string"
            ? data[2]
            : "subscription closed by relay",
        ),
      );
    }
  });

  ws.addEventListener("error", () => {
    failSocket(new Error("WebSocket connection failed"));
  });

  ws.addEventListener("close", () => {
    if (sockets.get(wsUrl) === managed) {
      sockets.delete(wsUrl);
    }
    if (!readySettled) {
      readySettled = true;
      clearHandshakeTimers();
      readyReject(new Error("Relay connection closed during authentication"));
    }
    // A clean close mid-query returns what was collected, matching the
    // previous per-query client's behavior.
    for (const [subId, query] of queries) {
      clearTimeout(query.timer);
      query.resolve(query.events);
      queries.delete(subId);
    }
  });

  return managed;
}

function getSocket(wsUrl: string): ManagedSocket {
  const existing = sockets.get(wsUrl);
  if (
    existing &&
    existing.ws.readyState !== WebSocket.CLOSING &&
    existing.ws.readyState !== WebSocket.CLOSED
  ) {
    return existing;
  }
  const created = openSocket(wsUrl);
  sockets.set(wsUrl, created);
  return created;
}

/**
 * Query `wsUrl` with the given filter over the shared authenticated socket,
 * collecting EVENTs until EOSE. Reconnects (and re-authenticates) lazily if
 * the shared socket has dropped.
 */
export async function queryEvents(
  wsUrl: string,
  filter: NostrFilter,
): Promise<NostrEvent[]> {
  const managed = getSocket(wsUrl);
  await managed.ready;
  return new Promise((resolve, reject) => {
    subCounter += 1;
    const subId = `q-${subCounter.toString(36)}-${Date.now().toString(36)}`;
    const query: PendingQuery = {
      events: [],
      resolve,
      reject,
      timer: setTimeout(() => {
        managed.queries.delete(subId);
        try {
          managed.ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          // ignore
        }
        reject(new Error(`Relay query timed out after ${QUERY_TIMEOUT_MS}ms`));
      }, QUERY_TIMEOUT_MS),
    };
    managed.queries.set(subId, query);
    try {
      managed.ws.send(JSON.stringify(["REQ", subId, filter]));
    } catch (error) {
      clearTimeout(query.timer);
      managed.queries.delete(subId);
      reject(
        error instanceof Error ? error : new Error("Failed to send query."),
      );
    }
  });
}
