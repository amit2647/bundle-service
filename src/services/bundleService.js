const pool = require("../config/database");
const registry = require("./registry");

/*
 * What the organization's installed bundle tells the rest of the product:
 * its vocabulary, field schemas, identifiers, people roles and pipeline.
 * Read from the recorded manifest of the installed version — not the
 * registry — so it stays right even after the image ships a newer version.
 *
 * Shared with every signed-in member (screens need the labels); templates,
 * rules and email bodies are not part of it.
 */
const PUBLIC_SECTIONS = ["vocabulary", "profiles", "identifiers", "peopleRoles", "pipeline", "engagementTypes"];

async function installed(organizationId) {
  const result = await pool.query(
    `SELECT ob.bundle_key, ob.version, ob.status, ob.installed_at, bv.manifest
     FROM organization_bundles ob
     JOIN bundle_versions bv ON bv.bundle_key = ob.bundle_key AND bv.version = ob.version
     WHERE ob.organization_id = $1`,
    [organizationId],
  );

  const row = result.rows[0];

  // Until an install has finished, the organization works as it did before.
  if (!row || row.status !== "installed") {
    return { bundle: null };
  }

  const { manifest } = row;
  const bundle = {
    key: row.bundle_key,
    name: manifest.name,
    version: row.version,
    installedAt: row.installed_at,
    // Which capability screens apply: engagements, obligations, documents, vault.
    capabilities: manifest.requires?.capabilities || [],
  };

  for (const section of PUBLIC_SECTIONS) {
    if (manifest[section] !== undefined) {
      bundle[section] = manifest[section];
    }
  }

  return { bundle };
}

// The bundles this deployment offers, for Settings → Bundle.
function offered() {
  return registry.list().map(({ manifest }) => ({
    key: manifest.key,
    name: manifest.name,
    description: manifest.description || null,
    version: manifest.version,
    capabilities: manifest.requires.capabilities,
    contents: {
      services: (manifest.catalog?.services || []).length,
      packages: (manifest.catalog?.packages || []).length,
      roles: (manifest.roles || []).map((role) => role.name),
      emails: (manifest.email || []).length,
    },
  }));
}

module.exports = { installed, offered };
