const fs = require('fs');
const path = require('path');

// Reproduit la vérification que pnpm fait à l'installation : toute dépendance
// déclarée « catalog: » doit exister dans le catalogue du workspace.
const ws = fs.readFileSync('pnpm-workspace.yaml', 'utf8');
const bloc = ws.split(/^catalog:\s*$/m)[1] || '';
const entrees = new Set();
for (const l of bloc.split('\n')) {
  if (/^\S/.test(l)) break; // fin du bloc indenté
  const m = l.match(/^\s+'?([^':]+)'?\s*:/);
  if (m) entrees.add(m[1].trim());
}

const paquets = [];
(function walk(d, prof) {
  if (prof > 3) return;
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name === '.git' || f.name === 'dist') continue;
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p, prof + 1);
    else if (f.name === 'package.json') paquets.push(p);
  }
})('.', 0);

let manquants = 0;
for (const p of paquets) {
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const [nom, spec] of Object.entries(j[section] || {})) {
      if (typeof spec === 'string' && spec.startsWith('catalog:') && !entrees.has(nom)) {
        console.log('  MANQUANT: ' + nom + '  (requis par ' + p + ')');
        manquants++;
      }
    }
  }
}

console.log('paquets inspectes : ' + paquets.length);
console.log('entrees catalogue : ' + entrees.size);
console.log(manquants === 0 ? 'OK — toutes les references sont satisfaites' : 'ECHEC : ' + manquants + ' reference(s) sans entree');
process.exit(manquants === 0 ? 0 : 1);
