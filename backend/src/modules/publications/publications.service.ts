// Facade for the publications module (docs/publishing.md): links that open a
// frozen copy of a document on the content origin, for anyone with the link
// or with the link and a password.
//
//   publications.shared.ts  — policy, tokens, the server key, passwords, headers
//   publications.bundle.ts  — the files a publication serves
//   publications.manage.ts  — make, list and revoke (signed in)
//   publications.serve.ts   — find a live link, unlock it, find a file (public)
//   publications.throttle.ts — refuse addresses that keep guessing link names
//   linkWords.ts            — the words link names are made of

export {
    createPublication,
    describeOwnPublication,
    grantPublicationAccess,
    listPublications,
    publishPreflight,
    revokePublication,
    updatePublication,
    publishingConfigView,
    type PublicationView,
    type PublishFailure,
    type PublishPreflight,
    type UpdatePublicationInput,
} from "./publications.manage";
export {
    findLivePublication,
    findPublicationFile,
    publicationMemberOk,
    publicationUnlocked,
    redeemSignInGrant,
    unlockPublication,
    type LivePublication,
    type PublicationFile,
} from "./publications.serve";
export {
    MEMBER_COOKIE,
    MEMBER_TTL_SECONDS,
    PAGE_CSP,
    SITE_CSP,
    safeInnerPath,
    signInUrl,
    UNLOCK_COOKIE,
    UNLOCK_TTL_SECONDS,
    publishingConfig,
    tokenFromRequest,
} from "./publications.shared";
export { MISS_LIMIT, MISS_WINDOW_MS, missThrottle, recordMiss, resetMissThrottle } from "./publications.throttle";
export { escapeHtml } from "./publications.bundle";
