# Safe Local Testing

Mike is a young open-source legal AI project. Until you have reviewed your
deployment and data flows, test it with disposable infrastructure and synthetic
documents only.

## Use Disposable Test Resources

Create separate test resources for Mike:

- a throwaway Postgres database and GoTrue auth server (the Docker Compose
  stack runs both)
- a throwaway S3-compatible storage bucket, such as Cloudflare R2
- disposable model-provider API keys with low spending limits
- a test email account

Do not use production databases, production storage buckets, firm API
keys, or real client documents for initial testing.

## Keep Secrets Out of the Frontend

The browser does not need auth configuration. Session handling and all auth
keys stay server-side.

For frontend testing, `frontend/.env.local` should normally contain only:

```env
API_BASE_URL=http://localhost:3001
```

Keep the GoTrue service-role key and the database URL in `backend/.env` only:

```env
AUTH_SERVICE_KEY=your-service-role-jwt
DATABASE_URL=postgres://postgres:your-password@localhost:54322/postgres
```

Model-provider keys such as `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and
`OPENROUTER_API_KEY` should also stay in `backend/.env`.

## Test With Synthetic Documents

Use fake or public sample documents when testing:

- synthetic NDAs
- sample contracts
- public court documents
- dummy PDF/DOCX files

Do not upload privileged, confidential, client, matter, personnel, or firm
knowledge-management material until you are comfortable with the deployment's
storage, logging, deletion, and model-provider behavior.

## Confirm Environment Files Are Not Tracked

Before running or committing changes, check:

```bash
git status --short
```

Stop if `.env`, `.env.local`, or any file containing secrets appears in the
output.

## Start With Non-LLM Flows

If you do not want to use model-provider keys yet, use dummy provider values and
test only the non-LLM flows first:

- account creation against the test auth server
- project creation
- file upload with synthetic documents
- folder organization
- document deletion

Then add one disposable, capped model-provider key and test assistant behavior
with synthetic documents.

## Clean Up After Testing

After testing, delete:

- uploaded objects from the storage bucket
- test database rows, or the whole test database
- disposable model-provider keys
- local `.env` files that contain secrets

For legal-document workflows, deletion semantics matter. Verify that your
storage bucket no longer contains test document objects after delete flows.
