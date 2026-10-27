// The owner's switch that decides whether a standalone document is shared
// with their other conversations. Visibility, not authorization: access is
// still ensureDocAccess's verdict, and a standalone document is only ever
// readable by its owner. Confidentiality is a standalone concept in v1 —
// project and workflow documents are governed by their container's scope.

import type { Db } from "../../lib/db";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";
import { getDocument } from "./documents.access";

type ConfidentialDocumentRow = {
  id: string;
  user_id: string | null;
  project_id: string | null;
  workflow_id: string | null;
};

/**
 * Set `documents.confidential` for one standalone document the caller owns.
 * Returns the same document shape as GET /single-documents/:documentId so
 * the client can replace its row without a second request.
 */
export async function setDocumentConfidential(
  documentId: string,
  userId: string,
  userEmail: string | undefined,
  confidential: unknown,
  db: Db,
): Promise<ServiceResult<Record<string, unknown>>> {
  if (typeof confidential !== "boolean") {
    return failure("validation", "confidential must be a boolean");
  }

  const { data, error } = await db
    .from("documents")
    .select("id, user_id, project_id, workflow_id")
    .eq("id", documentId)
    .maybeSingle();
  if (error) return internalFailure(error);
  const doc = data as ConfidentialDocumentRow | null;
  // A non-owner cannot read a standalone document at all, so "not found" is
  // the honest answer and avoids turning this route into an existence oracle.
  if (!doc) return failure("not_found", "Document not found");
  if (doc.project_id || doc.workflow_id) {
    return failure(
      "conflict",
      "Only standalone documents can be marked confidential.",
    );
  }
  if (!doc.user_id || doc.user_id !== userId) {
    return failure("not_found", "Document not found");
  }

  const { error: updateError } = await db
    .from("documents")
    .update({ confidential, updated_at: new Date().toISOString() })
    .eq("id", documentId)
    .eq("user_id", userId)
    .is("project_id", null)
    .is("workflow_id", null);
  if (updateError) return internalFailure(updateError);

  const document = await getDocument(documentId, userId, userEmail, db);
  if (!document.ok) return failure("not_found", "Document not found");
  return ok(document.doc);
}
