# Deletion and retention policy

Status: **draft for legal review, 2026-10-22.** This page records what deletion
does in Mike today, the rules that bear on it, and the policy we propose.
Nothing in the "Proposed policy" section is built yet, and nothing here is
legal advice. The technical evidence, with file and line references, is in
[the Pi deletion investigation](reports/pi-deletion-2026-10-22.md).

## Why this needs a policy

Depending on the field, the role and the kind of data, true deletion is
either required or forbidden, and often both apply within one firm at once.
A firm may have to erase a person's data on request under privacy law, or
destroy material when a protective order or a data agreement ends. The same
firm may be forbidden to delete trust-account records, files under a
litigation hold, or a broker-dealer client's communications. A single
"delete" button cannot satisfy both. The product needs to say what is
deleted, where and when, and who can stop it, and when it erases, the
erasure must be real.

## What deletion does today

When a person deletes a chat, a project or their account, Mike removes what
the app shows: the chat, its messages, sharing grants and citation checks.
Several copies remain.

| Where | What it holds | Removed by deletion today? |
|---|---|---|
| Chat rows in the app database | Messages, attachments list, citations | **Yes** |
| The model's conversation store (Pi Durable) | The full transcript the model saw: prompts, answers, tool results, summaries, system prompts, subagent work, and records of each turn including the person's email | **No.** Background subagents of a deleted chat are stopped and their task records erased; their transcripts stay. Word add-in and tabular review chats get no cleanup there at all. |
| Audit log | Chat title, email, model, cost | Not on chat or project deletion. Removed on account deletion. |
| Citation snapshots | Full text of retrieved cases, web pages, documents | **No** |
| Uploaded documents | The files themselves | Not with a chat (they belong to the library or project). Yes with the project or account. |
| Memory | Notes learned from chats | Not with a chat, by design. Yes with a memory wipe, project or account. |
| Workstation computers | Files the agent wrote, disk snapshots, logs of web requests | **No.** They belong to a person, not a chat. |
| Exports and job records | Short-lived copies | Expire on their own (24 hours to 30 days) |
| Backups | Database copies | **No.** Kept until the backup is pruned. |
| Model providers | Prompts sent to them | Governed by each provider's own policy |

The privacy settings page and the account deletion dialog say "permanently
delete". **For the model's conversation store, that is not true today.** We
should correct the wording before any customer relies on it.

## What it takes to erase the model's conversation store

Nothing here is a hard limit: we can change Mike's code, and Pi upstream,
to do what the policy requires. What it costs:

- Pi today deletes a conversation only while nothing holds the store open,
  and Mike's server holds it open while it runs. Live deletion needs a new
  Pi interface that stops a conversation's work, clears caches and removes
  its records, or a maintenance step while the server starts.
- A branched chat reads its earlier part from the chat it came from. Erasing
  the original means first copying that shared part into the branch, or
  deciding the branch goes too.
- Some records span all chats (each turn's record holds the user's email) and
  keep their history as a chain of changes. They need restructuring per chat,
  or periodic compaction that drops old history.
- Backups need either a short, stated expiry with deletions re-applied after
  any restore, or per-chat encryption keys that are destroyed on erasure.

The investigation lays out five ways to do it, from small to large.

## The rules that bear on deletion

Gathered by automated research on 2026-10-22. Items marked † came from
secondary sources or could not be confirmed against the primary text, and
counsel should check them.

### Rules that push toward erasure

