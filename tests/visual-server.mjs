import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.MARGIN_QA_PORT || 4173);
const servedDirectories = ["sidepanel", "shared", "icons"].map((name) => path.join(root, name) + path.sep);
const servedFiles = new Set([path.join(root, "tests", "qa-mock.js")]);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "sidepanel/sidepanel.html";
    const absolute = path.resolve(root, relative);
    if (!servedFiles.has(absolute) && !servedDirectories.some((directory) => absolute.startsWith(directory))) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    if (relative === "sidepanel/sidepanel.html") {
      const html = await readFile(absolute, "utf8");
      const injected = html.replace(
        '<script type="module" src="sidepanel.js"></script>',
        '<script src="/tests/qa-mock.js"></script>\n  <script type="module" src="sidepanel.js"></script>',
      );
      response.writeHead(200, { "content-type": mimeTypes[".html"], "cache-control": "no-store" });
      response.end(injected);
      return;
    }

    const info = await stat(absolute);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(absolute)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(absolute).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Margin visual QA server: http://127.0.0.1:${port}/sidepanel/sidepanel.html`);
});
