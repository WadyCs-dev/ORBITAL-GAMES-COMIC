import { createServer } from 'node:http';
import { nasaHandler } from './nasa-proxy.mjs';

try { process.loadEnvFile('.env.local'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const port = Number(process.env.PORT || 10000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT debe ser un número entero entre 1024 y 65535.');

const server = createServer((req, res) => {
  void nasaHandler(req, res, () => {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(JSON.stringify({ error: 'No encontrado.' }));
  });
});
server.listen(port, '0.0.0.0', () => console.log(`ORBITAL API listening on port ${port}`));
server.on('error', (error) => { console.error('ORBITAL API failed to start:', error.message); process.exitCode = 1; });
