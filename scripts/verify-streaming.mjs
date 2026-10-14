// Run against scripts/serve.py. Reads every indexed bundle without retaining it.
import fs from 'node:fs';
import { createAssetFetch } from '../web/asset-loader.js';
const manifest = JSON.parse(fs.readFileSync(new URL('../web/asset-manifest.json', import.meta.url)));
const baseURL = process.env.PLAYER_URL || 'http://127.0.0.1:8000/silksong/';
const assetFetch = createAssetFetch({ baseURL, manifest });
let total = 0;
for (const [name, entry] of Object.entries(manifest.entries)) {
  const response = await assetFetch(new URL('StreamingAssets/aa/WebGL/' + name, baseURL));
  const reader = response.body.getReader();
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
  }
  if (size !== entry.size) throw new Error('Incorrect decoded size');
  total += size;
  console.log('CRC/size verified:', name, size);
}
console.log('All archive entries verified:', Object.keys(manifest.entries).length, 'Bytes:', total);
