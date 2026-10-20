"use client";

import { useEffect, useState, type FormEvent } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { SettingsDescription, SettingsLabel } from "@/app/components/settings/SettingsText";
import { SettingsTextInput } from "@/app/components/settings/SettingsTextInput";
import { userFacingApiError } from "@/app/lib/userFacingError";
import {
  MAX_TERM_CHARS,
  MAX_TERM_WORDS,
  MAX_USER_TERMS,
  loadUserVocabulary,
  saveUserVocabulary,
  useUserVocabulary,
} from "@/app/lib/voice/dictationVocabulary";

const LOAD_FAILURE = "Could not load your vocabulary. Please try again.";
const SAVE_FAILURE = "Could not save your vocabulary. Please try again.";

/** Why `term` cannot be added to `terms`, or null. */
function problemWith(term: string, terms: readonly string[]): string | null {
  if (term.length > MAX_TERM_CHARS) return `A term can be at most ${MAX_TERM_CHARS} characters.`;
  if (term.split(" ").length > MAX_TERM_WORDS) return `A term can be at most ${MAX_TERM_WORDS} words.`;
  if (terms.some((existing) => existing.toLowerCase() === term.toLowerCase())) return "That term is already in the list.";
  if (terms.length >= MAX_USER_TERMS) return `The vocabulary can hold at most ${MAX_USER_TERMS} terms.`;
  return null;
}

/** The placeholder shown while the list loads: the same rows as the loaded list. */
export function VocabularySectionSkeleton() {
  return (
    <section className="space-y-3" aria-busy="true">
      <div className="h-5 w-32 animate-pulse rounded bg-gray-100" />
      <div className="h-32 animate-pulse rounded-xl bg-gray-100" />
    </section>
  );
}

/** Settings → Voice → Vocabulary: names and terms dictation should spell exactly. */
export function VocabularySection() {
  const terms = useUserVocabulary();
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadUserVocabulary(true).then(
      () => active && setLoadFailed(false),
      () => active && setLoadFailed(true),
    );
    return () => {
      active = false;
    };
  }, []);

  if (terms === null && !loadFailed) return <VocabularySectionSkeleton />;

  const list = terms ?? [];
  const save = async (next: readonly string[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await saveUserVocabulary(next);
      return true;
    } catch (failure) {
      setError(userFacingApiError(failure, SAVE_FAILURE));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const term = draft.replace(/\s+/g, " ").trim();
    if (!term) return;
    const problem = problemWith(term, list);
    if (problem) {
      setError(problem);
      return;
    }
    if (await save([...list, term])) setDraft("");
  };

  return (
    <section className="space-y-3">
      <SettingsHeading>Vocabulary</SettingsHeading>
      <SettingsCard>
        <SettingsRow layout="stacked">
          <div className="min-w-0 space-y-1">
            <SettingsLabel>Names and terms</SettingsLabel>
            <SettingsDescription>
              Names and terms dictation should spell exactly. Names from the project, chat and documents you are working in
              are added automatically while you dictate.
            </SettingsDescription>
          </div>
          <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => void add(event)}>
            <SettingsTextInput
              aria-label="New vocabulary term"
              aria-invalid={error ? true : undefined}
              className="min-w-0 flex-1 basis-48"
              maxLength={MAX_TERM_CHARS}
              placeholder="A name or term"
              value={draft}
              disabled={saving || loadFailed}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
            <PillButtonUI type="submit" tone="white" size="sm" loading={saving} disabled={!draft.trim() || loadFailed}>
              Add
            </PillButtonUI>
          </form>
          {loadFailed && (
            <p className="text-sm text-red-600" role="alert">
              {LOAD_FAILURE}
            </p>
          )}
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
        </SettingsRow>
        {list.length === 0 ? (
          <SettingsRow>
            <SettingsDescription>
              No terms yet. Add the names of clients, parties and matters that dictation gets wrong.
            </SettingsDescription>
          </SettingsRow>
        ) : (
          <SettingsRow layout="stacked">
            <ul aria-label="Vocabulary" className="divide-y divide-gray-100">
              {list.map((term) => (
                <li key={term} className="flex min-w-0 items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="min-w-0 text-sm text-gray-900 [overflow-wrap:anywhere]">{term}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${term}`}
                    disabled={saving}
                    onClick={() => void save(list.filter((item) => item !== term))}
                    className="shrink-0 rounded text-xs font-medium text-red-600 transition-colors hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 disabled:cursor-not-allowed disabled:text-red-300"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </SettingsRow>
        )}
      </SettingsCard>
    </section>
  );
}
