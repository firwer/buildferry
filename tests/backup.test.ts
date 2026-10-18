import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";

it("publishes only one complete encrypted backup when two operators choose the same filename", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "buildferry-backup-test-"));
  if (
    !path
      .resolve(directory)
      .startsWith(path.join(tmpdir(), "buildferry-backup-test-"))
  )
    throw new Error("Unexpected cleanup directory");
  try {
    const config = loadConfig({ BUILDFERRY_DATA_DIR: directory }, false);
    const store = new Store(
      path.join(directory, "buildferry.sqlite"),
      config.key,
    );
    store.setSecret("fixture", { value: "private fixture" });
    store.close();
    const filename = path.join(directory, "snapshot.sqlite");
    const execute = () =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "src/server/backup.ts", filename],
        {
          env: {
            ...process.env,
            BUILDFERRY_DATA_DIR: directory,
            BUILDFERRY_ENCRYPTION_KEY: "",
          },
        },
      );
    const results = await Promise.allSettled([execute(), execute()]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const restored = new Store(filename, config.key);
    try {
      expect(
        restored.secret("fixture", z.object({ value: z.string() }))?.value,
      ).toBe("private fixture");
    } finally {
      restored.close();
    }
    expect(
      readdirSync(directory).some((file) =>
        file.startsWith(".buildferry-backup-"),
      ),
    ).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
