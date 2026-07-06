import { auditSecurityPosture } from '../auditor/security.js';

const workspaceRoot = process.argv[2] || process.cwd();

auditSecurityPosture(workspaceRoot)
  .then(report => {
    console.log(JSON.stringify(report, null, 2));
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
