"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    adoptChatQueue,
    clearChatQueue,
    EMPTY_CHAT_QUEUE,
    newChatQueueEntry,
    readChatQueue,
    writeChatQueue,
    type ChatQueueDraft,
    type ChatQueueEntry,
    type ChatQueuePause,
    type ChatQueuePauseReason,
    type ChatQueueState,
} from "@/app/lib/chatQueue";

/**
 * How long the queue waits after a turn ends before sending the next entry.
 * The host clears its own turn-admission gate just after `isStreaming` flips;
 * sending in the same tick raced that close and was refused.
 */
const DRAIN_SETTLE_MS = 350;

export interface UseChatQueueOptions {
    /** The normal send path — the same one typing and Send uses. */
    send: (entry: ChatQueueEntry) => void | Promise<unknown>;
    /**
     * A turn holds the thread: the reader's own response, or a colleague's in
     * a shared chat. The queue waits while this is true.
     */
    isStreaming: boolean;
}

export interface ChatQueueController {
    entries: ChatQueueEntry[];
    paused: ChatQueuePause | null;
    enqueue: (draft: ChatQueueDraft) => void;
    remove: (id: string) => void;
    reorder: (id: string, direction: -1 | 1) => void;
    clear: () => void;
    pause: (reason: ChatQueuePauseReason) => void;
    resume: () => void;
}

/**
 * Per-chat message queue: entries persist on every change and drain one at a
 * time, each as its own turn, only while no turn is running and the queue is
 * not paused for review. A paused queue never drains on its own.
 */
