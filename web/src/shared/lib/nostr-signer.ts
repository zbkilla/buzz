import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

export type UnsignedNostrEvent = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export type SignedNostrEvent = UnsignedNostrEvent & {
  id: string;
  pubkey: string;
  sig: string;
};

type Nip07Provider = {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNostrEvent): Promise<SignedNostrEvent>;
};

declare global {
  interface Window {
    nostr?: Nip07Provider;
  }
}

export class Nip07UnavailableError extends Error {
  constructor() {
    super("A NIP-07 browser extension is required to join in the browser.");
    this.name = "Nip07UnavailableError";
  }
}

let ephemeralSecretKey: Uint8Array | null = null;

function getEphemeralSecretKey(): Uint8Array {
  if (!ephemeralSecretKey) {
    ephemeralSecretKey = generateSecretKey();
  }
  return ephemeralSecretKey;
}

export function hasNip07Provider(): boolean {
  return typeof window !== "undefined" && window.nostr != null;
}

/**
 * Extensions disagree on pubkey formats: some return bech32 npubs, some
 * uppercase hex. Normalize both to lowercase hex before comparing.
 */
function normalizePubkey(pubkey: string): string {
  const trimmed = pubkey.trim();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return trimmed.toLowerCase();
    }
  }
  return trimmed.toLowerCase();
}

function includesAllTags(expected: string[][], actual: string[][]): boolean {
  return expected.every((tag) =>
    actual.some(
      (candidate) =>
        candidate.length === tag.length &&
        candidate.every((value, i) => value === tag[i]),
    ),
  );
}

/**
 * Signers may re-stamp created_at with their own clock; NIP-42 relays
 * enforce their own recency window, so anything within this drift is fine.
 */
const CREATED_AT_DRIFT_SECS = 900;

/**
 * Sign with NIP-07 when available, otherwise use a page-lifetime key.
 *
 * The signed event is validated cryptographically (id hash + signature via
 * `verifyEvent`) rather than by strict field equality, because compliant
 * extensions legitimately re-stamp created_at, append tags, or return the
 * pubkey in a different encoding. The requested kind, content, and tags must
 * still be intact so a signer cannot silently alter what was authorized.
 *
 * The ephemeral fallback preserves anonymous browsing on open relays. Flows
 * that create durable membership must set `requireNip07` so a reload cannot
 * orphan a relay-membership row.
 */
export async function signNostrEvent(
  template: Omit<UnsignedNostrEvent, "created_at"> & {
    created_at?: number;
  },
  options?: { requireNip07?: boolean },
): Promise<SignedNostrEvent> {
  const unsigned: UnsignedNostrEvent = {
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  };
  const provider = typeof window === "undefined" ? undefined : window.nostr;

  if (provider) {
    const expectedPubkey = normalizePubkey(await provider.getPublicKey());
    const signed = await provider.signEvent(unsigned);
    const validSignature =
      typeof signed?.id === "string" &&
      typeof signed?.sig === "string" &&
      verifyEvent(signed);
    if (
      !validSignature ||
      normalizePubkey(signed.pubkey) !== expectedPubkey ||
      signed.kind !== unsigned.kind ||
      signed.content !== unsigned.content ||
      Math.abs(signed.created_at - unsigned.created_at) >
        CREATED_AT_DRIFT_SECS ||
      !includesAllTags(unsigned.tags, signed.tags)
    ) {
      throw new Error("The NIP-07 extension returned an invalid signed event.");
    }
    return signed;
  }

  if (options?.requireNip07) {
    throw new Nip07UnavailableError();
  }

  const secretKey = getEphemeralSecretKey();
  const signed = finalizeEvent(unsigned, secretKey);
  if (signed.pubkey !== getPublicKey(secretKey)) {
    throw new Error("Failed to create the ephemeral browser identity.");
  }
  return signed;
}
