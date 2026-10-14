# @mike/files

Mike's iOS plugin for downloads. The app's web view ignores a link that
downloads a blob, so `frontend/src/app/lib/nativeFiles.ts` sends the file here
and the plugin opens the share sheet: Save to Files, AirDrop, Mail, and other
apps.

## `MikeFiles.share({ data, filename, mimeType })`

- `data`: the file's bytes, base64.
- `filename`: the name shown in the sheet; folders are stripped.
- `mimeType`: optional, informational.

Resolves `{ completed }` (false when the person closed the sheet). Rejects with
a message for the user and one of these codes: `invalid-file`, `too-large`
(over 200 MB), `write-failed`, `unavailable`, `share-failed`.

The file is written to a temporary folder with complete file protection and
removed when the sheet closes. Names and contents are never logged.