- **GDPR and UK GDPR.**
  - Right to erasure on request (Art. 17), answered within one month, extendable by two months for complex requests (Art. 12(3)).
  - Data kept no longer than necessary (Art. 5(1)(e)) and limited to what is necessary (Art. 5(1)(c)); the controller must be able to show compliance (Art. 5(2)).
  - Recipients of the data must be told of an erasure (Art. 19).
  - At the end of service, a processor deletes or returns all personal data at the controller's choice, copies included, unless law requires storage (Art. 28(3)(g)). A legal-AI vendor serving a firm is typically the processor and the firm the controller.
  - Sources: [Art. 17](https://gdpr-info.eu/art-17-gdpr/), [Art. 12](https://gdpr-info.eu/art-12-gdpr/), [Art. 5](https://gdpr-info.eu/art-5-gdpr/), [Art. 19](https://gdpr-info.eu/art-19-gdpr/), [Art. 28](https://gdpr-info.eu/art-28-gdpr/).
- **Backups.** The UK regulator (ICO) expects erasure to reach backups. Data that cannot be overwritten at once must be put "beyond use", used for nothing else, overwritten on a set schedule, and the person told what happens. ([ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/))
- **What counts as erased.** Encrypted data is still personal data while the key exists. No regulator statement accepting key destruction ("crypto-shredding") as erasure was found†. The EDPB's draft anonymisation guidelines are open for consultation until 30 October 2026†.
- **US privacy laws.**
  - California (CCPA/CPRA) gives a right to deletion; a service provider deletes when the business directs it ([§ 1798.105](https://cppa.ca.gov/regulations/pdf/cppa_act.pdf)). More states' laws took effect in 2026†.
  - Customer information covered by the GLBA Safeguards Rule must be disposed of within two years of last use, unless needed or required by law ([16 CFR 314.4(c)(6)](https://www.law.cornell.edu/cfr/text/16/314.4)).
  - Consumer report information must be disposed of securely ([16 CFR 682.3](https://www.law.cornell.edu/cfr/text/16/682.3)).
- **Other countries.** China's PIPL (Art. 47) and Brazil's LGPD (Art. 18) both include deletion duties or rights†.
- **Health data.** A HIPAA business associate must return or destroy health information when the contract ends, or, where that is not feasible, protect it and limit its use ([45 CFR 164.504(e)(2)(ii)(J)](https://www.law.cornell.edu/cfr/text/45/164.504)).
- **Litigation.**
  - Privileged material produced by mistake must be returned, sequestered or destroyed ([FRCP 26(b)(5)(B)](https://www.law.cornell.edu/rules/frcp/rule_26)).
  - Protective orders, NDAs and data agreements often require return or destruction at the end of a matter†.
- **Anti-money-laundering records.**
  - UK: kept five years after the relationship ends, then the personal data must be deleted ([MLR 2017 reg. 40](https://www.legislation.gov.uk/uksi/2017/692/regulation/40)).
  - EU: similar ([AMLD Art. 40](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32015L0849)).
- **Legal ethics.**
  - Lawyers must make reasonable efforts to prevent unauthorised access to client information (Model Rule 1.6(c)) and supervise vendors (Rule 5.3)†.
  - ABA Formal Opinion 512 (July 2024) on generative AI expects lawyers to know who can access what they enter into a tool. It also requires informed client consent before client information goes into a tool that learns from it†. ([Op. 512](https://www.americanbar.org/content/dam/aba/administrative/professional_responsibility/ethics-opinions/aba-formal-opinion-512.pdf))
  - Opinion 477R notes that "delete" usually does not mean permanently deleted†.

### Rules that forbid or delay deletion

- **The duty to preserve.**
  - Once litigation is reasonably anticipated, relevant material must be kept.
  - Losing electronic information through a failure to take reasonable steps brings court measures. Destruction meant to deprive the other side can bring an adverse inference or default judgment ([FRCP 37(e)](https://www.law.cornell.edu/rules/frcp/rule_37)).
  - Destroying records to obstruct a federal matter is a crime ([18 U.S.C. 1519](https://www.law.cornell.edu/uscode/text/18/1519)).
  - The privacy laws above carve this out: GDPR Art. 17(3)(e) for legal claims, CCPA § 1798.145 for legal claims, MLR reg. 40 for proceedings.
- **AI chats are evidence.**
  - In *NYT v. OpenAI* (S.D.N.Y. 2025), the court ordered OpenAI to preserve output logs, including chats users had deleted. In January 2026 it ordered production of a sample of 20 million de-identified logs†.
  - In 2026 one court ordered an expert's AI prompts produced, though the order was stayed pending objection (*CLF v. Shell*, D. Conn.)†.
  - Another court held that a defendant's own consumer AI chats were not privileged (*United States v. Heppner*, S.D.N.Y.)†.
  - A hold must therefore be able to keep chats a person has deleted.
- **Law firm records.**
  - Trust-account and client-property records must be kept for years: five under the ABA Model Rule 1.15† and in California†, six in Florida†, seven in New York† and Illinois†.
  - No US jurisdiction or the SRA sets a fixed period for general client files†. Guidance is not to destroy them prematurely or carelessly (ABA Informal Op. 1384†), and in England and Wales, commonly six years after a matter closes, tied to limitation periods†.
  - Disposal under a reasonable policy, absent a hold or mandate, is defensible ([Sedona Conference, Defensible Disposition](https://thesedonaconference.org/publication/Commentary_on_Defensible_Disposition)†).
- **Regulated clients.**
  - US broker-dealers keep business communications three years, in a non-erasable format or with an audit trail of every change and deletion ([SEC 17a-4](https://www.law.cornell.edu/cfr/text/17/240.17a-4)).
  - Investment advisers: five years ([SEC 204-2](https://www.law.cornell.edu/cfr/text/17/275.204-2)).
  - FINRA members: six years by default ([FINRA 4511](https://www.finra.org/rules-guidance/rulebooks/finra-rules/4511)).
  - CFTC registrants: five years, including metadata on how records changed ([CFTC 1.31](https://www.law.cornell.edu/cfr/text/17/1.31)).
  - Auditors' workpapers: seven years ([17 CFR 210.2-06](https://www.law.cornell.edu/cfr/text/17/210.2-06)).
  - HIPAA security documentation: six years ([45 CFR 164.316](https://www.law.cornell.edu/cfr/text/45/164.316)).
  - Employment-tax records: four years ([26 CFR 31.6001-1](https://www.law.cornell.edu/cfr/text/26/31.6001-1)).
  - Personnel records: one year, or until a charge is resolved ([29 CFR 1602.14](https://www.law.cornell.edu/cfr/text/29/1602.14)).
- **AI system logs.**
  - Under the EU AI Act, providers and deployers of *high-risk* AI systems must keep automatic logs for at least six months ([Art. 12](https://artificialintelligenceact.eu/article/12/), [Art. 19](https://artificialintelligenceact.eu/article/19/), [Art. 26](https://artificialintelligenceact.eu/article/26/)).
  - A legal assistant sold to firms is not named as high-risk. Use by or for a court, or in alternative dispute resolution, would bring it in ([Annex III point 8](https://artificialintelligenceact.eu/annex/3/)). Those obligations were reportedly postponed to December 2027†.

### What follows for the product

| Situation | Leans toward |
|---|---|
| A person exercises a privacy right, no exception applies | Real erasure, backups included, within a month |
| A matter or contract ends under a protective order, NDA, data agreement or HIPAA agreement | Return or destroy, on the agreed date |
| Litigation or an investigation is reasonably anticipated | Keep everything relevant, including chats people delete |
| Trust-account and client-property records | Keep for the state's period, then dispose |
| A broker-dealer, adviser, CFTC or audit client | Keep for the regulator's period, unaltered or with a full change trail |
| Anti-money-laundering records | Keep five years, then delete |
| None of the above | Keep only as long as needed, then dispose under the written policy |

The product therefore needs four things: per-customer retention settings,
holds that override deletion, erasure that really erases when it runs, and
a record of what happened that holds no content.

## Proposed policy

1. **Delete hides at once, erasure follows.** Deleting a chat removes it from
   the app immediately. Every copy, including the model's store, is erased
   after a grace period (for example 30 days), unless something below stops
   it.
2. **A hold always wins.** An administrator can place a legal hold on an
   organization, project, chat or person. Held content is never erased, even
   if a person deletes it, and the grace period does not run out while the
   hold stands. The person deleting is told that the content is retained.
3. **Settings per deployment and per organization.** The deployment sets a
   default, and each organization can override it with one of:
   - erase after the grace period;
   - erase at once;
   - keep for a set period;
   - keep unaltered, with every change and deletion recorded, for regulated clients.

   A hold or a longer retention wins over an erasure.
4. **Erasure means erased.** When content is erased, it leaves the database,
   its change history, the model's store and derived copies. Backups expire
   on a stated schedule and deletions are re-applied after any restore, or
   per-chat keys are destroyed if counsel accepts that as erasure.
5. **A record that something was deleted.** Each deletion leaves a record
   without content: what was deleted, by whom, when, and when its content was
   erased. The audit log keeps ids, times, model and cost, and drops chat
   titles and email addresses once the content is gone.
6. **Every copy on one clock.** Citation snapshots, workstation files, exports
   and backups each get a stated retention period that matches the policy, so
   no copy outlives it by accident.
7. **Return before destroy.** Before erasing at the end of a matter or
   contract, the firm can export what it must hand back, as a signed
   manifest (see [tamper-evident exports](tamper-evident-exports.md)).
8. **Truthful wording.** The app says what deleting does under the policy
   that applies, instead of "permanently delete".

## Questions for legal review

1. What should "delete" mean by default: erase after a grace period (how
   long), erase at once, or keep until an administrator acts? Should it differ
   between a person's own chats and a firm's chats?
2. Who may place and lift a legal hold, and what should a person see when a
   hold stops their deletion?
3. Is the firm the controller and Mike's operator its processor, so that the
   firm's instructions govern erasure requests? What should the data
   agreement say about end-of-service return and deletion?
4. If one person branches another person's chat, may the branch keep the
   shared earlier part after the original is deleted?
5. What should the audit log keep after a deletion, and for how long? Does it
   need to be tamper-evident, or unalterable for regulated clients?
6. Is keeping deleted data in backups until they expire acceptable, for how
   long, and would destroying per-chat keys count as erasure?
7. How do bar rules on client files and trust records, and the duty to
   preserve, constrain the defaults for law-firm customers?
8. Do any intended customers need SEC, FINRA or CFTC-grade retention, HIPAA
   terms, or EU AI Act logging?
9. How should workstation files, which belong to a person rather than a
   chat, be retained and erased?
10. What should clients be told, under ABA Opinion 512, about what Mike
    keeps, for how long, and who can see it?

## Plan once decided

| Phase | Work | Size |
|---|---|---|
| 0 | Make the deletion wording and docs truthful | Small |
| 1 | Erase the records Mike keeps about a chat while the server runs, including Word and tabular chats | Small to medium |
| 2 | Deletion records, policy settings and holds in the database, with no erasure yet | Medium |
| 3 | Real erasure of the model's store: a live delete in Pi upstream, or a maintenance step at startup | Medium to large |
| 4 | Policy and hold settings in the app; snapshots, documents, workstation files and backups on the same clock | Medium to large |
| 5 | Unalterable retention mode for regulated clients; per-chat keys if backups must be erased at once | Large |
