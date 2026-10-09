import { afterEach, describe, expect, it, vi } from "vitest";

import {
    drainReceiptsSince,
    queryReceipts,
    recordReceipt,
    RECEIPT_BUFFER_CAP,
    verifyAttestation,
    type FetchLike,
} from "../index";
import { getConfiguredModel, resetModelRegistryCache } from "../../registry";

const originalConfig = process.env.MIKE_MODEL_CONFIG_JSON;

function configureModels(models: unknown[]): void {
    process.env.MIKE_MODEL_CONFIG_JSON = JSON.stringify({ models });
    resetModelRegistryCache();
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

afterEach(() => {
    if (originalConfig === undefined) delete process.env.MIKE_MODEL_CONFIG_JSON;
    else process.env.MIKE_MODEL_CONFIG_JSON = originalConfig;
    resetModelRegistryCache();
    vi.unstubAllGlobals();
});

describe("verifyAttestation", () => {
    it("accepts a well-formed attestation and reports its identity fields", async () => {
        const fetchFn = vi.fn<FetchLike>(async () =>
            jsonResponse({
                measurement: "measurement-abc",
                instance_id: "endpoint-42",
                verifier_version: "0.5.1",
            }),
        );

        const result = await verifyAttestation({
            verifierUrl: "https://verifier.test/",
            expectedMeasurement: "measurement-abc",
            fetchFn,
        });

        expect(result).toEqual({
            ok: true,
            measurement: "measurement-abc",
            endpointId: "endpoint-42",
            verifierVersion: "0.5.1",
        });
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const [calledUrl, init] = fetchFn.mock.calls[0]!;
        expect(calledUrl).toBe("https://verifier.test/attestation");
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("accept")).toBe(
            "application/json",
        );
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("falls back across Phala field spellings, then to 'unknown'", async () => {
        const aliasFields = vi.fn<FetchLike>(async () =>
            jsonResponse({
                measurement: "m",
                endpoint_id: "endpoint-2",
                version: "9",
            }),
        );
        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                fetchFn: aliasFields,
            }),
        ).toEqual({
            ok: true,
            measurement: "m",
            endpointId: "endpoint-2",
            verifierVersion: "9",
        });

        const bare = vi.fn<FetchLike>(async () =>
            jsonResponse({ measurement: "m" }),
        );
        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                fetchFn: bare,
            }),
        ).toEqual({
            ok: true,
            measurement: "m",
            endpointId: "unknown",
            verifierVersion: "unknown",
        });
    });

    it("fails closed on a measurement mismatch", async () => {
        const fetchFn = vi.fn<FetchLike>(async () =>
            jsonResponse({ measurement: "observed-measurement" }),
        );

        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                expectedMeasurement: "required-measurement",
                fetchFn,
            }),
        ).toEqual({ ok: false, reason: "measurement mismatch" });
    });

    it("fails closed when the document carries no measurement", async () => {
        const fetchFn = vi.fn<FetchLike>(async () =>
            jsonResponse({ instance_id: "endpoint-1" }),
        );

        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                fetchFn,
            }),
        ).toEqual({
            ok: false,
            reason: "attestation response is missing a measurement",
        });
    });

    it("reports a non-2xx verifier answer instead of throwing", async () => {
        const fetchFn = vi.fn<FetchLike>(async () =>
            jsonResponse({ error: "attestation unavailable" }, 503),
        );

        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                fetchFn,
            }),
        ).toEqual({ ok: false, reason: "verifier returned HTTP 503" });
    });

    it("times out bounded instead of hanging", async () => {
        const fetchFn: FetchLike = (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(
                        Object.assign(new Error("The operation was aborted."), {
                            name: "AbortError",
                        }),
                    );
                });
            });

        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                timeoutMs: 20,
                fetchFn,
            }),
        ).toEqual({ ok: false, reason: "verifier timed out after 20ms" });
    });

    it("reports network and parsing failures as reasons, never throws", async () => {
        const refused = vi.fn<FetchLike>(async () => {
            throw new Error("ECONNREFUSED");
        });
        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                fetchFn: refused,
            }),
        ).toEqual({
            ok: false,
            reason: "verifier request failed: ECONNREFUSED",
        });

        const nonJson = vi.fn<FetchLike>(
            async () =>
                new Response("<html>bad gateway</html>", { status: 200 }),
        );
        expect(
            await verifyAttestation({
                verifierUrl: "https://verifier.test",
                fetchFn: nonJson,
            }),
        ).toEqual({ ok: false, reason: "verifier returned a non-JSON body" });
    });

    it("refuses a malformed verifier URL without fetching", async () => {
        const fetchFn = vi.fn<FetchLike>(async () => {
            throw new Error("fetch must not be reached");
        });

        expect(
            await verifyAttestation({ verifierUrl: "not-a-url", fetchFn }),
        ).toEqual({ ok: false, reason: "invalid verifier URL 'not-a-url'" });
        expect(
            await verifyAttestation({
                verifierUrl: "ftp://verifier.test",
                fetchFn,
            }),
        ).toEqual({
            ok: false,
            reason: "invalid verifier URL 'ftp://verifier.test'",
        });
        expect(fetchFn).not.toHaveBeenCalled();
    });
});

