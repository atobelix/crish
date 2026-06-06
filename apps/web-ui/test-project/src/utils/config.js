const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  port: 8080,
  host: "localhost",
  version: "1.0.0",
  debug: false,
};

function loadConfig() {
  const configPath = path.join(__dirname, "..", "config.json");
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  }
  return DEFAULT_CONFIG;
}

module.exports = { loadConfig, DEFAULT_CONFIG };
