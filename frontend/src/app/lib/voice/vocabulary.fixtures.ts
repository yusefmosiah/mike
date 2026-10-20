/**
 * Fixtures for the vocabulary matcher: what Fluid Speech Mini wrote for four
 * macOS voices reading sentences with fictional legal names, and ordinary
 * sentences that must come through untouched. Everything here is invented.
 */

export const SPIKE_TERMS = [
    "Okonkwo-Lindqvist",
    "Szczepański Holdings",
    "Ximena Achterberg",
    "Thibodeaux & Nakamura LLP",
    "Vasquez-Oyelaran",
];

/** [what was said, what the engine wrote, voice] */
export const SPIKE_TRANSCRIPTS: readonly (readonly [string, string, string])[] = [
    [
        "The claim against Okonkwo-Lindqvist was filed on Monday.",
        "The claim against a Conquo Lindqvist was filed on Monday.",
        "Daniel"
    ],
    [
        "The claim against Okonkwo-Lindqvist was filed on Monday.",
        "The claim against a Conqua Lindvest was filed on Monday.",
        "Karen"
    ],
    [
        "The claim against Okonkwo-Lindqvist was filed on Monday.",
        "The claim against a Concordist was filed on Monday.",
        "Rishi"
    ],
    [
        "The claim against Okonkwo-Lindqvist was filed on Monday.",
        "The claim against Aconquo Lindquist was filed on Monday.",
        "Samantha"
    ],
    [
        "Please send the draft to Ximena Achterberg before noon.",
        "Please send the draft to Zamina Akterberg before noon.",
        "Daniel"
    ],
    [
        "Please send the draft to Ximena Achterberg before noon.",
        "Please send the draft to Zimina Ratchetberg before noon.",
        "Karen"
    ],
    [
        "Please send the draft to Ximena Achterberg before noon.",
        "Please send the draft to Zeminer Aktaberg before noon.",
        "Rishi"
    ],
    [
        "Please send the draft to Ximena Achterberg before noon.",
        "Please send the draft to Himena Achterberg before noon.",
        "Samantha"
    ],
    [
        "Szczepański Holdings has agreed to the indemnity clause.",
        "Zapansky Holdings has agreed to the indemnity clause.",
        "Daniel"
    ],
    [
        "Szczepański Holdings has agreed to the indemnity clause.",
        "Skzipansky Holdings has agreed to the indemnity clause.",
        "Karen"
    ],
    [
        "Szczepański Holdings has agreed to the indemnity clause.",
        "Zipaski Holdings has agreed to the indemnity clause.",
        "Rishi"
    ],
    [
        "Szczepański Holdings has agreed to the indemnity clause.",
        "Szipansky Holdings has agreed to the indemnity clause.",
        "Samantha"
    ],
    [
        "Thibodeaux & Nakamura LLP will act for the buyer.",
        "Thibado and Nakamura LLP will act for the buyer.",
        "Daniel"
    ],
    [
        "Thibodeaux & Nakamura LLP will act for the buyer.",
        "Thibodokes and Nakamura LLP will act for the buyer.",
        "Karen"
    ],
    [
        "Thibodeaux & Nakamura LLP will act for the buyer.",
        "Thibodok's and Nakamura LLP will act for the buy up.",
        "Rishi"
    ],
    [
        "Thibodeaux & Nakamura LLP will act for the buyer.",
        "Tibetou and Nakamura LLP will act for the buyer.",
        "Samantha"
    ],
    [
        "Counsel for Vasquez-Oyelaran signed the settlement yesterday.",
        "Council for Vasquez-Oyeler and signed the settlement yesterday.",
        "Daniel"
    ],
    [
        "Counsel for Vasquez-Oyelaran signed the settlement yesterday.",
        "Council for Vasquez-Oyelaran signed the settlement yesterday.",
        "Karen"
    ],
    [
        "Counsel for Vasquez-Oyelaran signed the settlement yesterday.",
        "Council for Vasquez-Eloran signed the settlement yesterday.",
        "Rishi"
    ],
    [
        "Counsel for Vasquez-Oyelaran signed the settlement yesterday.",
        "Council for Vasquez Oyoloran signed the settlement yesterday.",
        "Samantha"
    ],
    [
        "We met Ximena Achterberg and Okonkwo-Lindqvist at the offices of Thibodeaux & Nakamura LLP.",
        "We met Zamina Aktaburg and Akonquo Lindqvist at the offices of Thibado and Nakamura LLP.",
        "Daniel"
    ],
    [
        "We met Ximena Achterberg and Okonkwo-Lindqvist at the offices of Thibodeaux & Nakamura LLP.",
        "We met Zimina Rachtaburg and Akonqua Lintvist at the offices of Thibodoks and Nakamura LLP.",
        "Karen"
    ],
    [
        "We met Ximena Achterberg and Okonkwo-Lindqvist at the offices of Thibodeaux & Nakamura LLP.",
        "We met Ziminer Aktaburg and a Conco linkvist at the offices of Thibodoks and Nakamura LLP.",
        "Rishi"
    ],
    [
        "We met Ximena Achterberg and Okonkwo-Lindqvist at the offices of Thibodeaux & Nakamura LLP.",
        "We met Himena Akterberg and Akonquo Lindqvist at the offices of Tibetou and Nakamura LLP.",
        "Samantha"
    ]
];

