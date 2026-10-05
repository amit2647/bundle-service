const { describe, test, beforeEach, before, after, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jwt = require("jsonwebtoken");

/*
 * bundle-service: the registry, the install claim rules, and a whole install
 * — including one that fails part-way and is resumed — against an in-memory
 * stand-in for the database and fake capability services.
 */

process.env.JWT_SECRET = "unit-test-secret";
process.env.JWT_ISSUER = "unit-test-issuer";

const pool = require("../src/config/database");
const registry = require("../src/services/registry");
const { install, claimDecision, stepsFor, LEASE_MS } = require("../src/services/installService");

// ---------------------------------------------------------------------------
// A minimal bundle on disk
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-service-"));

function writeBundle(dir, overrides = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "bundle.yaml"),
    `key: test-practice
namespace: tp
version: 1.0.0
contract: 1
name: Test Practice
requires: { capabilities: [] }
vocabulary:
  client: { one: Client, many: Clients }
  engagement: { one: Engagement, many: Engagements }
  period: { one: Year, many: Years }
profiles:
  client: { version: 1, schema: { type: object, properties: { kind: { type: string } } } }
catalog:
  services: [{ key: audit, name: Audit }]
permissions: [{ code: tp.sign, name: Sign }]
roles: [{ key: partner, name: Partner, permissions: [customers.read, tp.sign] }]
${overrides}`,
  );
}

writeBundle(path.join(scratch, "good"));
writeBundle(path.join(scratch, "broken"), "plugins: [x]\n");
fs.writeFileSync(path.join(scratch, "README.md"), "not a bundle");

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe("registry", () => {
  test("offers bundles that lint clean and leaves out the rest", () => {
    mock.method(console, "error", () => {});
    const found = registry.scan(scratch);

    // "broken" has the same key but fails lint; "good" is what is offered.
    assert.deepEqual([...found.keys()], ["test-practice"]);
    assert.equal(found.get("test-practice").manifest.catalog.services[0].key, "audit");
  });
});

// ---------------------------------------------------------------------------
// Claim rules
// ---------------------------------------------------------------------------

describe("claimDecision", () => {
  const now = Date.parse("2026-10-03T10:00:00Z");
  const row = (fields) => ({ bundle_key: "ca-practice", version: "0.1.0", status: "failed", updated_at: new Date(now - 1000).toISOString(), ...fields });
  const decide = (existing) => claimDecision(existing, { key: "ca-practice", version: "0.1.0", now });

  test("no row: create one", () => assert.equal(decide(null).action, "create"));
  test("another bundle: refused — one per organization", () => assert.match(decide(row({ bundle_key: "legal" })).message, /one bundle per organization/));
  test("already installed at this version: nothing to do", () => assert.equal(decide(row({ status: "installed" })).action, "done"));
  test("installed at another version: refused until upgrades exist", () => assert.equal(decide(row({ status: "installed", version: "0.0.9" })).statusCode, 409));
  test("an install running right now: refused", () => assert.match(decide(row({ status: "installing" })).message, /already running/));
  test("a stale install whose holder died: resumed", () => {
    assert.equal(decide(row({ status: "installing", updated_at: new Date(now - LEASE_MS - 1).toISOString() })).action, "resume");
  });
  test("a failed install: resumed", () => assert.equal(decide(row({ status: "failed" })).action, "resume"));
});

describe("steps", () => {
  test("run permissions → roles → catalog → engagementTypes → email, skipping what the bundle lacks", () => {
    assert.deepEqual(
      stepsFor({ permissions: [{}], roles: [{}], catalog: {}, engagementTypes: [{}], email: [{}] }).map((s) => s.step),
      ["permissions", "roles", "catalog", "engagementTypes", "email"],
    );
    assert.deepEqual(stepsFor({ catalog: {}, roles: [] }).map((s) => s.step), ["catalog"]);
  });
});

// ---------------------------------------------------------------------------
// A whole install, in memory
// ---------------------------------------------------------------------------

let db;
let calls;
let failing;

