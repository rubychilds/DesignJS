import { test as base, expect, type Page } from "@playwright/test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpTestClient } from "./mcp-client";

// Root package.json declares "type": "module" so this file is loaded as ESM,
// where __dirname is not defined. Derive it from import.meta.url.
const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_FILE = resolve(__dirname, "../.designjs.json");
const ARTIFACTS_DIR = resolve(__dirname, "../.e2e-artifacts");

export interface EditorAPI {
  addHtml(html: string): void;
  getHtml(): string;
  getProjectData(): unknown;
  save(): Promise<void>;
  load(): Promise<unknown>;
  clear(): void;
}

interface Fixtures {
  /** Starts on a clean canvas (no saved project on disk). */
  freshApp: Page;
  /** Bridge peer connected as role="mcp-server". */
  mcp: McpTestClient;
}

export const test = base.extend<Fixtures>({
  freshApp: async ({ page }, use) => {
    // Remove any leftover project file so every test starts with a blank canvas.
    if (existsSync(PROJECT_FILE)) await rm(PROJECT_FILE);

    await page.goto("/");
    await waitForEditorReady(page);
    await use(page);

    if (existsSync(PROJECT_FILE)) await rm(PROJECT_FILE);
  },

  mcp: async ({ freshApp: _page }, use) => {
    const client = new McpTestClient();
    await client.connect();
    await use(client);
    client.dispose();
  },
});

export { expect };

export async function waitForEditorReady(page: Page): Promise<void> {
  // __designjs is set inside onReady; wait for its presence.
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __designjs?: unknown }).__designjs !== "undefined",
    undefined,
    { timeout: 20_000 },
  );
}

export function projectFilePath(): string {
  return PROJECT_FILE;
}

export async function writeProjectFile(data: unknown): Promise<void> {
  await mkdir(join(PROJECT_FILE, ".."), { recursive: true });
  await writeFile(PROJECT_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export async function artifactPath(name: string): Promise<string> {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  return resolve(ARTIFACTS_DIR, name);
}
