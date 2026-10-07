// Remote-attestation verification for configured inference endpoints.
//
// The verifier fetches the endpoint's attestation document and reports a
// verdict. It never throws: every failure — malformed URL, network error,
// timeout, non-2xx, unparseable body, missing measurement, measurement
// mismatch — comes back as `{ ok: false, reason }` so the caller decides what
// to do with it (the transport fails the request, loudly and without
// fallback). No prompt, response, or system text passes through this module,
// and the attestation document is only read for its identity fields.

export type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit,
) => Promise<Response>;

export type AttestationVerification =
    | {
          ok: true;
          measurement: string;
          endpointId: string;
          verifierVersion: string;
      }
    | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 5_000;

export interface VerifyAttestationOptions {
    /** Base URL of the verifier; the request goes to `{verifierUrl}/attestation`. */
    verifierUrl: string;
    /** TEE measurement the endpoint must report. Omitted means any measurement. */
    expectedMeasurement?: string;
    /** Request timeout in milliseconds. Defaults to 5s. */
    timeoutMs?: number;
    /** Test seam; defaults to the global fetch. */
    fetchFn?: FetchLike;
}

export async function verifyAttestation(
    options: VerifyAttestationOptions,
): Promise<AttestationVerification> {
    const {
        verifierUrl,
        expectedMeasurement,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        fetchFn = fetch,
    } = options;

    let requestUrl: string;
    try {
        const base = new URL(verifierUrl);
        if (
            (base.protocol !== "http:" && base.protocol !== "https:") ||
            !base.hostname
        ) {
            return {
                ok: false,
                reason: `invalid verifier URL '${verifierUrl}'`,
            };
        }
        requestUrl = `${verifierUrl.replace(/\/+$/, "")}/attestation`;
    } catch {
        return { ok: false, reason: `invalid verifier URL '${verifierUrl}'` };
    }

    const signal = AbortSignal.timeout(timeoutMs);
    try {
        const response = await fetchFn(requestUrl, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal,
        });
        if (!response.ok) {
            return {
                ok: false,
                reason: `verifier returned HTTP ${response.status}`,
            };
        }

        let body: unknown;
        try {
            body = await response.json();
        } catch {
            return { ok: false, reason: "verifier returned a non-JSON body" };
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return {
                ok: false,
                reason: "verifier returned an unexpected payload",
            };
        }

        const record = body as Record<string, unknown>;
        const measurement = nonEmptyString(record.measurement);
        if (!measurement) {
            return {
                ok: false,
                reason: "attestation response is missing a measurement",
            };
        }
        if (expectedMeasurement && measurement !== expectedMeasurement) {
            return { ok: false, reason: "measurement mismatch" };
        }

        return {
            ok: true,
            measurement,
            endpointId:
                nonEmptyString(record.instance_id) ??
                nonEmptyString(record.endpoint_id) ??
                "unknown",
            verifierVersion:
                nonEmptyString(record.verifier_version) ??
                nonEmptyString(record.version) ??
                "unknown",
        };
    } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (
            signal.aborted ||
            name === "AbortError" ||
            name === "TimeoutError"
        ) {
            return {
                ok: false,
                reason: `verifier timed out after ${timeoutMs}ms`,
            };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `verifier request failed: ${message}` };
    }
}

// Phala-style attestation documents spell the same fields differently across
// versions; take the first non-empty spelling, and let the caller record
// "unknown" rather than failing a verification over a missing label.
function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string" || !value.trim()) return undefined;
    return value.trim();
}