describe("drainReceiptsSince", () => {
    it("drains everything when no cursor is given, then leaves an empty ring", () => {
        recordReceipt({
            endpointId: "drain-endpoint",
            modelId: "drain-model",
            measurement: "m",
            verifierVersion: "v",
            requestId: "drain-1",
        });
        const drained = drainReceiptsSince();
        expect(drained.map((receipt) => receipt.requestId)).toContain("drain-1");
        expect(queryReceipts({ modelId: "drain-model" })).toHaveLength(0);
    });

    it("returns only receipts after the cursor and removes them", () => {
        const first = recordReceipt({
            endpointId: "cursor-endpoint",
            modelId: "cursor-model",
            measurement: "m",
            verifierVersion: "v",
            requestId: "cursor-1",
        });
        recordReceipt({
            endpointId: "cursor-endpoint",
            modelId: "cursor-model",
            measurement: "m",
            verifierVersion: "v",
            requestId: "cursor-2",
        });
        const drained = drainReceiptsSince(first.id);
        expect(drained.map((receipt) => receipt.requestId)).toEqual(["cursor-2"]);
        // The cursor receipt itself stays: it is the since-marker the next
        // drain measures from.
        expect(
            queryReceipts({ modelId: "cursor-model" }).map((receipt) => receipt.requestId),
        ).toEqual(["cursor-1"]);
    });
});

