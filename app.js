import dotenv from 'dotenv';
dotenv.config();

// server.js (and everything it imports, e.g. auth.js reading
// process.env.FRONTEND_URL at module-evaluation time) must not load until
// dotenv.config() has already run. A static `import './server.js'` at the
// top of this file would be hoisted ahead of dotenv.config() per the ES
// module spec, so it's loaded dynamically here instead, after .env is read.
const { app } = await import('./server.js');

const port = process.env.PORT ?? 3001;
app.listen(port, () => {
  console.log(`recon-backend listening on :${port}`);
});
