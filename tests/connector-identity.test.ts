import { expect, test } from "bun:test";
import {
  CHATGPT_CONNECTOR_NAME,
  isLegacyChatGptConnectorName,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
  legacyChatGptConnectorMigrationMessage,
  resolveSetupConnectorName,
} from "../src/config";

test("the legacy connector identity list flags exactly the retired name", () => {
  expect(LEGACY_CHATGPT_CONNECTOR_NAMES).toEqual(["Codex Native"]);
  expect(isLegacyChatGptConnectorName("Codex Native")).toBe(true);
  expect(isLegacyChatGptConnectorName(CHATGPT_CONNECTOR_NAME)).toBe(false);
  expect(isLegacyChatGptConnectorName("Some Other Connector")).toBe(false);
});

test("the legacy migration message names both the retired and the required connector and forbids reusing the old one in place", () => {
  const message = legacyChatGptConnectorMigrationMessage("Codex Native");
  expect(message).toContain('"Codex Native"');
  expect(message).toContain(`"${CHATGPT_CONNECTOR_NAME}"`);
  expect(message).toContain("Allow all actions");
  expect(message).toContain("do not rename or refresh");
});

test("setup defaults a fresh install to the current connector identity", () => {
  expect(resolveSetupConnectorName(undefined, undefined)).toBe(CHATGPT_CONNECTOR_NAME);
  expect(resolveSetupConnectorName("", undefined)).toBe(CHATGPT_CONNECTOR_NAME);
});

test("setup silently migrates an existing legacy connector name forward when no explicit name is requested", () => {
  expect(resolveSetupConnectorName("Codex Native", undefined)).toBe(CHATGPT_CONNECTOR_NAME);
});

test("setup carries forward an existing non-legacy connector name unchanged", () => {
  expect(resolveSetupConnectorName("Team Codex Harness", undefined)).toBe("Team Codex Harness");
});

test("setup rejects an explicitly requested legacy connector name instead of silently reusing it", () => {
  expect(() => resolveSetupConnectorName(undefined, "Codex Native"))
    .toThrow(/newly created connector named/);
  expect(() => resolveSetupConnectorName("Team Codex Harness", "Codex Native"))
    .toThrow(/newly created connector named/);
});

test("setup accepts an explicitly requested non-legacy connector name", () => {
  expect(resolveSetupConnectorName(undefined, "Team Codex Harness")).toBe("Team Codex Harness");
});

test("setup rejects an invalid explicit connector name", () => {
  expect(() => resolveSetupConnectorName(undefined, "  ")).toThrow("Connector name is invalid");
  expect(() => resolveSetupConnectorName(undefined, "x".repeat(81))).toThrow("Connector name is invalid");
});
