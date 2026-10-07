# DOCX fixture corpus

Real Word-authored documents for testing document reading and editing. Every
file here was produced by Microsoft Word (per `docProps/app.xml`), not by a
generator, unless noted. Do not replace them with synthetic XML: the
synthetic-only tests in the original Station 1 passed while the code
corrupted real documents.

`SHA256SUMS` pins each file. Tests may read these files but never write them.

## `powertools/`

From [Open-XML-PowerTools](https://github.com/OfficeDev/Open-Xml-PowerTools)
(`TestFiles/`, branch `vNext`), MIT License, Copyright (c) Microsoft
Corporation.

- `rp/`: the RevisionProcessor set. Most `RPnnn-<name>.docx` files come with
  `-Accepted.docx` and/or `-Rejected.docx`: the same document after Word's
  Accept All / Reject All. These are the ground truth the accept/reject
  oracle in `../../helpers/trackedChangesOracle.ts` is calibrated against.
- `features/`: documents chosen for coverage of footnotes, endnotes, fields,
  content controls, comments, drawings, list numbering, text boxes, a table
  of contents, and Word-authored tracked revisions including moves.

## `public-legal/`

Long legal documents in real use.

| File | Source | Licence |
|---|---|---|
| `uk-msc-core-terms-v2.2a.docx` | UK Cabinet Office, The Model Services Contract v2.2A (2025), Core Terms, England & Wales | Open Government Licence v3.0 |
| `uk-msc-consolidated-schedules-v2.2a.docx` | Same, Consolidated Schedules (12,600+ paragraphs, 127 tables) | Open Government Licence v3.0 |
| `uk-academy-commercial-transfer-agreement-2013.docx` | UK Department for Education, Model academy commercial transfer agreement v3 | Open Government Licence v3.0 |
| `us-epa-model-crada-2025.docx` | US EPA, Model CRADA (2025-04-29, clean) | US federal government work, public domain |
| `us-epa-mcrada-interim-2024.docx` | US EPA, Material CRADA interim template (2024-09-13) | US federal government work, public domain |

Contains public sector information licensed under the Open Government Licence
v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).

## Known gaps

- No long Word-authored document with many footnotes. Footnote mechanics are
  covered only by the short PowerTools files.
- No Word-authored comments-heavy document beyond `HC031`.
