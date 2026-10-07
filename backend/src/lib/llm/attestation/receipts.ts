// Inference receipts: an in-memory audit trail of requests that passed
// attestation verification.
//
// A receipt is deliberately content-free — the type has no prompt, response,
// system-prompt, or message fields, so it can never leak conversation text.
// It records only the endpoint identity, the measurement it attested, the
// verifier version, and opaque ids. The buffer is a process-local ring: the
// newest 1000 receipts are queryable (tests, admin diagnostics), and older
// ones are dropped rather than written anywhere.

import { randomUUID } from "node:crypto";

export type InferenceReceipt = {
    id: string;
    /** ISO timestamp of when the request passed verification. */
    at: string;
    endpointId: string;
    modelId: string;
    measurement: string;
    verifierVersion: string;
    requestId: string;
};

export type ReceiptFields = Omit<InferenceReceipt, "id" | "at">;

/** Ring capacity: oldest receipts are dropped first. */
export const RECEIPT_BUFFER_CAP = 1000;

const receipts: InferenceReceipt[] = [];

export function recordReceipt(fields: ReceiptFields): InferenceReceipt {
    const receipt: InferenceReceipt = {
        id: randomUUID(),
        at: new Date().toISOString(),
        endpointId: fields.endpointId,
        modelId: fields.modelId,
        measurement: fields.measurement,
        verifierVersion: fields.verifierVersion,
        requestId: fields.requestId,
    };
    receipts.push(receipt);
    while (receipts.length > RECEIPT_BUFFER_CAP) receipts.shift();
    return receipt;
}

/** Returns a snapshot copy of the ring in insertion order (oldest first). */
export function queryReceipts(filter?: {
    modelId?: string;
    endpointId?: string;
}): InferenceReceipt[] {
    return receipts.filter(
        (receipt) =>
            (filter?.modelId === undefined ||
                receipt.modelId === filter.modelId) &&
            (filter?.endpointId === undefined ||
                receipt.endpointId === filter.endpointId),
    );
}
