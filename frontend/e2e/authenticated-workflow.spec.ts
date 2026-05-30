import { expect, test } from "@playwright/test";

test("support agent signs in, creates an incident, and sees its audit event", async ({ page }) => {
  const title = `E2E database latency ${Date.now()}`;

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ResolveIQ" })).toBeVisible();
  await page.getByLabel("Username").fill("e2e-agent");
  await page.getByLabel("Password").fill("e2e-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("Turn customer incidents and application logs into reviewed diagnoses")).toHaveCount(0);
  await page.getByRole("button", { name: "About" }).click();
  await expect(page.getByText("Turn customer incidents and application logs into reviewed diagnoses, response drafts, and resolution records.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Controlled publishing" })).toBeVisible();
  await page.getByRole("button", { name: "Dashboard" }).click();
  await page.getByRole("button", { name: "New case" }).click();
  await page.getByPlaceholder("Case title").fill(title);
  await page.getByPlaceholder("Customer", { exact: true }).fill("Northwind");
  await page.getByPlaceholder("Affected service").fill("Checkout API");
  await page.getByPlaceholder("Customer-reported issue").fill("Checkout requests time out.");
  await page.getByPlaceholder("Paste logs, error messages, request IDs...").fill("ERROR query timeout request=e2e-42");
  await page.getByRole("button", { name: "Create case" }).click();

  await expect(page.getByRole("alertdialog", { name: "Success" })).toContainText("Support case created.");
  await page.getByRole("button", { name: "Close message" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator(".audit")).toContainText("Case Created");
  await expect(page.locator(".audit")).toContainText("e2e-agent");

  await page.getByRole("button", { name: `Delete ${title}` }).click();
  await expect(page.getByRole("alertdialog", { name: "Confirm case delete" })).toContainText(title);
  await page.getByRole("alertdialog", { name: "Confirm case delete" }).getByRole("button", { name: "Delete case" }).click();
  await expect(page.getByRole("alertdialog", { name: "Success" })).toContainText("Support case deleted.");
  await page.getByRole("button", { name: "Close message" }).click();
  await expect(page.getByRole("button", { name: `Delete ${title}` })).toHaveCount(0);
  await expect(page.locator(".audit")).toContainText("Case Deleted");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alertdialog", { name: "Confirm sign out" })).toContainText("Sign out of ResolveIQ?");
  await page.getByRole("button", { name: "Stay signed in" }).click();
  await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alertdialog", { name: "Confirm sign out" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
