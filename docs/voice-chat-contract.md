# Voice chat: contract between the parts

Companion to `docs/voice-chat.md` (the design). This file fixes the
interfaces so the native voice engine, the web app and the server can be built
in parallel. Change it only together with every side that uses it.

## Native voice engine ⇄ web app (`MikeSpeech` plugin)

All methods return promises. Errors reject with the existing plugin codes
(`permission-denied`, `unavailable`, `failed`), plus `busy` (`voiceRemove`,
read-aloud `speak` and Phonon `remove` while voice mode runs) and `cancelled`
(`voiceStart` when a `voiceStop` arrives before the start finishes). Every event arrives on one
listener, `voiceEvent`, with a `type` field.

### Methods

| Method | Arguments | Resolves |
|---|---|---|
| `voiceStatus` | — | `{ available: boolean, missing: string[], downloadBytes: number, speakerLearned: boolean }`. `available` means every model voice mode needs is installed and this device can run it; `missing` names the models still to download (`"vad"`, `"eou"`, `"smart-turn"`, `"speaker"`, `"speaker-campplus"`, `"phonon"`, `"fluid-mini"`); `downloadBytes` is their total size; `speakerLearned` means the person's voice has been learned and other voices are ignored. |
| `voiceInstall` | — | `{ available }` once the missing models are downloaded and compiled. Progress arrives as `voiceEvent` `{ type: "install", fraction }`. |
| `voiceRemove` | — | The `voiceStatus` payload, after deleting the VAD, EOU, Smart Turn and both speaker models and the learned voice, and cancelling an install in progress. Phonon keeps its own `remove`. Rejects with `busy` while voice mode runs. |
| `voiceForgetSpeaker` | — | The `voiceStatus` payload, after forgetting the learned voice; it is learned again from the next turns. Works while voice mode runs. |
| `voiceMicrophoneModes` | — | Once the system's microphone modes (Voice Isolation, Wide Spectrum) are shown. iOS lists them only while the app holds the microphone, so the web app offers this during voice mode. |
| `voiceStart` | `{ config: VoiceConfig, voice?: string }` | When the engine is listening. Asks for the microphone if needed. Loads and warms every model. |
| `voiceStop` | — | When audio is released. Ends any answer being spoken. |
| `voiceSpeak` | `{ turnId, clauseId, text, final? }` | At once (queued). `text` is already speakable (the web app normalises it). Ignored if `turnId` is not the current answer's turn. `clauseId` is a non-negative integer, increasing within a turn. `final` marks the answer's last clause and is informational: the answer ends only on `voiceEndAnswer`. |
| `voiceEndAnswer` | `{ turnId }` | At once. No more clauses for this turn; after the last one plays the engine returns to listening and sends `answerFinished`. |
| `voiceCancelAnswer` | `{ turnId }` | When playback has stopped. Drops queued clauses; the engine returns to listening. Sends `interrupted` if anything had started playing. |

`VoiceConfig` (every field optional; the engine has these defaults):

```ts
interface VoiceConfig {
  vadThreshold: number;        // 0.5  speech probability
  pauseMs: number;             // 500  silence that opens the end-of-turn check
  smartTurnThreshold: number;  // 0.6  at or above: the turn is complete (below: asked again every 750 ms of silence)
  maxSilenceMs: number;        // 3000 the turn ends whatever the models say
  continueMs: number;          // 3000 speech resumed this soon after a turn continues it (`turn.continues`); 0 is off
  bargeInSpeechMs: number;     // 300  VAD speech needed for a barge-in
  holdSpeechMs: number;        // 700  VAD speech needed to hold playback before words arrive
  bargeInVadThreshold: number; // 0.7  speech probability needed to start while the answer is awaited or playing
  bargeInWords: number;        // 2    words not in the clause being played
  falseStartMs: number;        // 1500 speech without words: resume playback
  maxTurnMs: number;           // 60000 a single turn is cut here (at most 120000; larger falls back to the default)
  speakerModel: "wespeaker" | "campplus" | "both" | "off"; // "wespeaker" decides whether speech is the person's ("both" decides in the two models' joined space; "off" checks and learns nothing)
  speakerThreshold: number;    // 0.35 below this WeSpeaker score against the learned voice, speech is another voice
  campplusThreshold: number;   // 0.39 the same for CAM++
}
```

