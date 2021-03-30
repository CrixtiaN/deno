import { db, KeepAwake, Seconds, serve, time } from "./deps.js";

const ka = new KeepAwake(
  time("1m").s.to.ms,
  `https://${Deno.env.get("REPL_SLUG")}.${Deno.env.get("REPL_OWNER")}.repl.co`
    .toLowerCase(),
);
ka.start();

function getDate() {
  return new Date().toLocaleString("es-ve", { timeZone: "America/Caracas" });
}
const bootTime = getDate();
await db.set("boot", bootTime);

// await Deno.writeTextFile("boot.txt", bootTime);

// setInterval(() => {
//   db.set('last', getDate())
// }, time(5).m.to.ms);

console.log(`PID: ${Deno.pid}`);
Deno.signal(Deno.Signal.SIGTERM).then(async () => {
  await db.set("shutdown", getDate());
  Deno.exit();
});
Deno.signal(Deno.Signal.SIGINT).then(async () => {
  await db.set("close", getDate());
  Deno.exit();
});

const PORT = Number(Deno.env.get("PORT")) || 8080 || 3000;
const server = serve({ port: PORT, hostname: "0.0.0.0" });
console.log(
  `Your app is listening on port ${PORT} using Deno ${Deno.version.deno}`,
);

const timeStamp = Date.now();
const getUptime = () => time(Date.now() - timeStamp).ms.toString();
setInterval(async () => {
  const maxUptime = await db.get("maxUptime") || "0s";
  const uptime = getUptime();
  if (Seconds.fromString(uptime) > Seconds.fromString(maxUptime)) {
    await db.set("maxUptime", uptime);
  }
  await db.set("uptime", uptime);
  await db.set("timestamp", getDate())
  
}, time(1).m.to.ms);
const welcomeText = () =>
  `
Hello, Human!
Running on Deno ${Deno.version.deno}
Uptime: ${getUptime()}
`.trimStart();
const welcomeHTML = () =>
  `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <title>Test Bot</title>
      <meta name="description" content="Timestamp: ${getDate()}">
      <meta name="author" content="Scrix">
      <style>
        @media (prefers-color-scheme: dark) {
          body { background:  #333; color: white; }
        } 
      </style>
    </head>
    <body>
      <pre>${welcomeText()}</pre>
    </body>
  </html>
  `;

for await (const request of server) {
  console.log(`[server] There is a new request! @ ${request.url}`);
  const { url: pathname } = request;
  const url = new URL(pathname, `http://localhost:${PORT}`);
  // if (url.pathname === "/bot/resume") {
  //   bot.resume();
  //   request.respond({ body: "Bot resumed!" });
  //   continue;
  // }
  const usingCurl = request.headers.has("User-Agent") &&
    request.headers.get("User-Agent").includes("curl");
  // const html = welcomeHTML();
  request.respond({
    headers: new Headers({
      "Content-Type": usingCurl ? "text/plain" : "text/html",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "Access-Control-Allow-Origin": "*",
      "X-Last-Saved-Uptime": (await db.get("uptime")) || "none",
      "X-Max-Uptime": (await db.get("maxUptime")) || "none",
      "X-Last-Saved-Timestamp": await db.get("timestamp") ?? "none",
    }),
    body: usingCurl ? welcomeText() : welcomeHTML() || "Hello, World!\n",
  });
  // switch(url.pathname) {
  //   case '/close':
  //     server.close();
  //     console.log('Shutting down...');
  //     Deno.exit();
  //     break;
  // }
}
