// Secrets on disk: one JSON file of ciphertext and metadata in the state
// directory, replaced atomically (write, fsync, rename) on every change.
// Writes are serialised within this single process.
import { randomBytes } from "node:crypto";
import { mkdir, open as openFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { open, randomKey, seal, secretAad, userKeyAad, type Box } from "./crypto.ts";
import {
  hintFor,
  MAX_SECRET_LENGTH,
  MIN_SECRET_LENGTH,
  normalizeDescription,
  normalizeHosts,
  normalizeInjection,
  normalizeName,
  normalizeWrites,
  PolicyError,
  type Injection,
  type WritePolicy,
} from "./policy.ts";

export type SecretMeta = {
  id: string;
  name: string;
  description: string;
  /** Fixed at creation: changing where a secret may go means entering it again. */
  hosts: string[];
  injection: Injection;
  writes: WritePolicy;
  /** Last four characters of a long value, so people can tell keys apart. */
  hint: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
};

type StoredSecret = SecretMeta & { value: Box };
type StoredUser = { key: Box; secrets: Record<string, StoredSecret> };
type StoreFile = { version: 1; users: Record<string, StoredUser> };

export const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const MAX_SECRETS_PER_USER = 100;

export class NotFound extends Error {}
export class Conflict extends Error {}

// No part of a value is returned, including hints stored by earlier versions.
const metaOf = ({ value: _value, ...meta }: StoredSecret): SecretMeta => ({ ...meta, hint: "" });

export class SecretStore {
  private data: StoreFile = { version: 1, users: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly masterKey: Buffer;

  constructor(dir: string, masterKey: Buffer) {
    this.file = path.join(dir, "secrets.json");
    this.masterKey = masterKey;
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as StoreFile;
      if (parsed.version !== 1 || typeof parsed.users !== "object") throw new Error("unknown store version");
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const handle = await openFile(tmp, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.data));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, this.file);
  }

  /** Runs `change` alone, then saves; a failed save leaves memory as it was. */
  private mutate<T>(change: () => T): Promise<T> {
    const run = this.queue.then(async () => {
      const before = JSON.stringify(this.data);
      try {
        const result = change();
        await this.persist();
        return result;
      } catch (error) {
        this.data = JSON.parse(before) as StoreFile;
        throw error;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private userKey(userId: string, create: boolean): Buffer | null {
    let user = this.data.users[userId];
    if (!user) {
      if (!create) return null;
      user = { key: seal(this.masterKey, randomKey(), userKeyAad(userId)), secrets: {} };
      this.data.users[userId] = user;
    }
    return open(this.masterKey, user.key, userKeyAad(userId));
  }

  list(userId: string): SecretMeta[] {
    const user = this.data.users[userId];
    if (!user) return [];
    return Object.values(user.secrets)
      .map(metaOf)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(userId: string, secretId: string): SecretMeta | null {
    const secret = this.data.users[userId]?.secrets[secretId];
    return secret ? metaOf(secret) : null;
  }

  findByName(userId: string, name: string): SecretMeta | null {
    const user = this.data.users[userId];
    if (!user) return null;
    const found = Object.values(user.secrets).find((secret) => secret.name === name);
    return found ? metaOf(found) : null;
  }

  /** The plaintext, for the forwarding path only. */
  reveal(userId: string, secretId: string): string {
    const secret = this.data.users[userId]?.secrets[secretId];
    const key = secret ? this.userKey(userId, false) : null;
    if (!secret || !key) throw new NotFound("no such secret");
    return open(key, secret.value, secretAad(userId, secretId)).toString("utf8");
  }

  /** A new secret's id: the audit record names it before the secret exists. */
  newId(): string {
    return `sec_${randomBytes(12).toString("base64url")}`;
  }

  /** Checks a new secret as `create` would, without storing it. Throws PolicyError or Conflict. */
  checkCreate(userId: string, input: { name: unknown; description?: unknown; hosts: unknown; injection: unknown; writes?: unknown }, value: string): string {
    const name = normalizeName(input.name);
    normalizeDescription(input.description);
    normalizeHosts(input.hosts);
    normalizeInjection(input.injection);
    checkValue(value);
    const user = this.data.users[userId];
    if (user && Object.values(user.secrets).some((secret) => secret.name === name)) {
      throw new Conflict(`a secret named ${name} already exists`);
    }
    if (user && Object.keys(user.secrets).length >= MAX_SECRETS_PER_USER) throw new PolicyError("too many secrets");
    return name;
  }

  async create(
    userId: string,
    input: { name: unknown; description?: unknown; hosts: unknown; injection: unknown; writes?: unknown },
    value: string,
    id: string = this.newId(),
  ): Promise<SecretMeta> {
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const hosts = normalizeHosts(input.hosts);
    const injection = normalizeInjection(input.injection);
    const writes = normalizeWrites(input.writes);
    checkValue(value);
    return this.mutate(() => {
      const key = this.userKey(userId, true)!;
      const user = this.data.users[userId];
      if (Object.values(user.secrets).some((secret) => secret.name === name)) {
        throw new Conflict(`a secret named ${name} already exists`);
      }
      if (Object.keys(user.secrets).length >= MAX_SECRETS_PER_USER) throw new PolicyError("too many secrets");
      if (user.secrets[id]) throw new Conflict("secret id in use");
      const now = new Date().toISOString();
      const secret: StoredSecret = {
        id,
        name,
        description,
        hosts,
        injection,
        writes,
        hint: hintFor(value),
        created_at: now,
        updated_at: now,
        last_used_at: null,
        value: seal(key, Buffer.from(value, "utf8"), secretAad(userId, id)),
      };
      user.secrets[id] = secret;
      return metaOf(secret);
    });
  }

  /** Checks an update as `update` would, without applying it. Throws PolicyError or NotFound. */
  checkUpdate(userId: string, secretId: string, input: { description?: unknown; writes?: unknown }): SecretMeta {
    if (input.description !== undefined) normalizeDescription(input.description);
    if (input.writes !== undefined) normalizeWrites(input.writes);
    const current = this.get(userId, secretId);
    if (!current) throw new NotFound("no such secret");
    return current;
  }

  hasUser(userId: string): boolean {
    return !!this.data.users[userId];
  }

  /**
   * Changes what does not widen where the value can go: the description and
   * the write policy. Hosts and the way the value is attached are fixed.
   */
  async update(userId: string, secretId: string, input: { description?: unknown; writes?: unknown }): Promise<SecretMeta> {
    const description = input.description === undefined ? undefined : normalizeDescription(input.description);
    const writes = input.writes === undefined ? undefined : normalizeWrites(input.writes);
    return this.mutate(() => {
      const secret = this.data.users[userId]?.secrets[secretId];
      if (!secret) throw new NotFound("no such secret");
      if (description !== undefined) secret.description = description;
      if (writes !== undefined) secret.writes = writes;
      secret.updated_at = new Date().toISOString();
      return metaOf(secret);
    });
  }

  remove(userId: string, secretId: string): Promise<void> {
    return this.mutate(() => {
      const user = this.data.users[userId];
      if (!user?.secrets[secretId]) throw new NotFound("no such secret");
      delete user.secrets[secretId];
    });
  }

  /** Forgets a user: their key and every secret. True when there was anything. */
  purgeUser(userId: string): Promise<boolean> {
    return this.mutate(() => {
      if (!this.data.users[userId]) return false;
      delete this.data.users[userId];
      return true;
    });
  }

  /** Records use without waiting on the disk; losing it in a crash costs nothing. */
  touch(userId: string, secretId: string): void {
    const secret = this.data.users[userId]?.secrets[secretId];
    if (!secret) return;
    const now = Date.now();
    if (secret.last_used_at && now - Date.parse(secret.last_used_at) < 60_000) return;
    void this.mutate(() => {
      secret.last_used_at = new Date(now).toISOString();
    }).catch(() => undefined);
  }
}

function checkValue(value: string): void {
  if (value.length < MIN_SECRET_LENGTH) throw new PolicyError(`a secret must be at least ${MIN_SECRET_LENGTH} characters`);
  if (value.length > MAX_SECRET_LENGTH) throw new PolicyError("secret is too long");
  if (/[\r\n\0]/.test(value)) throw new PolicyError("a secret cannot contain line breaks");
}
