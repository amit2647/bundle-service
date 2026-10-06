const express = require("express");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");
const controller = require("../controllers/bundleController");

const router = express.Router();

// Every signed-in member: the screens need the installed bundle's labels.
router.get("/bundles/installed", authenticate, controller.getInstalled);

// Settings → Bundle. bundles.manage is settings-level (SUPER_ADMIN).
router.get("/bundles/installed/status", authenticate, requirePermission("bundles.manage"), controller.getStatus);

router.get("/bundles", authenticate, requirePermission("bundles.manage"), controller.getOffered);

router.post("/bundles/:key/install", authenticate, requirePermission("bundles.manage"), controller.install);
router.post("/bundles/:key/upgrade", authenticate, requirePermission("bundles.manage"), controller.upgrade);

module.exports = router;
