const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/healthRoutes");
const bundleRoutes = require("./routes/bundleRoutes");
const requestLogger = require("./middleware/requestLogger");

/*
 * Bundle service: offers the profession bundles built into this image (the
 * registry) and installs one into an organization, step by step, through the
 * services that own each part.
 */
const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.use(healthRoutes);
app.use(bundleRoutes);

module.exports = app;
