import { runManagementSecurityEvaluation } from "./management-security-cli.js";

runManagementSecurityEvaluation().then((result) => {
  console.log(`Management security evaluation: ${result.cases.length} cases, expected=${result.passed}`);
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
