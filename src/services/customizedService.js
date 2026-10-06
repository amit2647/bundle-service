const pool = require("../config/database");
const { audit, callStep, stepsFor } = require("./installService");

/*
 * Customized items (Settings → Profession Bundle): bundle-installed rows the
 * firm has edited while the installed bundle version ships something else —
 * a role, a service, an email template, a deadline rule, a portal…
 *
 * Nothing new decides what counts. Each step's own install endpoint is called
 * as a dry run at the installed version: it does the install, reports what it
 * would keep as the firm's (their content beside the bundle's) and rolls back.
 * Choosing then re-runs that one step with the item named:
 *
 *   accept   — take the bundle's version over the firm's edit
 *   dismiss  — keep the firm's version; flagged again only by a later version
 *
 * Steps whose items a firm cannot edit (permissions, help) are not asked.
 */

const EDITABLE_STEPS = new Set(["roles", "catalog", "engagementTypes", "obligations", "documents", "vault", "email"]);
const CHOICES = new Set(["accept", "dismiss"]);

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

// The organization's installed bundle, as recorded — never mid-install.
async function installedEntry(organizationId) {
  const result = await pool.query(
    `SELECT ob.bundle_key, ob.version, ob.status, bv.manifest
     FROM organization_bundles ob
     JOIN bundle_versions bv ON bv.bundle_key = ob.bundle_key AND bv.version = ob.version
     WHERE ob.organization_id = $1`,
    [organizationId],
  );
  const row = result.rows[0];

  if (!row) throw httpError(404, "No profession bundle is installed");
  if (row.status !== "installed") throw httpError(409, "Finish the install or upgrade first");

  return { key: row.bundle_key, version: row.version, manifest: row.manifest };
}

const editableSteps = (manifest) => stepsFor(manifest).filter((step) => EDITABLE_STEPS.has(step.step));

async function list({ organizationId, token }) {
  const entry = await installedEntry(organizationId);
  const items = [];

  for (const step of editableSteps(entry.manifest)) {
    let summary;

    try {
      summary = await callStep(step, entry, token, { query: "?dryRun=1" });
    } catch (error) {
      throw httpError(502, `Could not read the ${step.step} items: ${error.message}`);
    }

    for (const item of summary?.customized || []) {
      items.push({ step: step.step, ...item });
    }
  }

  return { bundle: entry.key, version: entry.version, items };
}

async function choose({ organizationId, userId, token }, { step: stepName, kind, key, choice }) {
  if (!CHOICES.has(choice)) throw httpError(400, "choice must be accept or dismiss");
  if (typeof kind !== "string" || typeof key !== "string" || !kind || !key) throw httpError(400, "kind and key are required");

  const entry = await installedEntry(organizationId);
  const step = editableSteps(entry.manifest).find((candidate) => candidate.step === stepName);

  if (!step) throw httpError(404, "That bundle step has no items to choose for");

  let summary;

  try {
    summary = await callStep(step, entry, token, { extra: { [choice]: [`${kind}:${key}`] } });
  } catch (error) {
    throw httpError(502, `The ${step.step} step refused: ${error.message}`);
  }

  await audit(organizationId, userId, choice === "accept" ? "bundle.item_accepted" : "bundle.item_kept", {
    bundle: entry.key,
    version: entry.version,
    step: step.step,
    kind,
    key,
  });

  return { step: step.step, kind, key, choice, summary };
}

module.exports = { list, choose, EDITABLE_STEPS };
