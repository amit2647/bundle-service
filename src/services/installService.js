const pool = require("../config/database");
const registry = require("./registry");

/*
 * Installing a bundle into an organization.
 *
 * An install is a sequence of steps, each one call to the service that owns
 * that slice of the bundle, made with the installing admin's own token so
 * every service applies its usual permission checks:
 *
 *   permissions → roles → catalog → engagementTypes → obligations → documents → vault → email
 *
 * Every step is idempotent on its own side, and recorded here in
 * bundle_install_steps. A step that fails stops the install with status
 * 'failed'; installing again resumes at the first step not yet done, and
 * finished steps are not re-run.
 *
 * No transaction is held across those calls (they take seconds and cross
 * services). Instead the organization's row is a lease: status 'installing'
 * with a recent updated_at means another request is running the install. A
 * lease whose holder died goes stale after LEASE_MS and can be taken over.
 */

const LEASE_MS = 2 * 60 * 1000;
const STEP_TIMEOUT_MS = 30 * 1000;

// Capabilities this deployment can install. Each milestone adds its own.
const SUPPORTED_CAPABILITIES = new Set(["engagements", "obligations", "documents", "vault"]);

const url = (base, fallback) => process.env[base] || fallback;

const STEPS = [
  {
    step: "permissions",
    when: (manifest) => (manifest.permissions || []).length > 0,
    target: (key, version) => `${url("IDENTITY_SERVICE_URL", "http://identity-service:4004")}/permissions/bundles/${key}/${version}`,
    body: (manifest) => ({ namespace: manifest.namespace, permissions: manifest.permissions }),
  },
  {
    step: "roles",
    when: (manifest) => (manifest.roles || []).length > 0,
    target: (key, version) => `${url("IDENTITY_SERVICE_URL", "http://identity-service:4004")}/roles/bundles/${key}/${version}`,
    body: (manifest) => ({ namespace: manifest.namespace, roles: manifest.roles }),
  },
  {
    step: "catalog",
    when: (manifest) => Boolean(manifest.catalog),
    target: (key, version) => `${url("SERVICE_SERVICE_URL", "http://service-service:4003")}/services/bundles/${key}/${version}`,
    body: (manifest) => manifest.catalog,
  },
  {
    step: "engagementTypes",
    when: (manifest) => (manifest.engagementTypes || []).length > 0,
    target: (key, version) => `${url("ENGAGEMENT_SERVICE_URL", "http://engagement-service:4009")}/engagements/bundles/${key}/${version}`,
    body: (manifest) => ({ engagementTypes: manifest.engagementTypes }),
  },
  {
    step: "obligations",
    when: (manifest) => (manifest.obligations || []).length > 0,
    target: (key, version) => `${url("OBLIGATION_SERVICE_URL", "http://obligation-service:4010")}/obligations/bundles/${key}/${version}`,
    body: (manifest) => ({ obligations: manifest.obligations }),
  },
  {
    step: "documents",
    when: (manifest) => (manifest.documents || []).length > 0,
    target: (key, version) => `${url("DOCUMENT_SERVICE_URL", "http://document-service:4011")}/documents/bundles/${key}/${version}`,
    body: (manifest) => ({ documents: manifest.documents }),
  },
  {
    step: "vault",
    when: (manifest) => (manifest.vault?.portals || []).length > 0,
    target: (key, version) => `${url("VAULT_SERVICE_URL", "http://vault-service:4012")}/vault/bundles/${key}/${version}`,
    body: (manifest) => ({ vault: manifest.vault }),
  },
  {
    step: "email",
    when: (manifest) => (manifest.email || []).length > 0,
    target: (key, version) => `${url("EMAIL_SERVICE_URL", "http://email-service:4006")}/emails/bundles/${key}/${version}`,
    body: (manifest) => ({ email: manifest.email }),
  },
];

function httpError(statusCode, message, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

const stepsFor = (manifest) => STEPS.filter((step) => step.when(manifest));

// Compares two x.y.z versions: negative, zero or positive.
function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);

  for (let index = 0; index < 3; index += 1) {
    if ((pa[index] || 0) !== (pb[index] || 0)) return (pa[index] || 0) - (pb[index] || 0);
  }

  return 0;
}

/*
 * Decides what a request may do with the organization's existing row.
 * Pure, so the rules are tested on their own. `mode` is "install" or
 * "upgrade".
 *
 * An upgrade runs while the organization keeps working on the version it
 * has: the row's version changes only when every step has finished at the
 * new one. A failed upgrade leaves the row installed at the old version,
 * and upgrading again resumes at the step that failed.
 */
