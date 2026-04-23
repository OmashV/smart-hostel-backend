const cron = require("node-cron");
const { exec } = require("child_process");

function runCommand(command, label) {
  console.log(`[Scheduler] Starting: ${label}`);

  exec(command, { cwd: process.cwd() }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[Scheduler] ${label} failed: ${error.message}`);
      return;
    }

    if (stdout) console.log(`[Scheduler] ${label} stdout:\n${stdout}`);
    if (stderr) console.error(`[Scheduler] ${label} stderr:\n${stderr}`);

    console.log(`[Scheduler] Finished: ${label}`);
  });
}

function startScheduler() {
  console.log("[Scheduler] Jobs initialized");

  // every 5 minutes -> hourly summary
  cron.schedule("*/5 * * * *", () => {
    runCommand("node scripts/buildHourlySummary.js", "Build Hourly Summary");
  });

  // every hour -> daily summary
  cron.schedule("0 * * * *", () => {
    runCommand("node scripts/buildDailySummary.js", "Build Daily Summary");
  });

  // every hour, 5 minutes later -> ML analysis
  cron.schedule("5 * * * *", () => {
    runCommand("py ml/owner_analysis.py", "Run Owner ML Analysis");
  });

  // every hour, 10 minutes later -> Security ML analysis
  cron.schedule("10 * * * *", () => {
  runCommand("py ml/security_analysis.py", "Run Security ML Analysis");
});
}

module.exports = { startScheduler };