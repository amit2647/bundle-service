const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { lintBundle } = require("bundle-sdk");

const pool = require("../config/database");

/*
 * The bundles this deployment offers.
 *
 * They are built into the image from the parent repo's bundles/ submodules
 * (BUNDLE_REGISTRY_DIR), never uploaded: a tenant cannot install a bundle
 * the operator did not ship. Each one is linted exactly as its own CI lints
 * it; one that fails is left out and logged, never half-offered.
 *
 * Every version is recorded in bundle_versions. A version's content must
 * never change once recorded — organizations installed it — so a bundle whose
 * content differs from the recorded copy of the same version is refused.
 */

const REGISTRY_DIR = process.env.BUNDLE_REGISTRY_DIR || path.join(__dirname, "..", "..", "registry");

let entries = new Map();

function manifestChecksum(manifest) {
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function scan(dir = REGISTRY_DIR) {
  const found = new Map();

  if (!fs.existsSync(dir)) {
    console.warn(`[Registry] ${dir} does not exist — no bundles offered`);
    return found;
  }

  for (const name of fs.readdirSync(dir).sort()) {
    const bundleDir = path.join(dir, name);

    if (!fs.statSync(bundleDir).isDirectory() || !fs.existsSync(path.join(bundleDir, "bundle.yaml"))) {
      continue;
    }

    const { manifest, errors, warnings } = lintBundle(bundleDir);

    if (errors.length > 0 || !manifest) {
      console.error(`[Registry] ${name} is not offered: ${errors.length} lint error(s)`);
      errors.forEach((error) => console.error(`[Registry]   ${error}`));
      continue;
    }

    warnings.forEach((warning) => console.warn(`[Registry] ${manifest.key}: ${warning}`));

    if (found.has(manifest.key)) {
      console.error(`[Registry] ${manifest.key} appears twice; keeping the first`);
      continue;
    }

    found.set(manifest.key, { key: manifest.key, version: manifest.version, manifest, checksum: manifestChecksum(manifest) });
  }

  return found;
}

// Records what the scan found. Run once at startup, after the scan.
async function record(found) {
  for (const entry of found.values()) {
    const { manifest } = entry;

    await pool.query(
      `INSERT INTO bundles (key, name, description) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
      [manifest.key, manifest.name, manifest.description || null],
    );

    await pool.query(
      `INSERT INTO bundle_versions (bundle_key, version, contract_version, manifest, checksum)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bundle_key, version) DO NOTHING`,
      [manifest.key, manifest.version, manifest.contract, manifest, entry.checksum],
    );

    const stored = await pool.query(
      "SELECT checksum FROM bundle_versions WHERE bundle_key = $1 AND version = $2",
      [manifest.key, manifest.version],
    );

    if (stored.rows[0].checksum !== entry.checksum) {
      console.error(
        `[Registry] ${manifest.key}@${manifest.version} differs from the copy already recorded — a released version must not change. Not offered; bump the version.`,
      );
      found.delete(manifest.key);
    }
  }

  return found;
}

async function load(dir) {
  entries = await record(scan(dir));
  console.log(`[Registry] Offering ${[...entries.values()].map((entry) => `${entry.key}@${entry.version}`).join(", ") || "no bundles"}`);
  return entries;
}

const get = (key) => entries.get(key) || null;
const list = () => [...entries.values()];

module.exports = { load, scan, get, list, manifestChecksum };
