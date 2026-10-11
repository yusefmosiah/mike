/**
 * The open models' worker: runs browserModels.engine.ts off the page's main
 * thread. Each message is one request with an id; it answers with progress
 * while a model downloads, then the result or a failure. Library error text
 * stays here: the page shows its own message.
 */

import { handleEngineRequest, type EngineRequest } from "./browserModels.engine";

type Incoming = EngineRequest & { id: number };

const scope = self as unknown as {
    onmessage: ((event: MessageEvent<Incoming>) => void) | null;
    postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
    const { id, ...request } = event.data;
    handleEngineRequest(request as EngineRequest, (fraction) => scope.postMessage({ id, type: "progress", fraction })).then(
        (result) => scope.postMessage({ id, type: "done", result }),
        () => scope.postMessage({ id, type: "error" }),
    );
};
