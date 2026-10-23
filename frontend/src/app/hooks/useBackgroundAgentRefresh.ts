"use client";

import { useEffect, useRef } from "react";
import type { ChatDetailOut, Message } from "@/app/components/shared/types";
import { loadAssistantChat } from "@/app/lib/assistantTurns";

export const BACKGROUND_AGENT_POLL_MS = 15_000;

function tabVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

/** Whether the server holds a message row the transcript on screen lacks. */
function hasNewRows(stored: Message[], shown: Message[]): boolean {
  const shownIds = new Set(shown.map((message) => message.id).filter(Boolean));
  return stored.some((message) => !!message.id && !shownIds.has(message.id));
}

/** Each background subagent's card on a transcript: where it stands, by child. */
function backgroundCards(messages: Message[]): Map<string, string> {
  const cards = new Map<string, string>();
  for (const message of messages) {
    for (const event of message.events ?? []) {
      if (event.type !== "subagent" || !event.background) continue;
      cards.set(event.child_id, JSON.stringify([event.status, event.usage ?? null, event.report_preview ?? null]));
    }
  }
  return cards;
}

/**
 * Whether the server holds what happened in the chat on its own: a row the
 * page lacks (a report and its answer), or a background subagent that has
 * moved on since its card was shown (finished, stopped, working again).
 */
function hasNews(stored: Message[], shown: Message[]): boolean {
  if (hasNewRows(stored, shown)) return true;
  const now = backgroundCards(stored);
  for (const [childId, card] of backgroundCards(shown)) {
    if (now.has(childId) && now.get(childId) !== card) return true;
  }
  return false;
}

/**
 * Notices, without a reload, what the server did in an open chat on its own.
 *
 * With background subagents on, a report can reach an idle chat and the server
 * starts a turn to answer it. A reloading page finds that turn through
 * `GET /chat/:id` (`loadAssistantChat` reads the chat and attaches to the run
 * the server reports as active). This hook makes the same read while the
 * chat is open: when the tab becomes visible or the window regains focus, and
 * every `intervalMs` while the tab stays visible. `onRefreshed` receives the
 * read when the server holds rows the page lacks (the report), or when a
 * background subagent's card has moved on (`GET /chat/:id` shows each where it
 * stands now); the live run is already attached by then, so the page lays it
 * over the transcript it sets.
 *
 * It does nothing, and holds no timer, while disabled, hidden or streaming.
 */
export function useBackgroundAgentRefresh({
  chatId,
  enabled,
  idle,
  messages,
  onRefreshed,
  intervalMs = BACKGROUND_AGENT_POLL_MS,
}: {
  chatId: string | null | undefined;
  /** The user's background-subagents setting, and a chat that has loaded. */
  enabled: boolean;
  /** No answer is streaming here. */
  idle: boolean;
  /** The transcript on screen. */
  messages: Message[];
  onRefreshed: (detail: ChatDetailOut) => void;
  intervalMs?: number;
}) {
  const shown = useRef(messages);
  const refreshed = useRef(onRefreshed);
  const stillIdle = useRef(idle);
  useEffect(() => {
    shown.current = messages;
    refreshed.current = onRefreshed;
    stillIdle.current = idle;
  }, [messages, onRefreshed, idle]);

  useEffect(() => {
    if (!enabled || !idle || !chatId) return;
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      if (inFlight || cancelled || !tabVisible()) return;
      inFlight = true;
      try {
        const detail = await loadAssistantChat(chatId);
        // An answer may have started streaming from this page meanwhile; its
        // transcript is then the stream's.
        if (cancelled || !stillIdle.current) return;
        if (hasNews(detail.messages, shown.current)) {
          refreshed.current(detail);
        }
      } catch {
        // A failed read is retried on the next tick.
      } finally {
        inFlight = false;
      }
    };
    const startTimer = () => {
      if (timer === null) timer = setInterval(() => void refresh(), intervalMs);
    };
    const stopTimer = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibilityChange = () => {
      if (tabVisible()) {
        startTimer();
        void refresh();
      } else {
        stopTimer();
      }
    };
    const onFocus = () => void refresh();

    if (tabVisible()) startTimer();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      stopTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, idle, chatId, intervalMs]);
}