### Events (`voiceEvent`)

```ts
type VoiceEvent =
  | { type: "install"; fraction: number }
  | { type: "state"; state: "listening" | "user-speaking" | "confirming-end" | "thinking" | "speaking" }
  | { type: "partial"; text: string }                       // live words, replaced by `turn`
  | { type: "turn"; turnId: string; text: string; audioMs: number; continues?: string } // `continues`: see below
  | { type: "bargeIn"; turnId: string }                     // the person spoke over turn `turnId`'s answer (or while it was thinking)
  | { type: "clauseStarted"; turnId: string; clauseId: number }
  | { type: "clausePlayed"; turnId: string; clauseId: number }
  | { type: "interrupted"; turnId: string; clauseId: number; fraction: number } // fraction of that clause's samples played, 0..1
  | { type: "answerFinished"; turnId: string }
  | { type: "ended"; reason: "stopped" | "interruption" | "route" | "error" } // going to the background is "interruption"
  | { type: "ignored"; reason: "other-voice" }              // a finished turn was in another voice and not sent
  | { type: "metrics"; turnId: string; stages: Record<string, number> }; // milliseconds
```

- The engine creates `turnId` when it commits a person's turn (`turn`), and
  the answer to that turn uses the same id. The text in `turn` is Fluid Speech
  Mini's final pass (vocabulary is applied by the web app).
- After `turn` the engine is `thinking` until the first `voiceSpeak` for that
  turn starts playing (`speaking`).
- `continues` names the turn sent just before, when the person went on
  speaking within a few seconds of it being committed (the end of the turn
  was a mistake). The engine transcribes the two stretches together, so
  `text` is the whole prompt, that turn's words and the new ones; it has
  already sent `bargeIn` for that turn's answer. The web app replaces that
  turn's prompt rather than adding another: words not yet sent are swapped,
  and a sent prompt gets a new version (a branch) answered in its place. The
  old prompt and its cut-off answer stay as the older branch. When it cannot
  replace it (the prompt has no stored id yet, or the surface has no
  branching), it sends `text` as a new message. A `continues` that names no
  turn it knows is ignored.
- A barge-in while `thinking` sends `bargeIn` only; while `speaking` it sends
  `bargeIn`, then `interrupted` for the clause that was playing. Either way the
  web app cancels that turn's chat answer and the engine keeps listening (the
  person's new words become the next `turn`).
- Once the person's voice is learned, speech in another voice neither barges
  in nor becomes a `turn`: its `partial`s may have been sent, then `ignored`
  follows and the engine is `listening` again. A web build that does not know
  `ignored` drops it.
- `interrupted.fraction` is by samples. The web app maps it to words.
- `metrics` stages: `endOfSpeechToCommit`, `finalPass`, `commitToFirstAudio`
  (measured from `turn` to the first sample of clause 0), `micDroppedMs`
  (microphone audio dropped because listening fell behind), `speakerCheck`
  (the voice check of the turn), plus anything else useful.

## Web app ⇄ server

- The chat-turn request body (`POST /chat` and `POST /projects/:projectId/chat`)
  gains `voice?: boolean`. When true the server adds the voice prompt section
  to that turn's context (a per-turn section, so the system prompt and its
  cache stay the same for the whole chat) (short spoken
  answers, no markdown, one question at a time, sources named in words, details
  left on screen).
- `PUT /chat/:chatId/messages/:messageId/spoken` with `{ spokenText: string }`
  records that an assistant answer was interrupted and what the person heard
  (204). Same access rule as cancelling that turn. The web app calls it via
  `recordSpokenAnswer(chatId, messageId, spokenText)` in `mikeApi.ts`.
- When the server builds the model's history, an interrupted assistant
  message is replayed as its spoken text followed by a marker that the person
  interrupted there, not as the full text. The full text stays stored and shown.
