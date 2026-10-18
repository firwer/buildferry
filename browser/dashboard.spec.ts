import { expect, test } from "@playwright/test";

test("keeps the standalone demo readable and free of browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Your team's capacity/ }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Sample data. No accounts are connected and no jobs will run.",
    ),
  ).toBeVisible();
  await expect(page.locator(".account-card")).toHaveCount(3);
  for (const name of [
    "Team accounts",
    "Routing preview",
    "Test planner",
    "Connections",
    "Overview",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("uses free capacity before paid overflow and requires an explicit budget", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Routing preview", exact: true })
    .click();
  await page.getByRole("button", { name: "Preview assignments" }).click();
  await expect(page.locator(".assignment")).toHaveCount(3);
  await expect(
    page
      .locator(".assignment")
      .getByText("Waiting for capacity", { exact: true }),
  ).toHaveCount(1);
  await page.getByLabel("Total spend limit ($)").fill("0.2");
  await page.getByRole("button", { name: "Preview assignments" }).click();
  await expect(
    page.locator(".assignment").getByText("Team build cloud", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Estimated compute: $0.08", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Memory per job").selectOption("32");
  await page.getByRole("button", { name: "Preview assignments" }).click();
  await expect(
    page
      .locator(".assignment")
      .getByText("Waiting for capacity", { exact: true }),
  ).toHaveCount(3);
});

test("balances independent suites and blocks duplicate test names", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Test planner", exact: true }).click();
  await page
    .getByLabel("Suites and seconds")
    .fill("auth.test, 90\norders.test, 60\nsearch.test, 30");
  await page.getByRole("button", { name: "Compare test groups" }).click();
  await expect(page.locator(".shard li")).toHaveText([
    "auth.test",
    "orders.test",
    "search.test",
  ]);
  await page
    .getByLabel("Suites and seconds")
    .fill("auth.test, 90\nauth.test, 60");
  await page.getByRole("button", { name: "Compare test groups" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Each suite must appear once.",
  );
});
