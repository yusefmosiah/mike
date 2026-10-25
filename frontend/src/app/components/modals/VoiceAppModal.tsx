"use client";

import { ModalUI } from "@/shared/ui/ModalUI";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { pillButtonUIClassName } from "@/shared/ui/PillButtonUI.styles";

interface VoiceAppModalProps {
  open: boolean;
  /** Where to get the app; the app action is left out without it. */
  appUrl: string | null;
  onClose: () => void;
  /** Continue into voice mode in this browser. */
  onUseBrowser: () => void;
}

/** Shown on a phone browser's first tap of the voice button: voice mode works best in the app. */
export function VoiceAppModal({ open, appUrl, onClose, onUseBrowser }: VoiceAppModalProps) {
  return (
    <ModalUI open={open} onClose={onClose} size="sm" breadcrumbs={["Voice mode"]} ariaLabel="Voice mode">
      <div className="space-y-4 pb-5 pt-1">
        <p className="text-sm text-gray-700">
          Voice mode works best in the app. It listens and replies more smoothly there. You can also use it in this browser,
          though it may need to download speech models first.
        </p>
        <div className="flex flex-col gap-2">
          {appUrl && (
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={pillButtonUIClassName({ tone: "black", size: "normal", className: "w-full justify-center" })}
            >
              Get the app
            </a>
          )}
          <PillButtonUI tone={appUrl ? "white" : "black"} size="normal" className="w-full justify-center" onClick={onUseBrowser}>
            Use voice mode in this browser
          </PillButtonUI>
        </div>
      </div>
    </ModalUI>
  );
}
