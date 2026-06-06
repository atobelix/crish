const { loadConfig, DEFAULT_CONFIG } = require("../src/utils/config");

function testLoadConfig() {
  const config = loadConfig();
  console.assert(config.port !== undefined, "Config should have port");
  console.assert(config.version !== undefined, "Config should have version");
  console.log("testLoadConfig: PASSED");
}

function testDefaultConfig() {
  console.assert(DEFAULT_CONFIG.port === 8080, "Default port should be 8080");
  console.assert(DEFAULT_CONFIG.debug === false, "Default debug should be false");
  console.log("testDefaultConfig: PASSED");
}

testLoadConfig();
testDefaultConfig();
console.log("All tests passed!");
