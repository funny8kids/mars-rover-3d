import http from 'http';
import fs from 'fs';
import os from 'os';

// node tools/shot-server.mjs [output-dir]
// Receives window.__RSB.shot() frames over CORS POSTs: the page posts a data URL to
// http://127.0.0.1:8123/<name>.
const OUT = process.argv[2] || fs.mkdtempSync(os.tmpdir() + '/rsb_shots-');
fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.end(); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const name = decodeURIComponent(req.url.replace(/^\/+/, '')).replace(/[^A-Za-z0-9_.-]/g, '_');
    // The extension comes from the payload, never from the name: shot() posts bare names and the
    // capture format is the thing under test (it used to be JPEG q=0.85, which stamped an 8 px DCT
    // lattice into the frames the "no programmed-art traces" check reads — see tools/codec_control.py).
    // Requiring `name.endsWith('.png')` here would silently MISS every frame the rig now writes.
    const m = body.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
    if (m) {
      const file = `${OUT}/${name}.${m[1] === 'png' ? 'png' : 'jpg'}`;
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      console.log(`GOT ${file} ${Math.round(m[2].length * 0.75 / 1024)}KB`);
    } else {
      console.log(`MISS ${name} (${body.length})`);
    }
    res.end('ok');
  });
}).listen(8123, () => console.log('shot server on 8123 -> ' + OUT));
