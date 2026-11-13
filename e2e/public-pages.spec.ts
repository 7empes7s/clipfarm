import { expect, test } from "@playwright/test";

// The pages Google reads before it lets the app ask for YouTube access: no sign-in, no script.
for (const [path, heading] of [
  ["/home", "TechInsiderBytes"],
  ["/privacy", "Privacy Policy"],
  ["/terms", "Terms of Use"],
] as const) {
  test(`${path} is a readable page that fits the screen`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page).toHaveTitle(/^TechInsiderBytes/);
    await expect(page.locator("#root")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.context().cookies()).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("the app links to the public pages, and they link to each other", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "Privacy Policy" }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByText("including the Limited Use requirements")).toBeVisible();
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole("link", { name: "YouTube Terms of Service" })).toHaveAttribute("href", "https://www.youtube.com/t/terms");
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(/\/home$/);
});
