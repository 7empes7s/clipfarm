import { expect, test } from "@playwright/test";

// Runs last. With CLIPFARM_FAKES=1 a stand-in plays Gemini: it hands the clip's frame back as the
// "generated" picture, so the picker and the spend card can be used without Google.
test("thumbnail picker and the Google credit card", async ({ page, request }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  const seeded = await request.post("/api/dev/seed-clip");
  expect(seeded.status()).toBe(201);
  const { id } = (await seeded.json()) as { id: number };
  expect((await request.post(`/api/clips/${id}/approve`)).status()).toBe(200);
  await page.goto("/#approved");
  const clip = page.getByTestId("clip").filter({ hasText: "He actually landed the jump" }).first();
  await clip.getByRole("button", { name: "Thumbnail" }).click();
  const sheet = page.getByRole("dialog", { name: "Thumbnail" });
  await expect(sheet.getByRole("button", { name: "Close" })).toBeVisible();
  await expect(sheet.getByText("No thumbnails yet.")).toBeVisible();
  await sheet.getByRole("button", { name: "Make thumbnails" }).click();

  const options = sheet.getByTestId("thumb");
  await expect(options).toHaveCount(2, { timeout: 30_000 });
  await expect(options.first()).toContainText("Option A");
  // The pictures really load, at the cover's size.
  await expect
    .poll(() => options.first().locator("img").evaluate((img: HTMLImageElement) => `${img.naturalWidth}x${img.naturalHeight}`))
    .toBe("1080x1920");
  await options.nth(1).getByRole("button", { name: "Use this one" }).click();
  await expect(options.nth(1).getByRole("button", { name: "In use" })).toBeDisabled();
  await expect(options.first().getByRole("button", { name: "Use this one" })).toBeEnabled();
  await expect(options.nth(1).getByRole("link", { name: "Download for YouTube (1280×720)" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const box = await sheet.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toBeHidden();

  // The two pictures were counted against the credit.
  await page.goto("/#dashboard");
  const card = page.getByTestId("google");
  await expect(card.getByRole("heading", { name: "Google credit" })).toBeVisible();
  await expect(card.getByTestId("google-spent")).toContainText("of €269.00 used");
  await expect(card.getByTestId("google-spent")).not.toContainText("€0.00 of");
  await card.getByLabel("Daily limit in euros").fill("1.5");
  await card.getByRole("button", { name: "Save limits" }).click();
  await expect(card.getByText(/Today €\d+\.\d\d of €1\.50\./)).toBeVisible();
  await card.getByLabel("Daily limit in euros").fill("3");
  await card.getByRole("button", { name: "Save limits" }).click();
  await expect(card.getByText(/of €3\.00\./)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(consoleErrors).toEqual([]);
});
