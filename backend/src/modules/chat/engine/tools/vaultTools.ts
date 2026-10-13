// The vault tools (VAULT_TOOLS in toolSchemas.ts).
//
// The model never sees a credential. It lists what the user stored, asks the
// user to store one (a form that sends the value straight to the vault), or
// takes a lease: a short-lived token that works only from the user's own
// workstation and makes the host's vault attach the credential to requests
// for the hosts it allows. A write lease on a credential whose changes need
// approval becomes an approval item; the lease is issued only once the user
// approves (runApprovedConnectorActions → executeApprovedVaultLease).
import type { AskInputItem, ConnectorApprovalItem, McpToolEvent, SecretRequestItem, VaultInjection } from "@mike/contracts";
import {
  issueVaultLease,
  leaseInstructions,
  listVaultSecrets,
  vaultEnabled,
  VaultRequestError,
  type VaultSecret,
} from "../../../../lib/vault/client";
import type { Db } from "../../../../lib/db";
import { resolveWorkstation, type WorkstationTarget } from "../../../../lib/workstation";

export const VAULT_TOOL_NAMES = new Set(["vault_secrets", "vault_request_secret", "vault_lease"]);
const CONNECTOR_NAME = "Vault";
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MOVED = "The workstation this turn started in is no longer this user's. Ask again in a new message.";

/** The user's own VM now: a temporary one can be wiped and reassigned mid-turn. */
async function stillTheirs(db: Db, userId: string, vm: string): Promise<boolean> {
  return (await resolveWorkstation(db, userId))?.vm === vm;
}
const MAX_HOSTS = 10;

export type VaultToolOutcome = {
  /** The tool result the model sees. */
  content: string;
  /** Shown in the chat's activity, like a connector call. */
  event?: McpToolEvent;
  /** A pause for the user: a credential to store, or a write lease to approve. */
  item?: AskInputItem;
};

const json = (value: unknown) => JSON.stringify(value);
const fail = (error: string): VaultToolOutcome => ({ content: json({ ok: false, error }) });

function activity(toolName: string, status: "ok" | "error", error?: string): McpToolEvent {
  return {
    type: "mcp_tool_call",
    connector_id: "",
    connector_name: CONNECTOR_NAME,
    tool_name: toolName,
    openai_tool_name: toolName,
    status,
    ...(error ? { error } : {}),
  };
}

const authOf = (injection: VaultInjection) =>
  injection.type === "basic"
    ? `basic (username ${injection.username})`
    : injection.type === "header"
      ? `header ${injection.name}`
      : "bearer";

function describe(secret: VaultSecret) {
  return {
    name: secret.name,
    description: secret.description || undefined,
    hosts: secret.hosts,
    auth: authOf(secret.injection),
    changes: secret.writes === "allow" ? "allowed without asking" : "need the user's approval",
  };
}

function injectionFrom(args: Record<string, unknown>): VaultInjection | string {
  const auth = args.auth;
  if (auth === "bearer") return { type: "bearer" };
  if (auth === "basic") {
    const username = typeof args.username === "string" ? args.username.trim() : "";
    return username ? { type: "basic", username: username.slice(0, 128) } : "basic needs a username";
  }
  if (auth === "header") {
    const header = typeof args.header === "string" ? args.header.trim() : "";
    return /^[A-Za-z0-9-]{1,64}$/.test(header) ? { type: "header", name: header } : "header needs a header name";
  }
  return "auth must be bearer, basic or header";
}

