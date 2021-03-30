const name = "log.txt";
const message = `Boot Up: ${
  new Date().toLocaleString("es-ve", { timeZone: "America/Caracas" })
}\n`;
require("fs")
  .writeFileSync(name, message, { flag: "a" });
const subProcess = require("child_process").fork("closeLogging.js", {
  detached: true,
});
console.log(subProcess.pid);
subProcess.unref();
process.exit();
