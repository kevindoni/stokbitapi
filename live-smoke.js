#!/usr/bin/env node

const axios = require("axios");

const baseUrl = (process.env.BASE_URL || "").trim();

if (!baseUrl) {
  console.error(
    "Missing BASE_URL. Example: BASE_URL=https://your-app.onrender.com npm run test:live",
  );
  process.exit(1);
}

const tests = [
  { name: "Health", path: "/health" },
  { name: "Auth Status", path: "/auth/status" },
  { name: "Token Info", path: "/auth/token-info" },
];

async function run() {
  console.log(`Running live smoke test on ${baseUrl}`);

  let passed = 0;
  for (const test of tests) {
    const url = `${baseUrl.replace(/\/$/, "")}${test.path}`;
    try {
      const response = await axios.get(url, { timeout: 12000 });
      if (response.status >= 200 && response.status < 300) {
        console.log(`PASS: ${test.name} (${response.status})`);
        passed += 1;
      } else {
        console.log(`FAIL: ${test.name} (${response.status})`);
      }
    } catch (error) {
      const status = error.response?.status || "ERR";
      const msg =
        error.response?.data?.message || error.message || "Unknown error";
      console.log(
        `FAIL: ${test.name} (${status}) - ${String(msg).slice(0, 120)}`,
      );
    }
  }

  const failed = tests.length - passed;
  const percent = ((passed / tests.length) * 100).toFixed(2);
  console.log("=======================================");
  console.log(
    `FINAL SCORE: ${passed}/${tests.length} OK (${percent}% VERIFIED)`,
  );
  console.log(`FAILED: ${failed}`);
  console.log("=======================================");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Smoke test error:", err.message);
  process.exit(1);
});