function fakeQuery(text, params = []) {
  const sql = text.replace(/\s+/g, " ").trim();

  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /pg_advisory_xact_lock/.test(sql)) return { rows: [] };
  if (/access_grants/.test(sql)) return { rows: [] };
  if (/^INSERT INTO audit_events/.test(sql)) { db.audit.push(params[2]); return { rows: [] }; }

  // registry.load() recording what it offers
  if (/^INSERT INTO bundles /.test(sql)) return { rows: [] };
  if (/^INSERT INTO bundle_versions/.test(sql)) { db.versionChecksum = db.versionChecksum || params[4]; return { rows: [] }; }
  if (/^SELECT checksum FROM bundle_versions/.test(sql)) return { rows: [{ checksum: db.versionChecksum }] };
  if (/JOIN bundle_versions bv/.test(sql)) return { rows: [] };

  if (/^SELECT \* FROM organization_bundles/.test(sql)) return { rows: db.org ? [db.org] : [] };
  if (/^INSERT INTO organization_bundles/.test(sql)) {
    db.org = { id: 1, organization_id: params[0], bundle_key: params[1], version: params[2], status: "installing", updated_at: new Date().toISOString() };
    return { rows: [db.org] };
  }
  if (/^UPDATE organization_bundles SET status = 'installing'/.test(sql)) { db.org.status = "installing"; return { rows: [db.org] }; }
  if (/^UPDATE organization_bundles SET status = 'failed'/.test(sql)) { db.org.status = "failed"; return { rows: [] }; }
  if (/^UPDATE organization_bundles SET status = 'installed'/.test(sql)) { db.org.status = "installed"; return { rows: [] }; }
  if (/^UPDATE organization_bundles SET updated_at/.test(sql)) return { rows: [] };

  if (/^INSERT INTO bundle_install_steps/.test(sql)) {
    if (!db.steps.find((s) => s.step === params[2])) db.steps.push({ step: params[2], status: "pending", attempts: 0, last_error: null });
    return { rows: [] };
  }
  if (/^SELECT step, status FROM bundle_install_steps/.test(sql)) return { rows: db.steps };
  if (/^UPDATE bundle_install_steps SET status = 'done'/.test(sql)) {
    Object.assign(db.steps.find((s) => s.step === params[2]), { status: "done", last_error: null, attempts: db.steps.find((s) => s.step === params[2]).attempts + 1 });
    return { rows: [] };
  }
  if (/^UPDATE bundle_install_steps SET status = 'failed'/.test(sql)) {
    const step = db.steps.find((s) => s.step === params[2]);
    Object.assign(step, { status: "failed", attempts: step.attempts + 1, last_error: params[3] });
    return { rows: [] };
  }

  if (/FROM organization_bundles ob JOIN bundles b/.test(sql)) {
    return { rows: db.org ? [{ ...db.org, name: "Test Practice", installed_at: null }] : [] };
  }
  if (/^SELECT step, status, attempts, last_error, completed_at/.test(sql)) return { rows: db.steps };

  throw new Error(`unexpected query: ${sql}`);
}

pool.query = async (text, params) => fakeQuery(text, params);
pool.connect = async () => ({ query: async (text, params) => fakeQuery(text, params), release() {} });

const realFetch = global.fetch;

before(() => {
  mock.method(console, "log", () => {});
  mock.method(console, "warn", () => {});

  global.fetch = async (url, options) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, options);

    const step = /\/(permissions|roles|services|emails)\/bundles\//.exec(url)[1];
    calls.push({ step, auth: options.headers.Authorization, body: JSON.parse(options.body) });

    if (failing === step) {
      return new Response(JSON.stringify({ error: "service down" }), { status: 503 });
    }

    return new Response(JSON.stringify({ inserted: 1 }), { status: 200 });
  };
});

after(() => {
  global.fetch = realFetch;
});

beforeEach(async () => {
  db = { org: null, steps: [], audit: [] };
  calls = [];
  failing = null;
  await registry.load(path.join(scratch));
});

const actor = { organizationId: 3, userId: 7, token: "admins-token" };

describe("install", () => {
  test("runs every step with the admin's own token and ends installed", async () => {
    const result = await install(actor, "test-practice");

    assert.deepEqual(calls.map((call) => call.step), ["permissions", "roles", "services"]);
    assert.ok(calls.every((call) => call.auth === "Bearer admins-token"));
    assert.deepEqual(calls[1].body, { namespace: "tp", roles: [{ key: "partner", name: "Partner", permissions: ["customers.read", "tp.sign"] }] });
    assert.equal(result.bundle.status, "installed");
    assert.deepEqual(db.audit, ["bundle.installed"]);
  });

  test("installing again changes nothing", async () => {
    await install(actor, "test-practice");
    calls = [];

    const result = await install(actor, "test-practice");

    assert.equal(calls.length, 0);
    assert.equal(result.bundle.status, "installed");
  });

  test("a failed step stops the install; installing again resumes without re-running finished steps", async () => {
    failing = "services";

    await assert.rejects(install(actor, "test-practice"), (error) => {
      assert.equal(error.statusCode, 502);
      assert.equal(error.step, "catalog");
      assert.match(error.message, /service down/);
      return true;
    });

    assert.equal(db.org.status, "failed");
    assert.deepEqual(db.steps.map((s) => [s.step, s.status]), [["permissions", "done"], ["roles", "done"], ["catalog", "failed"]]);

    failing = null;
    calls = [];

    const result = await install(actor, "test-practice");

    assert.deepEqual(calls.map((call) => call.step), ["services"]);
    assert.equal(result.bundle.status, "installed");
    assert.deepEqual(db.steps.map((s) => s.attempts), [1, 1, 2]);
  });

  test("an unknown bundle is 404", async () => {
    await assert.rejects(install(actor, "nope"), (error) => error.statusCode === 404);
  });
});

describe("routes", () => {
  const app = require("../src/app");
  let server;
  let base;

  before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const call = (method, route, permissions) =>
    realFetch(`${base}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt.sign({ sub: 7, organizationId: 3, role: "X", permissions }, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER })}`,
      },
    });

  test("installing and listing need bundles.manage", async () => {
    assert.equal((await call("POST", "/bundles/test-practice/install", ["system.settings"])).status, 403);
    assert.equal((await call("GET", "/bundles", ["users.read"])).status, 403);
    assert.equal((await call("GET", "/bundles/installed/status", ["users.read"])).status, 403);
  });

  test("any member can read what is installed — nothing, here", async () => {
    db.org = null;

    const response = await call("GET", "/bundles/installed", []);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { bundle: null });
  });

  test("without a token, nothing", async () => {
    assert.equal((await realFetch(`${base}/bundles/installed`)).status, 401);
  });
});
