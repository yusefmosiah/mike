import { type Page } from "@playwright/test";

/**
 * Wait for a fresh sign-in to land in the app. Onboarding (name and practice
 * questions) was removed, so every account goes straight to /assistant; the
 * name is kept for the specs that call it.
 */
export async function completeOnboardingIfRequired(page: Page): Promise<void> {
    await page.waitForURL(/\/assistant/, { timeout: 15_000 });
}