/** Ordinary sentences: spoken transcripts and typed text, none naming a term. */
export const ORDINARY_SENTENCES: readonly string[] = [
    "The court adjourned the hearing until the following Tuesday.",
    "The court adjourned the hearing until the following Tuesday.",
    "Please review the contract and send your comments by Friday.",
    "Please review the contract and send your comments by Friday.",
    "Our client wishes to terminate the lease at the end of the quarter.",
    "Our client wishes to terminate the lease at the end of the quarter.",
    "The witness stated that she had never seen the document before.",
    "The witness stated that she had never seen the document before.",
    "We will discuss the settlement offer with the board tomorrow morning.",
    "We will discuss the settlement offer with the board tomorrow morning.",
    "Thomas Anderson and Maria Garcia met at the law firm on Main Street.",
    "Thomas Anderson and Maria Garcia met at the law firm on Main Street.",
    "The parties agreed to arbitrate any dispute in London.",
    "The parties agreed to arbitrate any dispute in London.",
    "Nakamura is a common surname in Japan.",
    "Nakamura is a common surname in Japan.",
    "The court adjourned the hearing until the following Tuesday.",
    "Please review the contract and send your comments by Friday.",
    "Our client wishes to terminate the lease at the end of the quarter.",
    "The witness stated that she had never seen the document before.",
    "We will discuss the settlement offer with the board tomorrow morning.",
    "Thomas Anderson and Maria Garcia met at the law firm on Main Street.",
    "The parties agreed to arbitrate any dispute in London.",
    "Nakamura is a common surname in Japan.",
    "Kingsley Holdings has appealed the decision of the lower court.",
    "Alex Berg and Ximena from the finance team will join the call.",
    "The Nakamura case was decided in nineteen ninety.",
    "Okay, let's look at the indemnity and warranties section again.",
    "Thibault Martin from the Paris office sent the signed agreement.",
    "Vasquez filed a motion to dismiss on behalf of the defendant.",
    "Szechuan Palace is the restaurant near the courthouse.",
    "The firm of Thompson and Nicholson LLP represents the seller.",
    "Lindsay Oyelaran from accounting will review the invoice.",
    "Please remind Elena Achterman to sign the engagement letter.",
    "We have a hearing at ten o'clock and a deposition at two.",
    "Oklahoma Lending Corporation has defaulted on the loan.",
    "The holding company transferred the shares to its subsidiary.",
    "Hexagon and Narrow LLP are co-counsel on the matter.",
    "The contract was drafted by a lawyer who specializes in tax.",
    "Schedule a call with the board of directors next week.",
    "The buyer will assume all liabilities arising before closing.",
    "Counsel asked the witness whether she knew the other party."
];
