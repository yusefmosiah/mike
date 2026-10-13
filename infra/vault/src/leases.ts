// Leases: short-lived capabilities a VM presents to use one secret.
//
// A lease names the VM it was issued for, and the forwarding path checks it
// against the socket the request arrived on (one per VM), so a lease that
// leaves its VM is useless anywhere else. Leases live in memory only: a
// restart revokes all of them.
import { randomBytes } from "node:crypto";
import type { Access } from "./policy.ts";

export type Lease = {
  token: string;
  userId: string;
  vm: string;
  secretId: string;
  access: Access;
  expiresAt: number;
  /** The conversation it was issued for, for the audit log. */
  chatId: string | null;
};

export const DEFAULT_TTL_SECONDS = 15 * 60;
export const MAX_TTL_SECONDS = 60 * 60;
const MAX_LEASES_PER_USER = 50;

export class Leases {
  private readonly byToken = new Map<string, Lease>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(input: { userId: string; vm: string; secretId: string; access: Access; ttlSeconds?: number; chatId?: string | null }): Lease {
    this.sweep();
    const ttl = Math.min(MAX_TTL_SECONDS, Math.max(30, Math.floor(input.ttlSeconds ?? DEFAULT_TTL_SECONDS)));
    const mine = [...this.byToken.values()].filter((lease) => lease.userId === input.userId);
    if (mine.length >= MAX_LEASES_PER_USER) {
      // Drop the oldest rather than refuse: leases are cheap to reissue.
      mine.sort((a, b) => a.expiresAt - b.expiresAt);
      this.byToken.delete(mine[0].token);
    }
    const lease: Lease = {
      token: `mvl_${randomBytes(32).toString("base64url")}`,
      userId: input.userId,
      vm: input.vm,
      secretId: input.secretId,
      access: input.access,
      expiresAt: this.now() + ttl * 1000,
      chatId: input.chatId ?? null,
    };
    this.byToken.set(lease.token, lease);
    return lease;
  }

  /** The live lease for `token` presented from `vm`, or null. */
  check(token: string, vm: string): Lease | null {
    const lease = this.byToken.get(token);
    if (!lease) return null;
    if (lease.expiresAt <= this.now()) {
      this.byToken.delete(token);
      return null;
    }
    return lease.vm === vm ? lease : null;
  }

  revoke(filter: { token?: string; userId?: string; secretId?: string; chatId?: string }): number {
    let count = 0;
    for (const lease of this.byToken.values()) {
      if (filter.token && lease.token !== filter.token) continue;
      if (filter.userId && lease.userId !== filter.userId) continue;
      if (filter.secretId && lease.secretId !== filter.secretId) continue;
      if (filter.chatId && lease.chatId !== filter.chatId) continue;
      this.byToken.delete(lease.token);
      count++;
    }
    return count;
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, lease] of this.byToken) if (lease.expiresAt <= now) this.byToken.delete(token);
  }
}
