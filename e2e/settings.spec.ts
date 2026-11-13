import { expect, test } from "@playwright/test";

// The server runs with CLIPFARM_FAKES=1: keys are saved for real (in the throwaway data folder),
// but Test calls nothing outside. The key below is made up.
const SECRET = "e2eclientsecret0000000000q9q9";

test("settings at 390 px: paste a key, see only its ending, test it, remove it", async ({ page }) => {
  await page.goto("/#dashboard");
  const setup = page.getByTestId("setup");
  await expect(setup.getByText("Keys set and tested")).toBeVisible();
  await setup.getByRole("link", { name: "Open Settings" }).click();
  await expect(page.getByRole("heading", { name: "Keys and connections" })).toBeVisible();

  const twitch = page.getByTestId("settings-twitch");
  await expect(twitch.getByText("Not set", { exact: true }).first()).toBeVisible();
  await twitch.getByRole("button", { name: "Paste keys" }).click();
  const sheet = page.getByRole("dialog", { name: "Twitch keys" });
  await sheet.getByLabel("Client ID").fill("e2eclientid00000000000wxyz");
  await sheet.getByLabel("Client Secret").fill(SECRET);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  await expect(twitch.getByText(/Set, ends in …q9q9 \(from Settings, saved /)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SECRET);
  await twitch.getByRole("button", { name: "Test" }).click();
  await expect(twitch.getByText("Working", { exact: true })).toBeVisible();

  // The steps for the other site carry the exact values to type there.
  await twitch.getByText("How to make a Twitch app").click();
  await expect(twitch.getByText("https://clip.techinsiderbytes.com/auth/twitch")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // The sheet has a ×, and Replace never shows the saved key again.
  await twitch.getByRole("button", { name: "Replace" }).click();
  await expect(sheet.getByLabel("Client Secret")).toHaveValue("");
  await sheet.getByRole("button", { name: "Close" }).click();

  await twitch.getByRole("button", { name: "Remove" }).click();
  await twitch.getByRole("button", { name: "Yes, remove" }).click();
  await expect(twitch.getByRole("button", { name: "Paste keys" })).toBeVisible();

  // One tap from the header, from any screen.
  await page.goto("/#inbox");
  await page.getByRole("link", { name: "Settings: keys and connections" }).click();
  await expect(page.getByRole("heading", { name: "Keys and connections" })).toBeVisible();
});

test("OpenAI at 390 px: a saved key is tested at once, and the models are picked from dropdowns", async ({ page }) => {
  const KEY = "sk-proj-e2eOpenAiKey00000000000r7r7";
  await page.goto("/#settings");
  const openai = page.getByTestId("settings-openai");
  // Before any key: the model in use and where it comes from.
  await expect(openai.getByText("gpt-6-luna (the default)")).toBeVisible();
  await expect(openai).not.toContainText("gpt-4o-mini");

  await openai.getByRole("button", { name: "Paste keys" }).click();
  const sheet = page.getByRole("dialog", { name: "OpenAI keys" });
  await sheet.getByLabel("API key").fill(KEY);
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toBeHidden();

  // No tap on Test: the save ran it.
  await expect(openai.getByText("Working", { exact: true })).toBeVisible();
  await expect(openai.getByText(/Set, ends in …r7r7/)).toBeVisible();
  await expect(page.locator("body")).not.toContainText(KEY);

  const picking = openai.getByLabel("Picking model");
  await expect(picking).toHaveValue("gpt-6-luna");
  await expect(picking.locator("option").first()).toHaveText("gpt-6-luna (recommended)");
  await picking.selectOption("demo-large");
  await expect(openai.getByText(/^from Settings, saved /)).toBeVisible();
  await expect(picking).toHaveValue("demo-large");
  await expect(openai.getByText("Working", { exact: true })).toBeVisible();

  await expect(openai.getByLabel("Transcription model")).toHaveValue("gpt-transcribe");
  await expect(openai.getByText(/whisper-1 retires on 26 Feb 2027/)).toBeVisible();
  await openai.getByRole("button", { name: "Test" }).click();
  await expect(openai.getByText("Working", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // Left as it was found for the other specs.
  await openai.getByRole("button", { name: "Remove" }).click();
  await openai.getByRole("button", { name: "Yes, remove" }).click();
  await expect(openai.getByRole("button", { name: "Paste keys" })).toBeVisible();
});
