import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attachDocumentToReview } from "../../modules/tabular/tabular.service";
import { stackAuth, stackConfigured, stackDb } from "./stackDb";

// The upload worker adds a document dropped into a review to that review
// (uploads.processing.ts). Uploads of several files finish at the same time,
// so the add must not lose a concurrent one, and a retried job must not add
// a document twice.

const maybeDescribe = stackConfigured ? describe : describe.skip;
const db = stackDb()!;

maybeDescribe("adding an uploaded document to its review", () => {
    let ownerId = "";
    let ownerEmail = "";
    const reviewId = crypto.randomUUID();
    const documentIds = Array.from({ length: 3 }, () => crypto.randomUUID());

    beforeAll(async () => {
        ownerEmail = `attach-${Date.now()}@test.local`;
        const owner = await stackAuth().admin.createUser({
            email: ownerEmail,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (owner.error || !owner.data.user) throw owner.error ?? new Error("Could not create the owner");
        ownerId = owner.data.user.id;
        const documents = await db.from("documents").insert(
            documentIds.map((id) => ({ id, user_id: ownerId, status: "ready" })),
        );
        if (documents.error) throw documents.error;
        const review = await db.from("tabular_reviews").insert({
            id: reviewId,
            user_id: ownerId,
            title: "Attach review",
            columns_config: [{ index: 0, name: "Parties", prompt: "Who are the parties?" }],
            document_ids: null,
        });
        if (review.error) throw review.error;
    });

    afterAll(async () => {
        await db.from("tabular_reviews").delete().eq("id", reviewId);
        await db.from("documents").delete().in("id", documentIds);
        if (ownerId) await stackAuth().admin.deleteUser(ownerId);
    });

    const attach = (documentId: string, userId = ownerId) =>
        attachDocumentToReview(db, { reviewId, documentId, userId, userEmail: ownerEmail });
    const reviewDocuments = async () => {
        const { data } = await db.from("tabular_reviews").select("document_ids").eq("id", reviewId).single();
        return (data?.document_ids ?? []) as string[];
    };

    it("adds a document once, with its row, however often the job runs", async () => {
        expect(await attach(documentIds[0]!)).toBe(true);
        expect(await attach(documentIds[0]!)).toBe(true);
        expect(await reviewDocuments()).toEqual([documentIds[0]]);
        const { data: rows } = await db.from("tabular_review_rows").select("document_id").eq("review_id", reviewId);
        expect((rows ?? []).map((row: { document_id: string }) => row.document_id)).toEqual([documentIds[0]]);
    });

    it("keeps both of two documents added at the same moment", async () => {
        expect(await Promise.all([attach(documentIds[1]!), attach(documentIds[2]!)])).toEqual([true, true]);
        expect((await reviewDocuments()).sort()).toEqual([...documentIds].sort());
    });

    it("adds nothing for someone who cannot change the review", async () => {
        expect(await attach(documentIds[0]!, crypto.randomUUID())).toBe(false);
    });
});
