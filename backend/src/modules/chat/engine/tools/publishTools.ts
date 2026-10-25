// publish_document (PUBLISH_TOOLS in toolSchemas.ts): the assistant asks the
// person to publish a document as a link (docs/publishing.md). It only
// proposes; the turn pauses on a form where the person confirms or changes
// who can open the link, sets any password and publishes. The password goes
// from that form to the server and never into the conversation; the answer
// tells the assistant the link.

import crypto from "node:crypto";
import type { PublishRequestItem } from "@mike/contracts";
import type { Db } from "../../../../lib/db";
import { publishPreflight } from "../../../publications/publications.service";

export const PUBLISH_TOOL_NAME = "publish_document";

const EXPIRY = new Set([7, 30, 90]);

const REFUSAL: Record<string, string> = {
  publishing_off: "Publishing is not turned on for this deployment.",
  not_found: "No such document, or the person cannot open it.",
  not_owner: "Only the document's owner can publish it, and the person is not its owner.",
  unsupported_type: "This kind of file cannot be published. HTML, Markdown, text, PDF, images, and Word or PowerPoint files (as PDF) can.",
  no_rendition: "This file has no PDF version yet, so it cannot be published.",
};

export async function runPublishTool(input: {
  db: Db;
  args: Record<string, unknown>;
  userId: string;
  userEmail?: string | null;
  /** The document the model named, resolved from its label. */
  document: { document_id: string; version_id?: string | null } | null;
  canAsk: boolean;
}): Promise<{ content: string; item?: PublishRequestItem }> {
  const fail = (error: string) => ({ content: JSON.stringify({ ok: false, error }) });
  if (!input.canAsk) return fail("This conversation cannot pause for the person. Ask them to publish from the document viewer.");
  if (!input.document) return fail("doc_id must name a document in this conversation.");
  const check = await publishPreflight(
    input.db,
    input.userId,
    input.userEmail ?? undefined,
    input.document.document_id,
    input.document.version_id ?? null,
  );
  if (!check.ok) return fail(REFUSAL[check.code]);
  const { args } = input;
  const expires = args.expires_in_days === null || args.expires_in_days === "never" ? null : Number(args.expires_in_days ?? 30);
  const item: PublishRequestItem = {
    id: crypto.randomUUID(),
    kind: "publish",
    document_id: check.documentId,
    version_id: check.versionId,
    filename: check.filename,
    audience: args.password === true ? "password" : "public",
    require_sign_in: args.require_sign_in === true,
    expires_in_days: expires === null ? null : EXPIRY.has(expires) ? expires : 30,
    purpose: typeof args.purpose === "string" ? args.purpose.trim().slice(0, 300) : "",
  };
  return {
    content: JSON.stringify({
      ok: false,
      status: "awaiting_user",
      message:
        "The person has been shown a form to publish the document, with your suggestions. Nothing is published yet; they choose who can open it and set any password, and their answer, with the link if they publish, arrives in the next message. You never see the password.",
    }),
    item,
  };
}
