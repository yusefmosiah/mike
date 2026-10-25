// Facade for the publications module (docs/publishing.md): links that open a
// frozen copy of a document on the content origin, for anyone with the link
// or with the link and a password.
//
//   publications.shared.ts  — policy, tokens, the server key, passwords, headers
//   publications.bundle.ts  — the files a publication serves
//   publications.manage.ts  — make, list and revoke (signed in)
//   publications.serve.ts   — find a live link, unlock it, find a file (public)

export {
    createPublication,
    listPublications,
    revokePublication,
    publishingConfigView,
    type PublicationView,
    type PublishFailure,
} from "./publications.manage";
export {
    findLivePublication,
    findPublicationFile,
    publicationUnlocked,
    unlockPublication,
    type LivePublication,
    type PublicationFile,
} from "./publications.serve";
export {
    PAGE_CSP,
    SITE_CSP,
    UNLOCK_COOKIE,
    UNLOCK_TTL_SECONDS,
    publishingConfig,
    tokenFromRequest,
} from "./publications.shared";
export { escapeHtml } from "./publications.bundle";