export async function runVaultTool(input: {
  db: Db;
  name: string;
  args: Record<string, unknown>;
  userId: string;
  workstation: WorkstationTarget | null;
  /** The workstation is the user's own: leases are issued only for it. */
  workspaceOwned: boolean;
  chatId: string | null;
  /** The turn can pause for the user (an approval or a form). */
  canAsk: boolean;
}): Promise<VaultToolOutcome> {
  const { name, args, userId } = input;
  if (!vaultEnabled()) return fail("The vault is not set up on this server.");
  if (!input.workspaceOwned || !input.workstation?.vm) {
    return fail("Stored credentials can be used only in the user's own workstation.");
  }
  const vm = input.workstation.vm;

  let secrets: VaultSecret[];
  try {
    secrets = await listVaultSecrets(userId);
  } catch {
    return { ...fail("The vault is not available right now."), event: activity(name, "error", "The vault is not available right now.") };
  }

  if (name === "vault_secrets") {
    return { content: json({ ok: true, secrets: secrets.map(describe) }), event: activity(name, "ok") };
  }

  if (name === "vault_request_secret") {
    if (!input.canAsk) {
      return fail("This conversation cannot pause for the user. Ask them to add the credential in Settings → Vault.");
    }
    const secretName = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
    if (!NAME.test(secretName)) return fail("name must be lowercase letters, digits, '.', '_' or '-'");
    if (secrets.some((secret) => secret.name === secretName)) {
      return fail(`A credential named ${secretName} is already stored. Use vault_lease with it, or pick another name.`);
    }
    const hosts = (Array.isArray(args.hosts) ? args.hosts : [])
      .filter((host): host is string => typeof host === "string" && !!host.trim())
      .map((host) => host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .slice(0, MAX_HOSTS);
    if (hosts.length === 0) return fail("hosts must name at least one host");
    if (hosts.some((host) => host.includes("*"))) return fail("hosts must be exact host names; wildcards are not allowed");
    const injection = injectionFrom(args);
    if (typeof injection === "string") return fail(injection);
    const purpose = typeof args.purpose === "string" ? args.purpose.trim().slice(0, 300) : "";
    const item: SecretRequestItem = {
      id: crypto.randomUUID(),
      kind: "secret",
      name: secretName,
      purpose,
      hosts: [...new Set(hosts)],
      injection,
    };
    return {
      content: json({
        ok: false,
        status: "awaiting_user",
        message: "The user has been asked to store the credential in a secure form. Nothing is stored yet; their answer arrives in the next message.",
      }),
      item,
    };
  }

  // vault_lease
  const ref = typeof args.secret === "string" ? args.secret.trim().toLowerCase() : "";
  const secret = secrets.find((candidate) => candidate.name === ref);
  if (!secret) {
    return fail(
      secrets.length
        ? `No stored credential named ${ref || "(none)"}. Stored: ${secrets.map((s) => s.name).join(", ")}.`
        : "The user has no stored credentials. Ask them to store one with vault_request_secret.",
    );
  }
  const access = args.access === "write" ? "write" : "read";
  if (access === "write" && secret.writes !== "allow") {
    if (!input.canAsk) {
      return fail(`Changes with ${secret.name} need the user's approval, which this conversation cannot ask for.`);
    }
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 300) : "";
    const item: ConnectorApprovalItem = {
      id: crypto.randomUUID(),
      kind: "approval",
      connector_name: CONNECTOR_NAME,
      tool_name: "vault_lease",
      title: `Allow changes with “${secret.name}”`,
      arguments: {
        credential: secret.name,
        hosts: secret.hosts.join(", "),
        for: "this turn (at most 15 minutes), from this conversation's workstation",
        ...(reason ? { reason } : {}),
      },
      binding: { type: "vault", secret_id: secret.id, vm, chat_id: input.chatId },
    };
    return {
      content: json({
        ok: false,
        status: "awaiting_approval",
        message: "Waiting for the user's approval. No lease has been issued yet.",
      }),
      item,
    };
  }
  if (!(await stillTheirs(input.db, userId, vm))) return { ...fail(MOVED), event: activity(name, "error", MOVED) };
  try {
    // The vault refuses, with its own reason, a VM someone else is working
    // in or has worked in (infra/vault/src/vms.ts).
    const lease = await issueVaultLease({ userId, vm, secret: secret.id, access, chatId: input.chatId });
    return { content: leaseInstructions(lease), event: activity(name, "ok") };
  } catch (error) {
    const message = error instanceof VaultRequestError ? error.message : "The vault is not available right now.";
    return { ...fail(message), event: activity(name, "error", message) };
  }
}

/**
 * Issues the write lease the user just approved, from the persisted item, if
 * the VM it names is still the user's own. The vault refuses it if someone
 * else is working, or has worked, in that VM.
 */
export async function executeApprovedVaultLease(
  db: Db,
  userId: string,
  item: ConnectorApprovalItem,
): Promise<{ content: string; event: McpToolEvent }> {
  const binding = item.binding;
  if (binding.type !== "vault") throw new Error("not a vault approval");
  const refuse = (message: string) => ({
    content: json({ ok: false, error: message }),
    event: activity("vault_lease", "error", message),
  });
  if (!(await stillTheirs(db, userId, binding.vm))) {
    return refuse("The workstation this was approved for is no longer yours. Ask for the lease again.");
  }
  try {
    const lease = await issueVaultLease({
      userId,
      vm: binding.vm,
      secret: binding.secret_id,
      access: "write",
      chatId: binding.chat_id,
    });
    return { content: leaseInstructions(lease), event: activity("vault_lease", "ok") };
  } catch (error) {
    const message = error instanceof VaultRequestError ? error.message : "The vault is not available right now.";
    return { content: json({ ok: false, error: message }), event: activity("vault_lease", "error", message) };
  }
}
