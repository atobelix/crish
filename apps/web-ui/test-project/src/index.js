const { createServer } = require("./utils/server");
const { loadConfig } = require("./utils/config");
const { initRoutes } = require("./components/routes");

function main() {
  const config = loadConfig();
  const app = createServer(config);
  initRoutes(app, config);
  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });
}

main();
