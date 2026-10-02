const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/healthRoutes");
const requestLogger = require("./middleware/requestLogger");

/*
 * Bundle service — the registry of profession bundles and the installer that applies one to an organization, step by step.
 *
 * A capability service of the profession-bundle platform: profession-neutral,
 * configured by the organization's installed bundle. Only /health exists until
 * its milestone adds the routes (see the plan's Part 3).
 */
const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.use(healthRoutes);

module.exports = app;
