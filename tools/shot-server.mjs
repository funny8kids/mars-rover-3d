import http from 'http';
import fs from 'fs';

const OUT = process.argv[2] || 'F:/tmp_rsb/shots';
fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const name = decodeURIComponent(req.url.replace(/^\/+/, '')).replace(/[^A-Za-z0-9_.-]/g, '_');
    const m = body.match(/^data:image\/png;base64,(.+)$/);
    if (m && name.endsWith('.png')) {
      fs.writeFileSync(`${OUT}/${name}`, Buffer.from(m[1], 'base64'));
      console.log(`GOT ${name} ${Math.round(m[1].length * 0.75 / 1024)}KB`);
    } else {
      console.log(`MISS ${name} (${body.length})`);
    }
    res.end('ok');
  });
}).listen(8123, () => console.log('shot server on 8123 -> ' + OUT));
