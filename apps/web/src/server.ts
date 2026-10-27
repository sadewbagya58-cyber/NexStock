import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createWebServer(): http.Server {
  return http.createServer((req, res) => {
    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let reqPath = parsedUrl.pathname;

    if (reqPath === '/' || !path.extname(reqPath)) {
      reqPath = '/index.html';
    }

    const filePath = path.join(PUBLIC_DIR, reqPath);

    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Fallback to index.html for client-side routing
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexData);
        });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });
}

export function startWebServer(): void {
  const port = process.env['WEB_PORT'] ? Number(process.env['WEB_PORT']) : 3000;
  const host = process.env['HOST'] ?? '0.0.0.0';

  const server = createWebServer();
  server.listen(port, host, () => {
    console.log(`\n======================================================`);
    console.log(`  NexStock Web UI Preview`);
    console.log(`  Local URL: http://localhost:${port}`);
    console.log(`  Connected API: http://localhost:4000`);
    console.log(`======================================================\n`);
  });
}

if (process.argv[1]?.includes('server')) {
  startWebServer();
}
