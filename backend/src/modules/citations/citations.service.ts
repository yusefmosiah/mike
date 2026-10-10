// Stable public API. Keep implementations in the topic files below.
export {
    CITATION_CHECK_JOB,
    cancelCitationCheck,
    getCitationChecks,
    handleCitationCheckJob,
    recheckCitation,
    runCitationCheck,
    startCitationCheck,
    summarizeCitationCheck,
    type CitationCheck,
    type Recheck,
    type RunDeps,
    type VerificationTask,
} from "./citations.tasks";
export {
    AUTO_CITATION_CHECK_JOB,
    autoCheckCitations,
    autoCheckPending,
    citationFingerprint,
    handleAutoCitationCheckJob,
    scheduleAutoCitationCheck,
    type AutoCheck,
} from "./citations.auto";
export { extractCitations, type ExtractedCitation } from "./citations.extract";
export { judgeSupport, verdictFor, type Judgement, type Support } from "./citations.judge";
export { matchQuote, sha256, type Verdict } from "./citations.verifier";
export { fetchWebPage, type CaseLookup, type WebFetch, type WebSearch } from "./citations.sources";
