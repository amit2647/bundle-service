const pool = require("../config/database");
const registry = require("./registry");

/*
 * Installing a bundle into an organization.
 *
 * An install is a sequence of steps, each one call to the service that owns
 * that slice of the bundle, made with the installing admin's own token so
 * every service applies its usual permission checks:
 *
 *   permissions → roles → catalog → email
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
const SUPPORTED_CAPABILITIES = new Set([]);

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

/*
 * Decides what a request may do with the organization's existing row.
 * Pure, so the rules are tested on their own.
 */
function claimDecision(row, { key, version, now = Date.now() }) {
  if (!row) {
    return { action: "create" };
  }

  if (row.bundle_key !== key) {
    return { action: "refuse", statusCode: 409, message: `This organization already has the ${row.bundle_key} bundle — one bundle per organization` };
  }

  if (row.status === "installed") {
    return row.version === version
      ? { action: "done" }
      : { action: "refuse", statusCode: 409, message: `Version ${row.version} is installed; upgrading is not available yet` };
  }

  const fresh = now - new Date(row.updated_at).getTime() < LEASE_MS;

  if (["installing", "upgrading"].includes(row.status) && fresh) {
    return { action: "refuse", statusCode: 409, message: "An install is already running for this organization" };
  }

  if (row.version !== version) {
    return { action: "refuse", statusCode: 409, message: `An install of version ${row.version} is unfinished; finish it before another version` };
  }

  return { action: "resume" };
}

async function claim(organizationId, userId, entry, steps) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Serialises claims for one organization without holding anything long.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bundle-install'), $1)", [organizationId]);

    const existing = await client.query("SELECT * FROM organization_bundles WHERE organization_id = $1", [organizationId]);
    const decision = claimDecision(existing.rows[0], { key: entry.key, version: entry.version });

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

    return { row, done: decision.action === "done" };
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

async function install({ organizationId, userId, token }, key) {
  const entry = registry.get(key);

  if (!entry) {
    throw httpError(404, "No such bundle is offered");
  }

  const missing = entry.manifest.requires.capabilities.filter((capability) => !SUPPORTED_CAPABILITIES.has(capability));

  if (missing.length > 0) {
    throw httpError(422, `This deployment cannot install ${key} yet: it needs ${missing.join(", ")}`);
  }

  const steps = stepsFor(entry.manifest);
  const { row, done } = await claim(organizationId, userId, entry, steps);

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
      await pool.query("UPDATE organization_bundles SET status = 'failed', updated_at = NOW() WHERE id = $1", [row.id]);
      await audit(organizationId, userId, "bundle.install_failed", { bundle: key, version: entry.version, step: step.step, error: error.message });

      throw httpError(502, `Install stopped at the ${step.step} step: ${error.message}. Install again to resume.`, {
        step: step.step,
      });
    }
  }

  await pool.query(
    "UPDATE organization_bundles SET status = 'installed', installed_at = NOW(), updated_at = NOW() WHERE id = $1",
    [row.id],
  );
  await audit(organizationId, userId, "bundle.installed", { bundle: key, version: entry.version });

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

  const steps = await pool.query(
    `SELECT step, status, attempts, last_error, completed_at FROM bundle_install_steps
     WHERE organization_bundle_id = $1 AND version = $2 ORDER BY id`,
    [row.id, row.version],
  );

  return {
    bundle: {
      key: row.bundle_key,
      name: row.name,
      version: row.version,
      status: row.status,
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
      steps: steps.rows.map((step) => ({
        step: step.step,
        status: step.status,
        attempts: step.attempts,
        error: step.last_error,
        completedAt: step.completed_at,
      })),
    },
  };
}

module.exports = { install, status, claimDecision, stepsFor, STEPS, LEASE_MS };