describe("inference receipts", () => {
    it("records an identity-only receipt with zero content fields", () => {
        const receipt = recordReceipt({
            endpointId: "endpoint-1",
            modelId: "dgx-receipts",
            measurement: "measurement-1",
            verifierVersion: "v1",
            requestId: "request-1",
        });

        // The exact key set is the contract: adding a prompt, response, or
        // system-text field to a receipt must fail this test.
        expect(Object.keys(receipt).sort()).toEqual([
            "at",
            "endpointId",
            "id",
            "measurement",
            "modelId",
            "requestId",
            "verifierVersion",
        ]);
        expect(receipt.id).toBeTruthy();
        expect(receipt.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(receipt.endpointId).toBe("endpoint-1");
        expect(receipt.modelId).toBe("dgx-receipts");
        expect(receipt.measurement).toBe("measurement-1");
        expect(receipt.verifierVersion).toBe("v1");
        expect(receipt.requestId).toBe("request-1");
    });

    it("filters by modelId and endpointId", () => {
        recordReceipt({
            endpointId: "filter-endpoint-a",
            modelId: "filter-model",
            measurement: "m",
            verifierVersion: "v",
            requestId: "filter-request-a",
        });
        recordReceipt({
            endpointId: "filter-endpoint-b",
            modelId: "filter-model",
            measurement: "m",
            verifierVersion: "v",
            requestId: "filter-request-b",
        });

        expect(queryReceipts({ modelId: "filter-model" })).toHaveLength(2);
        expect(queryReceipts({ endpointId: "filter-endpoint-a" })).toHaveLength(
            1,
        );
        expect(
            queryReceipts({
                modelId: "filter-model",
                endpointId: "filter-endpoint-b",
            })[0]?.requestId,
        ).toBe("filter-request-b");
        expect(queryReceipts({ modelId: "no-such-model" })).toHaveLength(0);
    });

    it("keeps the newest receipts and drops the oldest at the cap", () => {
        const oldest = recordReceipt({
            endpointId: "ring-endpoint",
            modelId: "ring-model",
            measurement: "m",
            verifierVersion: "v",
            requestId: "ring-oldest",
        });
        for (let index = 0; index < RECEIPT_BUFFER_CAP; index++) {
            recordReceipt({
                endpointId: "ring-endpoint",
                modelId: "ring-model",
                measurement: "m",
                verifierVersion: "v",
                requestId: `ring-${index}`,
            });
        }

        const ring = queryReceipts({ modelId: "ring-model" });
        expect(ring).toHaveLength(RECEIPT_BUFFER_CAP);
        expect(ring.some((receipt) => receipt.id === oldest.id)).toBe(false);
        expect(ring.at(-1)?.requestId).toBe(
            `ring-${RECEIPT_BUFFER_CAP - 1}`,
        );
        expect(queryReceipts()).toHaveLength(RECEIPT_BUFFER_CAP);
    });
});

describe("configured-model attestation parsing", () => {
    function attestedModelConfig(attestation: unknown) {
        return {
            id: "attested-endpoint",
            provider: "openai-compatible",
            location: "cloud",
            baseUrl: "https://dgx.test/v1",
            attestation,
        };
    }

    it("accepts a valid attestation declaration", () => {
        configureModels([
            attestedModelConfig({
                endpoint: "https://verifier.test",
                expectedMeasurement: "measurement-1",
            }),
        ]);

        expect(getConfiguredModel("attested-endpoint")?.attestation).toEqual({
            endpoint: "https://verifier.test",
            expectedMeasurement: "measurement-1",
        });
    });

    it("rejects an endpoint without an expected measurement", () => {
        configureModels([
            attestedModelConfig({ endpoint: "https://verifier.test" }),
        ]);

        // An unpinned lane would accept whatever the endpoint self-reports,
        // so the declaration is malformed and the whole model is rejected.
        expect(getConfiguredModel("attested-endpoint")).toBeNull();
    });

    it("leaves models without an attestation declaration unchanged", () => {
        configureModels([
            {
                id: "plain-endpoint",
                provider: "openai-compatible",
                location: "cloud",
                baseUrl: "https://plain.test/v1",
            },
        ]);

        const model = getConfiguredModel("plain-endpoint");
        expect(model).not.toBeNull();
        expect(model?.attestation).toBeUndefined();
    });

    it("rejects the whole model when the declaration is malformed", () => {
        const invalidDeclarations = [
            "https://verifier.test",
            [],
            {},
            { endpoint: "" },
            { endpoint: 42 },
            { endpoint: "not-a-url" },
            { endpoint: "ftp://verifier.test" },
            { endpoint: "https://verifier.test?token=1" },
            { endpoint: "https://user:pass@verifier.test" },
            { endpoint: "https://verifier.test", expectedMeasurement: 42 },
            { endpoint: "https://verifier.test", expectedMeasurement: "" },
        ];

        for (const attestation of invalidDeclarations) {
            configureModels([attestedModelConfig(attestation)]);
            expect(
                getConfiguredModel("attested-endpoint"),
                `expected rejection for ${JSON.stringify(attestation)}`,
            ).toBeNull();
        }
    });
});
