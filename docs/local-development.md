# Local development

The recommended local setup uses Docker Compose to run the application and its
infrastructure together. No managed database, auth, or object-storage account
is required.

The stack includes:

- the Mike frontend and backend;
- Postgres, and GoTrue for authentication;
- RustFS for S3-compatible object storage; and
- Mailpit for local authentication email.

The database schema loads automatically on first boot.

## Start the Docker stack

Copy the local environment templates:

```bash
cp .env.example .env
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

- Set `DOWNLOAD_SIGNING_SECRET` and `USER_API_KEYS_ENCRYPTION_SECRET` to
  separate values generated with `openssl rand -hex 32`.
- Add an Anthropic, Gemini, or OpenAI API key, unless you plan to use Ollama
  exclusively.

Docker Compose supplies the local database, auth, and object-storage settings,
so leave those values unchanged. Then start the stack:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) and sign up.

An install created before Mike dropped Supabase keeps its data in the old
`db_data` volume and will not start until that data is moved; see
[Moving a Docker Compose install off the Supabase Postgres image](deployment.md#moving-a-docker-compose-install-off-the-supabase-postgres-image).

### Run the backend or frontend outside Docker

Start only the infrastructure, then point `backend/.env` at it:

```bash
docker compose up -d db auth mailpit storage createbucket redis
```

```env
AUTH_URL=http://localhost:54321
AUTH_SERVICE_KEY=<the AUTH_SERVICE_KEY default in docker-compose.yml>
DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres
```

Load the schema once (`docker compose up db-init` does it, or run
`backend/schema.sql` with `psql`), then `npm run dev --prefix backend`.

## Local service endpoints

| Service | Address | Notes |
| --- | --- | --- |
| Mike | `http://localhost:3000` | Main application |
| GoTrue | `http://localhost:54321` | Auth server (confirmation links, OAuth callbacks) |
| Postgres | `localhost:54322` | Host access for database tools |
| RustFS console | `http://localhost:9001` | `rustfsadmin` / `rustfsadmin` |
| Mailpit | `http://localhost:8025` | Captured local auth email |

The GoTrue JWT secret and `service_role` key in `docker-compose.yml` are
well-known local demo values. They are convenient for
localhost but must be regenerated before exposing an instance anywhere.

## Local registration and email

By default, a local email-and-password registration is automatically confirmed
and the new user is signed in. GoTrue sends authentication email; the Mike
backend does not send it directly.

To exercise the confirmation-email flow, set
`GOTRUE_MAILER_AUTOCONFIRM=false` in the root `.env`, then recreate Auth:

```bash
docker compose up -d --force-recreate auth
```

Open [Mailpit](http://localhost:8025) to read the confirmation message. Mailpit
also captures local email-change and password-reset messages, and no email
leaves your machine. These links pass through `/auth/callback` and return to the
relevant app screen. Local signup autoconfirm remains enabled by default; turn
it off only when you specifically want to test the confirmation flow.

## Local Google authentication

Create a Google **Web application** OAuth client and keep its secret out of
Git. Register this Google authorized redirect URI (GoTrue's callback,
`AUTH_PUBLIC_URL` + `/callback`):

```text
http://localhost:54321/callback
```

Google OAuth is enabled by default. Set the client values in the root `.env`,
or set `GOTRUE_EXTERNAL_GOOGLE_ENABLED=false` to opt out. Then recreate Auth:

```env
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=<client-id>
GOTRUE_EXTERNAL_GOOGLE_SECRET=<client-secret>
```

```bash
docker compose up -d --force-recreate auth
```

The Compose GoTrue allows any redirect target locally, including the web
callback and the Word dialog callback at
`https://localhost:3200/oauth-dialog.html`. Add your
Google account as an OAuth test user while the Google app remains in testing.

## Local models with Ollama

[Ollama](https://ollama.com) models are discovered dynamically. Anything shown
by `ollama list` appears in Mike's model pickers under **Local**, without an API
key.

The Dockerized backend reaches Ollama on the host at
`http://host.docker.internal:11434/v1`. Override `OLLAMA_BASE_URL` if Ollama is
available elsewhere.

Choose a model that fits the host's available memory, pull it, then refresh
Mike. Replace `MODEL_TAG` with a tag from the Ollama library:

```bash
ollama pull MODEL_TAG
```

Models with tool-calling support can drive the full assistant. If a local model
rejects tools, Mike retries without them so plain chat can continue. Model size
has a significant effect on speed and memory use, especially during tabular
review where the model may run across many cells.

## First run

1. Sign up in the app.
2. If no provider key is configured in `backend/.env`, open
   **Settings > API Keys** and add one.
3. To use live US case-law tools, add a CourtListener token in `backend/.env`
   or under **Settings > API Keys**.
4. Create or open a project and start chatting with documents.

Use synthetic or public documents until you have reviewed the deployment and
data flows. See [Safe local testing](safe-local-testing.md) for guidance.

## Error tracking locally

Error reporting is enabled by default using Mike's community Sentry project.
Set `SENTRY_DISABLED=true` to opt out on the backend, and use
`NEXT_PUBLIC_SENTRY_DISABLED=true` or `REACT_APP_SENTRY_DISABLED=true` for the
web app or Word add-in. To watch events locally instead, run
`node scripts/sentry-sink.mjs` and point each runtime's DSN at it; see
[observability.md](observability.md).

## Running application code without Docker

To run the frontend and backend processes directly while using separately
configured infrastructure, follow [Manual and production deployment](deployment.md)
through environment setup and dependency installation. Then start each package
in a separate terminal:

```bash
npm run dev --prefix backend
```

```bash
npm run dev --prefix frontend
```

Open [http://localhost:3000](http://localhost:3000).

For common setup problems, see [Troubleshooting](troubleshooting.md).
