import type { Locator, Page } from "playwright-core";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  assertAuthenticatedChatGptPage,
} from "./chatgpt-session";
import type { RebuildFreshProjectPreparation } from "./rebuild-persistent-browser-driver";

const CHATGPT_HOME = "https://chatgpt.com/";
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 100;

export interface RebuildProjectEntryOptions {
  projectId: string;
  projectName: string;
  timeoutMs?: number;
}

function projectRouteSegment(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); }
  catch { return undefined; }
  if (url.origin !== "https://chatgpt.com" || url.search || url.hash) return undefined;
  return /^\/g\/([^/]+)\/project$/.exec(url.pathname)?.[1];
}

function routeMatchesProject(value: string, projectId: string): boolean {
  const segment = projectRouteSegment(value);
  return segment === projectId || segment?.startsWith(`${projectId}-`) === true;
}

async function waitForComposer(page: Page, timeoutMs: number): Promise<void> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + timeoutMs;
  let stableObservations = 0;
  do {
    if (await composers.count().catch(() => 0) === 1) {
      try {
        await assertAuthenticatedChatGptPage(page);
        stableObservations += 1;
        if (stableObservations >= 3) return;
      } catch {
        stableObservations = 0;
      }
    } else {
      stableObservations = 0;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  } while (true);
  throw new Error("ChatGPT authentication could not be verified on one stable visible composer");
}

async function waitForProjectHome(page: Page, projectId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (routeMatchesProject(page.url(), projectId)) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  } while (true);
  throw new Error("ChatGPT Project home did not resolve to the configured dedicated Project identity");
}

async function targetProjectHome(page: Page, projectName: string, timeoutMs: number): Promise<Locator> {
  const projects = page.getByRole("button", { name: /^Projects$/i }).filter({ visible: true });
  if (await projects.count() !== 1) {
    throw new Error("ChatGPT Projects disclosure must resolve to exactly one visible control");
  }
  const projectsDisclosure = projects.first();
  if (await projectsDisclosure.getAttribute("aria-expanded") !== "true") {
    await projectsDisclosure.click({ force: true, timeout: timeoutMs });
  }

  const options = page.getByRole("button", {
    name: `Open project options for ${projectName}`,
    exact: true,
  }).filter({ visible: true });
  await options.first().waitFor({ state: "visible", timeout: timeoutMs });
  if (await options.count() !== 1) {
    throw new Error("Configured ChatGPT Project row must resolve to exactly one visible options control");
  }

  // Bind the generic "Open project home" action to the exact named Project row before clicking it.
  const row = options.first().locator("xpath=ancestor::*[.//button[@aria-label='Open project home']][1]");
  if (await row.count() !== 1) throw new Error("Configured ChatGPT Project row is ambiguous");
  const home = row.getByRole("button", { name: "Open project home", exact: true }).filter({ visible: true });
  if (await home.count() !== 1) {
    throw new Error("Configured ChatGPT Project row must expose exactly one Project-home control");
  }
  return home.first();
}

export function createChatGptProjectNavigationEntry(
  options: RebuildProjectEntryOptions,
): RebuildFreshProjectPreparation {
  const projectId = options.projectId.trim();
  const projectName = options.projectName.trim();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!/^g-p-[A-Za-z0-9_-]+$/.test(projectId) || !projectName) {
    throw new Error("Fresh Project entry requires the dedicated Project id and name");
  }

  return async (page: Page): Promise<void> => {
    await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForComposer(page, timeoutMs);

    const projectHome = await targetProjectHome(page, projectName, timeoutMs);
    await projectHome.click({ force: true, timeout: timeoutMs });
    await waitForProjectHome(page, projectId, timeoutMs);
    await waitForComposer(page, timeoutMs);

    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    if (await composers.count() !== 1) {
      throw new Error("Fresh Project surface must expose exactly one visible composer");
    }
    if (await page.locator(CHATGPT_USER_TURN_SELECTOR).count() !== 0
      || await page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR).count() !== 0) {
      throw new Error("Fresh Project surface already contains conversation turns");
    }
  };
}
