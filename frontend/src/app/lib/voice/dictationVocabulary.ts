"use client";

/**
 * The vocabulary dictation uses: the person's own terms (kept in their Mike
 * account, so they follow them across devices) and automatic terms, names
 * from the page they are working in. Pages publish the names they already
 * have; nothing is fetched for this. Terms are client names: they are never
 * logged, and a failure to load them is swallowed rather than reported.
 */

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getDictationVocabulary, saveDictationVocabulary } from "@/app/lib/mikeApi";
import { AUTOMATIC_MIN_CHARS, type DictationVocabulary } from "./vocabulary";

export const MAX_USER_TERMS = 500;
export const MAX_TERM_CHARS = 64;
export const MAX_TERM_WORDS = 4;
export const MAX_AUTOMATIC_TERMS = 200;
/** What Apple's recognizer is given (the user's terms first). */
export const MAX_RECOGNIZER_TERMS = 100;

const CACHE_MS = 5 * 60_000;

let userTerms: readonly string[] | null = null;
let loadedAt = 0;
let loading: Promise<readonly string[]> | null = null;
const contextSources = new Map<string, readonly string[]>();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((listener) => listener());
}

const sortTerms = (terms: readonly string[]) =>
    [...terms].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

/** The list as the person sees it: loaded once, kept for a few minutes. */
export function loadUserVocabulary(force = false): Promise<readonly string[]> {
    if (!force && userTerms && Date.now() - loadedAt < CACHE_MS) return Promise.resolve(userTerms);
    if (loading) return loading;
    const request: Promise<readonly string[]> = getDictationVocabulary()
        .then(({ terms }) => {
            userTerms = Array.isArray(terms) ? terms : [];
            loadedAt = Date.now();
            emit();
            return userTerms;
        })
        .finally(() => {
            if (loading === request) loading = null;
        });
    loading = request;
    return request;
}

/** Saves the whole list; the server's cleaned-up copy is what is kept. */
export async function saveUserVocabulary(terms: readonly string[]): Promise<readonly string[]> {
    const saved = await saveDictationVocabulary([...terms]);
    userTerms = saved.terms;
    loadedAt = Date.now();
    emit();
    return userTerms;
}

/** Forgets the loaded list (on sign-out, and in tests). */
export function resetDictationVocabulary(): void {
    userTerms = null;
    loadedAt = 0;
    loading = null;
    contextSources.clear();
    emit();
}

/** The vocabulary to correct and bias a dictation with right now. */
export function currentDictationVocabulary(): DictationVocabulary {
    const own = userTerms ?? [];
    const seen = new Set(own.map((term) => term.toLowerCase()));
    const automatic: string[] = [];
    for (const names of contextSources.values()) {
        for (const name of names) {
            const key = name.toLowerCase();
            if (seen.has(key) || automatic.length >= MAX_AUTOMATIC_TERMS) continue;
            seen.add(key);
            automatic.push(name);
        }
    }
    return { terms: own, automatic };
}

/** Up to 100 terms for Apple's recognizer: the person's first. */
export function recognizerTerms(vocabulary: DictationVocabulary): string[] {
    return [...vocabulary.terms, ...(vocabulary.automatic ?? [])].slice(0, MAX_RECOGNIZER_TERMS);
}

/** Publishes the names of what a page shows; an empty list withdraws them. */
export function setDictationContext(source: string, names: readonly string[]): void {
    if (names.length === 0) {
        if (contextSources.delete(source)) emit();
        return;
    }
    contextSources.set(source, names);
    emit();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

// The snapshot is the list itself (replaced, never mutated) so that a render
// reads what the store holds rather than a remembered value. The server never
// loads a list, so the same getter serves its render too.
const snapshot = () => userTerms;

/** The person's list for Settings: undefined until it has loaded. */
export function useUserVocabulary(): readonly string[] | null {
    const terms = useSyncExternalStore(subscribe, snapshot, snapshot);
    return useMemo(() => (terms === null ? null : sortTerms(terms)), [terms]);
}

/* ---------------------------- automatic terms ---------------------------- */

const SEPARATORS = /\s[-–—]\s|[_|:;,()[\]{}/\\]+/;

/** True for a candidate worth matching: enough letters, 1-4 words. */
function usable(name: string): boolean {
    if (name.length < AUTOMATIC_MIN_CHARS || name.length > MAX_TERM_CHARS) return false;
    if (name.split(" ").length > MAX_TERM_WORDS) return false;
    return (name.match(/\p{L}/gu)?.length ?? 0) >= 4;
}

/** "Smith v Jones - SPA.docx" gives "Smith v Jones" (and "SPA" is too short to keep). */
export function namesFromFilename(filename: string): string[] {
    const stem = filename.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    return stem
        .split(SEPARATORS)
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter(usable);
}

export interface DictationContextInput {
    projectName?: string | null;
    chatTitle?: string | null;
    filenames?: readonly (string | null | undefined)[];
    /** Display names of the people the chat or project is shared with. */
    people?: readonly (string | null | undefined)[];
}

/** Names worth listening for, from what a page already shows. */
export function automaticTermsFrom(input: DictationContextInput): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (raw: string | null | undefined, split: boolean) => {
        if (!raw) return;
        const candidates = split ? namesFromFilename(raw) : [raw.replace(/\s+/g, " ").trim()];
        for (const name of candidates) {
            const key = name.toLowerCase();
            if (!usable(name) || seen.has(key)) continue;
            seen.add(key);
            out.push(name);
        }
    };
    add(input.projectName, false);
    add(input.chatTitle, false);
    for (const filename of input.filenames ?? []) add(filename, true);
    for (const person of input.people ?? []) add(person, false);
    return out.slice(0, MAX_AUTOMATIC_TERMS);
}

/**
 * A page calls this with the names it has; they become automatic terms while
 * it is mounted. `source` keeps two pages from replacing each other's names.
 */
export function useDictationContext(source: string, input: DictationContextInput): void {
    const key = JSON.stringify(automaticTermsFrom(input));
    useEffect(() => {
        setDictationContext(source, JSON.parse(key) as string[]);
        return () => setDictationContext(source, []);
    }, [source, key]);
}
