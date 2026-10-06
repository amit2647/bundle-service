const bundleService = require("../services/bundleService");
const installService = require("../services/installService");
const customizedService = require("../services/customizedService");

function handleError(res, error) {
  if (!error.statusCode) {
    console.error("[Bundles]", error);
  }

  return res.status(error.statusCode || 500).json({
    error: error.statusCode ? error.message : "Bundle request failed",
    ...(error.step ? { step: error.step } : {}),
  });
}

async function getInstalled(req, res) {
  try {
    return res.json(await bundleService.installed(req.auth.organizationId));
  } catch (error) {
    return handleError(res, error);
  }
}

async function getOffered(req, res) {
  try {
    const current = await installService.status(req.auth.organizationId);

    return res.json({ bundles: bundleService.offered(), installed: current.bundle });
  } catch (error) {
    return handleError(res, error);
  }
}

async function getStatus(req, res) {
  try {
    return res.json(await installService.status(req.auth.organizationId));
  } catch (error) {
    return handleError(res, error);
  }
}

async function install(req, res) {
  try {
    const token = req.headers.authorization.split(" ")[1];
    const result = await installService.install(
      { organizationId: req.auth.organizationId, userId: req.auth.userId, token },
      req.params.key,
    );

    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
}

// The same steps at a newer version; the firm's edits are kept by each step.
async function upgrade(req, res) {
  try {
    const token = req.headers.authorization.split(" ")[1];
    const result = await installService.install(
      { organizationId: req.auth.organizationId, userId: req.auth.userId, token },
      req.params.key,
      { mode: "upgrade" },
    );

    return res.json(result);
  } catch (error) {
    return handleError(res, error);
  }
}

const caller = (req) => ({ organizationId: req.auth.organizationId, userId: req.auth.userId, token: req.headers.authorization.split(" ")[1] });

// Items the firm edited while the installed version ships something else.
async function getCustomized(req, res) {
  try {
    return res.json(await customizedService.list(caller(req)));
  } catch (error) {
    return handleError(res, error);
  }
}

// Accept the bundle's version of one item, or keep the firm's (dismiss).
async function chooseCustomized(req, res) {
  try {
    return res.json(await customizedService.choose(caller(req), req.body || {}));
  } catch (error) {
    return handleError(res, error);
  }
}

module.exports = { getInstalled, getOffered, getStatus, install, upgrade, getCustomized, chooseCustomized };
