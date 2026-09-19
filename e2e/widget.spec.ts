import { test, expect } from "@playwright/test";

// Exercises the REAL public/widget.js in a real browser, loaded exactly the
// way a host page embeds it — not a stub. See docs/audits/aurum-hardening-
// report.md's "Demo polish" section: concierge-platform's own e2e suite
// stubs this widget out entirely (by design — it never calls this real,
// separately-deployed app), which is exactly why a real bug in this file
// could ship unnoticed. This suite is this repo's own responsibility to
// catch that class of bug directly.

async function loadHostPage(page: import("@playwright/test").Page, baseURL: string) {
  await page.setContent(`<!doctype html><html><body>
    <script src="${baseURL}/widget.js" data-api-base="${baseURL}" data-venue-name="Salt &amp; Vine"></script>
  </body></html>`);
  // widget.js is loaded via a relative-to-nothing setContent() page, so its
  // own network requests need a real base URL to resolve against.
  await page.waitForFunction(() => document.getElementById("nightsrfr-widget-host") !== null);
}

test("pressing Enter in the widget's message input sends the message", async ({ page, baseURL }) => {
  await loadHostPage(page, baseURL!);

  const host = page.locator("#nightsrfr-widget-host");
  await host.locator(".launcher").click();

  const input = host.locator(".textRow input");
  await input.fill("Table for 4 this Saturday");
  await input.press("Enter");

  // send() adds the guest's own message bubble synchronously, before the
  // network round trip to /api/chat even resolves — so this doesn't depend
  // on a real ANTHROPIC_API_KEY or model reply.
  await expect(host.locator(".msg.user")).toHaveText("Table for 4 this Saturday");
  await expect(input).toHaveValue("");
});

test("pressing Enter with an empty input does nothing", async ({ page, baseURL }) => {
  await loadHostPage(page, baseURL!);
  const host = page.locator("#nightsrfr-widget-host");
  await host.locator(".launcher").click();
  const input = host.locator(".textRow input");
  await input.press("Enter");
  await expect(host.locator(".msg.user")).toHaveCount(0);
});

test("clicking Send does the same thing as pressing Enter", async ({ page, baseURL }) => {
  await loadHostPage(page, baseURL!);
  const host = page.locator("#nightsrfr-widget-host");
  await host.locator(".launcher").click();
  const input = host.locator(".textRow input");
  await input.fill("hello");
  await host.locator(".sendBtn").click();
  await expect(host.locator(".msg.user")).toHaveText("hello");
});

test("**bold** renders as real <strong> text, with no literal asterisks, and a link still renders as a button", async ({
  page,
  baseURL,
}) => {
  await loadHostPage(page, baseURL!);
  const host = page.locator("#nightsrfr-widget-host");
  await host.locator(".launcher").click();

  // addMessage()'s formatter (renderWithFormatting -> renderWithLinks) is a
  // closure-local pair, not exposed on window — but it runs identically
  // for a guest's own typed message and a bot reply, so typing this text in
  // and pressing Enter exercises the exact same code path a bot reply
  // would, without needing a real model round trip.
  const input = host.locator(".textRow input");
  await input.fill("Book **Booth B** now: https://example.com/pay/abc123");
  await input.press("Enter");

  const userMsg = host.locator(".msg.user").first();
  await expect(userMsg.locator("strong")).toHaveText("Booth B");
  await expect(userMsg).not.toContainText("**");
  await expect(userMsg.locator("a")).toHaveText("Pay here →");
});

test("data-top-offset keeps the panel's own max-height clear of a host page's fixed header", async ({ page, baseURL }) => {
  await page.setContent(`<!doctype html><html><body>
    <script src="${baseURL}/widget.js" data-api-base="${baseURL}" data-venue-name="Salt &amp; Vine" data-top-offset="96"></script>
  </body></html>`);
  await page.waitForFunction(() => document.getElementById("nightsrfr-widget-host") !== null);

  const host = page.locator("#nightsrfr-widget-host");
  await host.locator(".launcher").click();

  const maxHeight = await page.evaluate(() => {
    var host = document.getElementById("nightsrfr-widget-host")!;
    var panel = host.shadowRoot!.querySelector(".panel") as HTMLElement;
    return parseFloat(getComputedStyle(panel).maxHeight);
  });
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  // max-height: calc(100vh - 96px - 24px) — allow a couple of px of
  // sub-pixel/rounding slack rather than asserting an exact float match.
  expect(maxHeight).toBeGreaterThan(viewportHeight - 96 - 24 - 2);
  expect(maxHeight).toBeLessThan(viewportHeight - 96 - 24 + 2);
});
