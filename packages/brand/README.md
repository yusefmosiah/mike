# Brand

`brand.json` is the product's name and the few facts said alongside it. Every
place a person sees the product's name reads it from here: the web app through
`frontend/src/app/lib/brand.ts` (inlined at build time by `next.config.ts`),
the Word add-in through its `@brand` webpack alias, and the API through
`backend/src/lib/brand.ts`.

| Field | Used for |
| --- | --- |
| `name` | The name people see: page titles, the logo, the agent's prompt, generated files' author, the authenticator-app entry, the name connectors see when you sign in to them, the built-in workflows' author |
| `description` | The page description and link previews |
| `website` | Where the logo links in production |
| `sourceUrl` | Where the source code is published. The AGPL requires an install to offer its users the source it runs, so a rebranded install keeps this pointing at its own published source |

To rebrand an install, replace `brand.json` before building the images. Text
that does not need the name should not use it: write "the document couldn't be
read", not "<name> couldn't read the document".
`frontend/src/__tests__/brandName.test.ts` fails when the name appears in a
string or JSX text in the web app, the add-in or the API.

The iPhone and desktop apps' names, the Word add-in manifest, sign-in email
sender name and the logo mark are not read from here yet.
