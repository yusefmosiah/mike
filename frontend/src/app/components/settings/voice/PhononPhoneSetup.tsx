"use client";

import { useState } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { SettingsDescription } from "@/app/components/settings/SettingsText";
import {
  installPhonon,
  removePhonon,
  type PhononStatus,
} from "@/app/lib/voice/deviceSpeech";

/** What the download is, said before it starts. */
const PHONON_DOWNLOAD_SIZE = "about 160 MB";
const PHONON_DISK_SIZE = "about twice that once the phone has prepared it";

/**
 * Phonon on the phone: its model is not in the app. The person downloads it
 * here (nothing is fetched before), can watch the progress, and can remove it
 * again to free the space. Until it is on the phone, Apple's voices read.
 */
export function PhononPhoneSetup({
  status,
  chosen,
  onChange,
}: {
  status: PhononStatus;
  /** Phonon is the chosen voice model (so it reads once downloaded). */
  chosen: boolean;
  /** Called when the download or the removal ends, to read the status again. */
  onChange: () => void;
}) {
  const [progress, setProgress] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const downloading = progress !== null || status.state === "installing";
  const fraction = progress ?? status.progress ?? 0;
  // The last step of an install: Core ML prepares the models for this phone.
  const preparing = status.state === "installing" && !!status.compiling;

  const download = async () => {
    setFailed(null);
    setProgress(0);
    try {
      await installPhonon(setProgress);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "The download did not finish.");
    }
    setProgress(null);
    onChange();
  };

  const remove = async () => {
    setFailed(null);
    setRemoving(true);
    try {
      await removePhonon();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : "Could not remove Phonon. Please try again.");
    }
    setRemoving(false);
    onChange();
  };

  if (status.state === "available") {
    return (
      <div className="space-y-2">
        <SettingsDescription>
          {chosen
            ? "The text never leaves this iPhone."
            : "Phonon is on this iPhone. Choose it above to read English with it."}
          {status.compiling ? " The next reading prepares it for this phone first (about ten seconds)." : ""}
        </SettingsDescription>
        <PillButtonUI tone="white" size="sm" loading={removing} onClick={() => void remove()}>
          Remove Phonon
        </PillButtonUI>
        {failed && (
          <p className="text-sm text-red-600" role="alert">
            {failed}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <SettingsDescription>
        Phonon is not on this iPhone yet. Download it once ({PHONON_DOWNLOAD_SIZE}; {PHONON_DISK_SIZE}) to read English
        with it. Until then Apple&apos;s voices read. Only the model is downloaded; no text is sent.
      </SettingsDescription>
      {downloading ? (
        <div className="space-y-1">
          <p className="text-sm text-gray-700">{preparing ? "Preparing for this phone…" : "Downloading Phonon…"}</p>
          <div
            role="progressbar"
            aria-label={preparing ? "Preparing Phonon for this phone" : "Downloading Phonon"}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={preparing ? undefined : Math.round(fraction * 100)}
            className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
          >
            <div
              className={`h-full rounded-full bg-gray-700 ${preparing ? "w-full animate-pulse" : "transition-[width]"}`}
              style={preparing ? undefined : { width: `${Math.round(fraction * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <PillButtonUI tone="black" size="sm" onClick={() => void download()}>
          Download Phonon
        </PillButtonUI>
      )}
      {failed && (
        <p className="text-sm text-red-600" role="alert">
          {failed}
        </p>
      )}
    </div>
  );
}