function claimDecision(row, { key, version, mode = "install", now = Date.now() }) {
  if (!row) {
    return mode === "upgrade"
      ? { action: "refuse", statusCode: 409, message: "Nothing is installed to upgrade; install the bundle first" }
      : { action: "create" };
  }

  if (row.bundle_key !== key) {
    return { action: "refuse", statusCode: 409, message: `This organization already has the ${row.bundle_key} bundle — one bundle per organization` };
  }

  const fresh = now - new Date(row.updated_at).getTime() < LEASE_MS;

  if (["installing", "upgrading"].includes(row.status) && fresh) {
    return { action: "refuse", statusCode: 409, message: "An install is already running for this organization" };
  }

  // Installed — or an upgrade whose holder died, which counts as installed.
  if (row.status === "installed" || row.status === "upgrading") {
    if (row.version === version) {
      return { action: "done" };
    }

    if (compareVersions(version, row.version) < 0) {
      return { action: "refuse", statusCode: 409, message: `Version ${row.version} is installed; going back to ${version} is not possible` };
    }

    return mode === "upgrade"
      ? { action: "upgrade" }
      : { action: "refuse", statusCode: 409, message: `Version ${row.version} is installed; upgrade to ${version} instead` };
  }

  if (row.version !== version) {
    return { action: "refuse", statusCode: 409, message: `An install of version ${row.version} is unfinished; finish it before another version` };
  }

  return { action: "resume" };
}

