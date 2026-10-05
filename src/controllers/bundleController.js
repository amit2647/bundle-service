const bundleService = require("../services/bundleService");
const installService = require("../services/installService");

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

module.exports = { getInstalled, getOffered, getStatus, install };
