import { expect, test } from "@playwright/test";

// Runs last, at 390 px and again on the desktop project. The server runs with CLIPFARM_FAKES=1:
// YouTube, the proxy test and the sign-in page are stand-ins, so nothing leaves the machine.
// The proxy password and app secret below are made up; neither may show up on the page.
const PROXY_PASS = "e2e-proxy-pass-7h3k";
const APP_SECRET = "e2e-burner-app-secret-00q9q9";

test("Settings, Accounts: a burner group gets a proxy, passes its test, gets its own app and connects a channel", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  const width = page.viewportSize()!.width;
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  // Start from a burner group without a proxy, whatever ran before.
  expect((await request.delete("/api/groups/2/proxy")).status()).toBe(200);

  await page.goto("/#settings/accounts");
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
  const main = page.getByTestId("group-1");
  const burners = page.getByTestId("group-2");
  await expect(main.getByText("Ready", { exact: true })).toBeVisible();
  await expect(main.getByTestId("exit")).toContainText("this server's own address");
  await expect(burners.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(burners.getByText("No proxy is set. Burner accounts cannot post until one is added and tested.")).toBeVisible();
  await expect(burners.getByRole("button", { name: "Connect YouTube channel" })).toBeDisabled();
  await fits();

  // Paste the proxy: the sheet has a ×, and the address is never shown back with its password.
  await burners.getByRole("button", { name: "Paste proxy" }).click();
  const proxySheet = page.getByRole("dialog", { name: "Proxy for Burners" });
  await expect(proxySheet.getByRole("button", { name: "Close" })).toBeVisible();
  await fits();
  await proxySheet.getByLabel("Proxy address").fill(`http://clipfarm:${PROXY_PASS}@proxy.example:8080`);
  await proxySheet.getByRole("button", { name: "Save" }).click();
  await expect(proxySheet).toBeHidden();
  await expect(burners.getByTestId("exit")).toContainText("Proxy proxy.example:8080, with a sign-in");
  await expect(burners.getByText("The proxy has not been tested yet. Tap Test.")).toBeVisible();

  // Test: the exit address (masked) and its country, and the group is no longer blocked.
  await burners.getByRole("button", { name: "Test", exact: true }).click();
  await expect(burners.getByTestId("exit")).toContainText("203.0.113.x (NL)");
  await expect(burners.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(PROXY_PASS);
  await expect(page.locator("body")).not.toContainText("203.0.113.7");

  // The group's own YouTube app, then Connect channel: out to the sign-in and back.
  await burners.getByRole("button", { name: /(Paste|Replace) YouTube keys/ }).click();
  const appSheet = page.getByRole("dialog", { name: "YouTube keys for Burners" });
  await expect(appSheet.getByText("/oauth/youtube/callback")).toBeVisible();
  await appSheet.getByLabel("OAuth client ID").fill("burner-youtube-client-e2e9");
  await appSheet.getByLabel("Client secret").fill(APP_SECRET);
  await fits();
  // Nothing in the sheet runs past the screen edge: the fields, Save and the redirect address.
  for (const part of [appSheet.getByLabel("OAuth client ID"), appSheet.getByLabel("Client secret"), appSheet.getByRole("button", { name: "Save" }), appSheet.locator("code")]) {
    const box = (await part.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  await appSheet.getByRole("button", { name: "Save" }).click();
  await expect(appSheet).toBeHidden();
  await expect(burners.getByText("Keys set, ID ends in …e2e9")).toBeVisible();
  await burners.getByRole("button", { name: "Connect YouTube channel" }).click();
  await expect(page.getByTestId("connect-result")).toHaveText("Channel demo is connected to “Burners”.");
  await expect(burners.getByText("Channel demo, YouTube Shorts")).toBeVisible();
  await expect(burners.getByText("Connected here: uploads use this group's app and way out")).toBeVisible();
  await expect(burners.getByTestId("quota")).toContainText("of 10,000 units used today");
  await expect(page.locator("body")).not.toContainText(APP_SECRET);

  // What to paste where: the exact redirect addresses, and what proxy to buy.
  await burners.getByText("What to paste where").click();
  await expect(burners.getByText("Buy one residential or ISP proxy")).toBeVisible();
  await expect(burners.getByText(/\/oauth\/tiktok\/callback$/)).toBeVisible();
  await fits();

  // The setup list on the dashboard knows the burners are kept apart now.
  await page.goto("/#dashboard");
  // A step that is done sits under "The other steps".
  const setup = page.getByTestId("setup");
  await setup.locator("summary").click();
  await expect(setup.getByText("Burners leave from their own address (203.0.113.x) with their own apps.")).toBeVisible();
  await fits();
  expect(errors).toEqual([]);
});