async function claim(organizationId, userId, entry, steps, mode) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialises claims for one organization without holding anything long.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bundle-install'), $1)", [organizationId]);

    const existing = await client.query("SELECT * FROM organization_bundles WHERE organization_id = $1", [organizationId]);
    const decision = claimDecision(existing.rows[0], { key: entry.key, version: entry.version, mode });

    if (decision.action === "refuse") {
      throw httpError(decision.statusCode, decision.message);
    }

    let row = existing.rows[0];

    if (decision.action === "create") {
      const created = await client.query(
        `INSERT INTO organization_bundles (organization_id, bundle_key, version, contract_version, status, installed_by)
         VALUES ($1, $2, $3, $4, 'installing', $5)
         RETURNING *`,
        [organizationId, entry.key, entry.version, entry.manifest.contract, userId],
      );
      row = created.rows[0];
    } else if (decision.action === "upgrade") {
      // The version stays the one in use until every step has finished.
      const upgrading = await client.query(
        "UPDATE organization_bundles SET status = 'upgrading', updated_at = NOW() WHERE id = $1 RETURNING *",
        [row.id],
      );
      row = upgrading.rows[0];
    } else if (decision.action === "resume") {
      const resumed = await client.query(
        "UPDATE organization_bundles SET status = 'installing', updated_at = NOW() WHERE id = $1 RETURNING *",
        [row.id],
      );
      row = resumed.rows[0];
    }

    if (decision.action !== "done") {
      for (const { step } of steps) {
        await client.query(
          `INSERT INTO bundle_install_steps (organization_bundle_id, version, step)
           VALUES ($1, $2, $3)
           ON CONFLICT (organization_bundle_id, version, step) DO NOTHING`,
          [row.id, entry.version, step],
        );
      }
    }

    await client.query("COMMIT");

    return { row, done: decision.action === "done", upgrading: decision.action === "upgrade" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function callStep(step, entry, token) {
  let response;

  try {
    response = await fetch(step.target(entry.key, entry.version), {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(step.body(entry.manifest)),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`the ${step.step} service could not be reached (${error.cause?.code || error.name})`);
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const details = payload?.details ? `: ${[].concat(payload.details).join(", ")}` : "";
    throw new Error(`${payload?.error || `HTTP ${response.status}`}${details}`);
  }

  return payload;
}

async function audit(organizationId, userId, action, details) {
  await pool.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, 'bundle', $4, $5)`,
    [organizationId, userId, action, details.bundle, details],
  );
}

async function install({ organizationId, userId, token }, key, { mode = "install" } = {}) {
  const entry = registry.get(key);

  if (!entry) {
    throw httpError(404, "No such bundle is offered");
  }

  const missing = entry.manifest.requires.capabilities.filter((capability) => !SUPPORTED_CAPABILITIES.has(capability));

  if (missing.length > 0) {
    throw httpError(422, `This deployment cannot install ${key} yet: it needs ${missing.join(", ")}`);
  }

  const steps = stepsFor(entry.manifest);
  const { row, done, upgrading } = await claim(organizationId, userId, entry, steps, mode);

  if (done) {
    return status(organizationId);
  }

  const recorded = await pool.query(
    "SELECT step, status FROM bundle_install_steps WHERE organization_bundle_id = $1 AND version = $2",
    [row.id, entry.version],
  );
  const finished = new Set(recorded.rows.filter((step) => step.status === "done").map((step) => step.step));

  for (const step of steps) {
    if (finished.has(step.step)) {
      continue;
    }

    try {
      const result = await callStep(step, entry, token);

      await pool.query(
        `UPDATE bundle_install_steps
         SET status = 'done', attempts = attempts + 1, last_error = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE organization_bundle_id = $1 AND version = $2 AND step = $3`,
        [row.id, entry.version, step.step],
      );

      // Renew the lease between steps.
      await pool.query("UPDATE organization_bundles SET updated_at = NOW() WHERE id = $1", [row.id]);

      console.log(`[Install] org ${organizationId} ${key}@${entry.version} ${step.step}: ${JSON.stringify(result)}`);
    } catch (error) {
      await pool.query(
        `UPDATE bundle_install_steps
         SET status = 'failed', attempts = attempts + 1, last_error = $4, updated_at = NOW()
         WHERE organization_bundle_id = $1 AND version = $2 AND step = $3`,
        [row.id, entry.version, step.step, error.message],
      );
      // A failed upgrade leaves the organization on the version it had.
      await pool.query("UPDATE organization_bundles SET status = $2, updated_at = NOW() WHERE id = $1", [row.id, upgrading ? "installed" : "failed"]);
      await audit(organizationId, userId, upgrading ? "bundle.upgrade_failed" : "bundle.install_failed", { bundle: key, version: entry.version, step: step.step, error: error.message });

      throw httpError(
        502,
        upgrading
          ? `Upgrade stopped at the ${step.step} step: ${error.message}. Version ${row.version} is still in use; upgrade again to resume.`
          : `Install stopped at the ${step.step} step: ${error.message}. Install again to resume.`,
        { step: step.step },
      );
    }
  }

  if (upgrading) {
    await pool.query(
      "UPDATE organization_bundles SET status = 'installed', version = $2, contract_version = $3, updated_at = NOW() WHERE id = $1",
      [row.id, entry.version, entry.manifest.contract],
    );
    await audit(organizationId, userId, "bundle.upgraded", { bundle: key, from: row.version, version: entry.version });
  } else {
    await pool.query(
      "UPDATE organization_bundles SET status = 'installed', installed_at = NOW(), updated_at = NOW() WHERE id = $1",
      [row.id],
    );
    await audit(organizationId, userId, "bundle.installed", { bundle: key, version: entry.version });
  }

  return status(organizationId);
}

async function status(organizationId) {
  const result = await pool.query(
    `SELECT ob.id, ob.bundle_key, ob.version, ob.status, ob.installed_at, ob.updated_at, b.name
     FROM organization_bundles ob JOIN bundles b ON b.key = ob.bundle_key
     WHERE ob.organization_id = $1`,
    [organizationId],
  );

  const row = result.rows[0];

  if (!row) {
    return { bundle: null };
  }

  const stepsOf = async (version) =>
    (
      await pool.query(
        `SELECT step, status, attempts, last_error, completed_at FROM bundle_install_steps
         WHERE organization_bundle_id = $1 AND version = $2 ORDER BY id`,
        [row.id, version],
      )
    ).rows.map((step) => ({ step: step.step, status: step.status, attempts: step.attempts, error: step.last_error, completedAt: step.completed_at }));

  // An upgrade begun but not finished: the steps recorded for a later version.
  const latest = (await pool.query("SELECT version FROM bundle_install_steps WHERE organization_bundle_id = $1 ORDER BY id DESC LIMIT 1", [row.id])).rows[0];
  const upgrade = latest && latest.version !== row.version && compareVersions(latest.version, row.version) > 0 ? { version: latest.version, steps: await stepsOf(latest.version) } : null;

  return {
    bundle: {
      key: row.bundle_key,
      name: row.name,
      version: row.version,
      status: row.status,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      upgrade,
      steps: await stepsOf(row.version),
    },
  };
}

module.exports = { install, status, claimDecision, compareVersions, stepsFor, STEPS, LEASE_MS };
