function declaredApplianceKind(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("GOOSE_CHATGPT_WEB_APPLIANCE must be a string");
  const declared = value.trim();
  if (!declared) return null;
  if (declared !== "persistent-rebuild" && declared !== "legacy-codex") {
    throw new Error(`Unsupported GOOSE_CHATGPT_WEB_APPLIANCE value: ${declared}`);
  }
  return declared;
}

function configuredApplianceKind(runtimeSnapshot) {
  if (runtimeSnapshot?.configured !== true) return null;
  return runtimeSnapshot.config?.runtimeKind === "persistent-rebuild"
    ? "persistent-rebuild"
    : "legacy-codex";
}

function resolveApplianceKind({ declared, runtimeSnapshot }) {
  const declaredKind = declaredApplianceKind(declared);
  const configuredKind = configuredApplianceKind(runtimeSnapshot);
  if (configuredKind) {
    if (declaredKind && declaredKind !== configuredKind) {
      throw new Error(
        `GOOSE_CHATGPT_WEB_APPLIANCE=${declaredKind} disagrees with configured appliance ${configuredKind}`,
      );
    }
    return configuredKind;
  }
  return declaredKind || "legacy-codex";
}

function assertLegacyCodexAction(kind, action) {
  if (kind === "persistent-rebuild") {
    throw new Error(
      `${action} belongs to the inherited Codex compatibility surface and is disabled for the persistent Goose rebuild`,
    );
  }
}

module.exports = {
  assertLegacyCodexAction,
  configuredApplianceKind,
  declaredApplianceKind,
  resolveApplianceKind,
};
