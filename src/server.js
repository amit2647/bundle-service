const app = require("./app");
const registry = require("./services/registry");

const PORT = process.env.PORT || 4008;

async function startServer() {
  try {
    console.log("[SERVER] Starting bundle-service...");

    // The offered bundles are linted and recorded before anything is served.
    await registry.load();

    app.listen(PORT, () => {
      console.log(`[SERVER] Bundle service running on port ${PORT}`);
    });
  } catch (error) {
    console.error("[SERVER] Bundle service startup failed");

    console.error(error);

    process.exit(1);
  }
}

startServer();
