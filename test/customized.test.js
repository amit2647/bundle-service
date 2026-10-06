const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

/*
 * Customized items: each editable step's own install endpoint is asked as a
 * dry run at the installed version, and a choice re-runs that one step with
 * the item named. Against a fake database and fake capability services.
 */

process.env.JWT_SECRET = "unit-test-secret";
process.env.JWT_ISSUER = "unit-test-issuer";

const pool = require("../src/config/database");
const { list, choose } = require("../src/services/customizedService");

const MANIFEST = {
  key: "test-practice",
  namespace: "tp",
  version: "1.1.0",
  permissions: [{ code: "tp.sign", name: "Sign" }],
  roles: [{ key: "partner", name: "Partner", permissions: ["customers.read"] }],
  catalog: { services: [{ key: "audit", name: "Audit" }] },
  help: [{ path: "a.md", title: "A", permission: "customers.read", body: "x" }],
};

let row;
let calls;
let audits;
const realFetch = global.fetch;

beforeEach(() => {
  row = { bundle_key: "test-practice", version: "1.1.0", status: "installed", manifest: MANIFEST };
  calls = [];
  audits = [];

  pool.query = async (text, params) => {
    if (/FROM organization_bundles/.test(text)) return { rows: row ? [row] : [] };
    if (/INSERT INTO audit_events/.test(text)) {
      audits.push(params);
      return { rows: [] };
    }
    return { rows: [] };
  };

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    const customized = /roles/.test(url) && /dryRun=1/.test(url)
      ? [{ kind: "role", key: "partner", name: "Senior Partner", mine: { name: "Senior Partner" }, theirs: { name: "Partner" }, version: "1.1.0" }]
      : [];
    return { ok: true, json: async () => ({ kept: customized.length, customized }) };
  };
});

afterEach(() => {
  global.fetch = realFetch;
});

const who = { organizationId: 3, userId: 9, token: "admin-token" };

describe("customized items", () => {
  test("asks each editable step as a dry run at the installed version, never permissions or help", async () => {
    const result = await list(who);

    assert.deepEqual(calls.map((call) => call.url.replace(/^http:\/\/[^/]+/, "")), [
      "/roles/bundles/test-practice/1.1.0?dryRun=1",
      "/services/bundles/test-practice/1.1.0?dryRun=1",
    ]);
    assert.equal(result.version, "1.1.0");
    assert.deepEqual(result.items, [
      { step: "roles", kind: "role", key: "partner", name: "Senior Partner", mine: { name: "Senior Partner" }, theirs: { name: "Partner" }, version: "1.1.0" },
    ]);
  });

  test("accepting re-runs that one step with the item named, and is audited", async () => {
    const result = await choose(who, { step: "roles", kind: "role", key: "partner", choice: "accept" });

    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0].url, /dryRun/);
    assert.deepEqual(calls[0].body.accept, ["role:partner"]);
    assert.equal(calls[0].body.roles[0].key, "partner");
    assert.equal(result.choice, "accept");
    assert.equal(audits[0][2], "bundle.item_accepted");
  });

  test("keeping the firm's version is a dismiss, audited as kept", async () => {
    await choose(who, { step: "catalog", kind: "service", key: "audit", choice: "dismiss" });

    assert.deepEqual(calls[0].body.dismiss, ["service:audit"]);
    assert.equal(audits[0][2], "bundle.item_kept");
  });

  test("refuses a bad choice, a step without editable items, and an organization mid-install", async () => {
    await assert.rejects(choose(who, { step: "roles", kind: "role", key: "partner", choice: "delete" }), { statusCode: 400 });
    await assert.rejects(choose(who, { step: "permissions", kind: "permission", key: "tp.sign", choice: "accept" }), { statusCode: 404 });

    row.status = "upgrading";
    await assert.rejects(list(who), { statusCode: 409 });

    row = null;
    await assert.rejects(list(who), { statusCode: 404 });
    assert.equal(calls.length, 0);
  });
});
