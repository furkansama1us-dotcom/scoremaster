// Test local du compositeur : écrit les slides assemblées en JPEG.
//   node tools/compositeur/composer.mjs draft.json --sortie dossier
import fs from 'node:fs';
import path from 'node:path';
import { assembler } from '../../api/_compositeur.mjs';

const fichier = process.argv[2];
const iSortie = process.argv.indexOf('--sortie');
if (!fichier || iSortie === -1) {
    console.error('Usage : node composer.mjs draft.json --sortie dossier');
    process.exit(1);
}
const draft = JSON.parse(fs.readFileSync(fichier, 'utf8'));
const images = await assembler(draft);
const dossier = process.argv[iSortie + 1];
fs.mkdirSync(dossier, { recursive: true });
images.forEach((b, i) => fs.writeFileSync(path.join(dossier, 'slide-' + (i + 1) + '.jpg'), b));
console.log(images.length + ' slides écrites dans ' + dossier);
