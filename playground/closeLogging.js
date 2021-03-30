setTimeout(() => {}, 86400000);
function handler(signal) {
  const name = "log.txt";
  const message = `Shutdown (${signal}): ${
    new Date().toLocaleString("es-ve", { timeZone: "America/Caracas" })
  }\n`;
  require("fs")
    .writeFileSync(name, message, { flag: "a" });
  process.exit();
}
const signals = `SIGHUP
SIGINT
SIGQUIT
SIGILL
SIGTRAP
SIGABRT
SIGBUS
SIGFPE
SIGUSR
SIGSEGV
SIGUSR
SIGPIPE
SIGALRM
SIGTERM
SIGSTKFLT
SIGCHLD
SIGCONT
SIGTSTP
SIGTTIN
SIGTTOU
SIGURG
SIGXCPU
SIGXFSZ
SIGVTALRM
SIGPROF
SIGWINCH
SIGIO
SIGPWR
SIGSYS`.split("\n");
for (const signal of signals || ["SIGINT", "SIGTERM"]) {
  process.on(signal, handler);
}
