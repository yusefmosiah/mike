"use client";

import { useState } from "react";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { userFacingApiError } from "@/app/lib/userFacingError";
import type { DarkModePreference } from "@/app/lib/theme";
import {
  SettingsDescription,
  SettingsLabel,
} from "@/app/components/settings/SettingsText";
import { SettingsCard } from "@/app/components/settings/SettingsCard";
import { SettingsHeading } from "@/app/components/settings/SettingsHeading";
import { SettingsRow } from "@/app/components/settings/SettingsRow";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";

type Appearance = "light" | "dark" | "system";

const APPEARANCE_OPTIONS: { value: Appearance; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function toAppearance(preference: DarkModePreference): Appearance {
  if (preference === null) return "system";
  return preference ? "dark" : "light";
}

function toPreference(appearance: Appearance): DarkModePreference {
  if (appearance === "system") return null;
  return appearance === "dark";
}

export default function AppearancePage() {
  const { profile, updateDarkMode } = useUserProfile();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!profile) return null;

  const handleChange = async (appearance: Appearance) => {
    if (saving || appearance === toAppearance(profile.darkMode)) return;
    setSaving(true);
    setError(null);
    try {
      await updateDarkMode(toPreference(appearance));
    } catch (changeError) {
      setError(
        userFacingApiError(
          changeError,
          "Could not update the appearance setting.",
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      <SettingsHeading>Appearance</SettingsHeading>
      <SettingsCard>
        <SettingsRow>
          <div className="min-w-0 space-y-1">
            <SettingsLabel>Theme</SettingsLabel>
            <SettingsDescription>
              System matches your device&apos;s light or dark setting.
            </SettingsDescription>
            {error && (
              <p role="alert" className="text-xs text-red-600">
                {error}
              </p>
            )}
          </div>
          <div role="group" aria-label="Theme" aria-busy={saving}>
            <ModalSegmentedToggle
              value={toAppearance(profile.darkMode)}
              onChange={(value) => void handleChange(value)}
              options={APPEARANCE_OPTIONS}
              disabled={saving}
              className="w-full sm:w-72"
            />
          </div>
        </SettingsRow>
      </SettingsCard>
    </section>
  );
}