export function useChatQueue(
    chatKey: string,
    { send, isStreaming }: UseChatQueueOptions,
): ChatQueueController {
    const [state, setState] = useState<ChatQueueState>(() =>
        readChatQueue(chatKey),
    );
    const stateRef = useRef(state);
    stateRef.current = state;
    const streamRef = useRef(isStreaming);
    streamRef.current = isStreaming;
    const sendRef = useRef(send);
    sendRef.current = send;
    const keyRef = useRef(chatKey);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const sendingRef = useRef(false);
    const drainRef = useRef<() => Promise<void>>(async () => undefined);

    const commit = useCallback((next: ChatQueueState) => {
        stateRef.current = next;
        writeChatQueue(keyRef.current, next);
        setState(next);
    }, []);

    const cancelDrain = useCallback(() => {
        if (timerRef.current === null) return;
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }, []);

    const scheduleDrain = useCallback(() => {
        if (timerRef.current !== null || sendingRef.current) return;
        const current = stateRef.current;
        if (
            current.paused ||
            current.entries.length === 0 ||
            streamRef.current
        ) {
            return;
        }
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            void drainRef.current();
        }, DRAIN_SETTLE_MS);
    }, []);

    const drain = useCallback(async () => {
        if (sendingRef.current || streamRef.current) return;
        const current = stateRef.current;
        if (current.paused || current.entries.length === 0) return;

        // Remove before handing over: a reload must not resend a turn that
        // was already admitted. A refusal restores it below.
        const [entry, ...rest] = current.entries;
        commit({ ...current, entries: rest });
        sendingRef.current = true;
        try {
            await sendRef.current(entry);
        } catch (error) {
            const latest = stateRef.current;
            const restore = !(
                error &&
                typeof error === "object" &&
                "restoreQueueEntry" in error &&
                error.restoreQueueEntry === false
            );
            commit({
                entries: restore
                    ? [
                          entry,
                          ...latest.entries.filter(
                              (item) => item.id !== entry.id,
                          ),
                      ]
                    : latest.entries,
                paused: { reason: "failed", at: Date.now() },
            });
            return;
        } finally {
            sendingRef.current = false;
        }
        // A reply turn makes `isStreaming` true and its end reschedules this;
        // a note (/nr) leaves it false, so schedule the next entry here.
        scheduleDrain();
    }, [commit, scheduleDrain]);

    drainRef.current = drain;

    // A new chat adopts its id while the first answer streams: carry the
    // queue the messages were written against onto that id. Any other key
    // change is a different chat and loads its own queue.
    useEffect(() => {
        if (keyRef.current === chatKey) return;
        const fromKey = keyRef.current;
        keyRef.current = chatKey;
        cancelDrain();
        // Adoption is unconditional now: the stream the id waited on can
        // end before the key lands, and an orphaned new-chat queue that
        // stayed drainable would auto-send into the next fresh chat.
        const adopted = fromKey.endsWith(`:${encodeURIComponent("new-chat")}`);
        let next: ChatQueueState;
        if (adopted) {
            const inMemory = stateRef.current;
            const existingTo = readChatQueue(chatKey);
            if (
                inMemory.entries.length > 0 &&
                existingTo.entries.length === 0
            ) {
                writeChatQueue(chatKey, inMemory);
                clearChatQueue(fromKey);
                next = inMemory;
            } else {
                next = adoptChatQueue(fromKey, chatKey);
            }
        } else {
            next = readChatQueue(chatKey);
        }
        stateRef.current = next;
        setState(next);
        scheduleDrain();
    }, [chatKey, cancelDrain, scheduleDrain]);

    // A queue still parked under a new-chat key with no live stream is an
    // orphan: the chat it was written for either never got an id, or the
    // adoption above happened before this mount saw it. Left drainable it
    // would auto-send into the next new conversation the user opens.
    useEffect(() => {
        if (!chatKey.endsWith(`:${encodeURIComponent("new-chat")}`)) return;
        if (streamRef.current) return;
        const current = stateRef.current;
        if (current.entries.length === 0 || current.paused) return;
        commit({
            ...current,
            paused: { reason: "orphaned", at: Date.now() },
        });
    }, [chatKey, commit]);

    useEffect(() => {
        if (isStreaming) {
            cancelDrain();
            return;
        }
        scheduleDrain();
    }, [isStreaming, cancelDrain, scheduleDrain]);

    useEffect(() => cancelDrain, [cancelDrain]);

    const enqueue = useCallback(
        (draft: ChatQueueDraft) => {
            const current = stateRef.current;
            commit({
                entries: [...current.entries, newChatQueueEntry(draft)],
                paused: current.paused,
            });
            scheduleDrain();
        },
        [commit, scheduleDrain],
    );

    const remove = useCallback(
        (id: string) => {
            const current = stateRef.current;
            const entries = current.entries.filter((entry) => entry.id !== id);
            commit({
                entries,
                paused: entries.length > 0 ? current.paused : null,
            });
        },
        [commit],
    );

    const reorder = useCallback(
        (id: string, direction: -1 | 1) => {
            const current = stateRef.current;
            const index = current.entries.findIndex((entry) => entry.id === id);
            const target = index + direction;
            if (index < 0 || target < 0 || target >= current.entries.length) {
                return;
            }
            const entries = [...current.entries];
            const [moved] = entries.splice(index, 1);
            entries.splice(target, 0, moved);
            commit({ ...current, entries });
        },
        [commit],
    );

    const clear = useCallback(() => {
        cancelDrain();
        commit(EMPTY_CHAT_QUEUE);
    }, [cancelDrain, commit]);

    const pause = useCallback(
        (reason: ChatQueuePauseReason) => {
            const current = stateRef.current;
            if (current.entries.length === 0) return;
            if (current.paused?.reason === reason) return;
            cancelDrain();
            commit({ ...current, paused: { reason, at: Date.now() } });
        },
        [cancelDrain, commit],
    );

    const resume = useCallback(() => {
        const current = stateRef.current;
        if (!current.paused) return;
        commit({ ...current, paused: null });
        scheduleDrain();
    }, [commit, scheduleDrain]);
    return {
        entries: state.entries,
        paused: state.paused,
        enqueue,
        remove,
        reorder,
        clear,
        pause,
        resume,
    };
}
