// Assemblage des carrousels « duo » Score Master, côté serveur.
//
// Reprend à l'identique compositeDuoSlide et compositeDuoCtaSlide de
// index.html. Appelé par api/publish.js au dépôt d'un carrousel par la routine
// cloud : le carrousel arrive ainsi déjà assemblé, sans que l'admin ait à ouvrir
// l'app. Le préfixe « _ » empêche Vercel d'en faire une fonction à part.
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const RACINE_LOCALE = path.resolve(ICI, '..');
const RACINE_DISTANTE = 'https://scoremaster.fr/';

const W = 1080, H = 1920;
const MARGE_X = W * 0.13;
const OR = '#f4c542';

// Fichier du site (polices, logo) : copie locale si elle est disponible,
// sinon téléchargement depuis le site lui-même.
async function fichierDuDepot(relatif) {
    const local = path.join(RACINE_LOCALE, relatif);
    if (fs.existsSync(local)) return fs.readFileSync(local);
    const r = await fetch(RACINE_DISTANTE + relatif);
    if (!r.ok) throw new Error('Téléchargement impossible : ' + relatif + ' (' + r.status + ')');
    return Buffer.from(await r.arrayBuffer());
}

let policesChargees = false;
async function chargerPolices() {
    if (policesChargees) return;
    policesChargees = true;
    GlobalFonts.register(await fichierDuDepot('assets/fonts/Montserrat-ExtraBold.ttf'), 'MontserratXB');
    GlobalFonts.register(await fichierDuDepot('assets/fonts/Montserrat-Bold.ttf'), 'MontserratB');
    GlobalFonts.register(await fichierDuDepot('assets/fonts/Anton-Regular.ttf'), 'Anton');
}

// Les PNG de Higgsfield embarquent des métadonnées d'authenticité (C2PA, bloc
// « caBX ») que le décodeur ne sait pas lire. On ne garde que les blocs
// nécessaires à l'image elle-même.
const BLOCS_UTILES = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
function nettoyerPng(buf) {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(signature)) return buf;
    const morceaux = [signature];
    let pos = 8;
    while (pos + 12 <= buf.length) {
        const longueur = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const fin = pos + 12 + longueur;
        if (fin > buf.length) break;
        if (BLOCS_UTILES.has(type)) morceaux.push(buf.subarray(pos, fin));
        pos = fin;
        if (type === 'IEND') break;
    }
    return Buffer.concat(morceaux);
}

async function imageDepuisUrl(url) {
    let dernier;
    for (let essai = 0; essai < 3; essai++) {
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await loadImage(nettoyerPng(Buffer.from(await r.arrayBuffer())));
        } catch (e) { dernier = e; await new Promise(res => setTimeout(res, 1500)); }
    }
    throw new Error('Image introuvable : ' + url + ' (' + dernier + ')');
}

// Texte avec mots dorés : le texte entre astérisques passe en or.
function decouper(ctx, texte, largeurMax) {
    const mots = [];
    // Espace insécable devant ? ! : ; » (et après «) : la ponctuation ne
    // se retrouve jamais seule en début de ligne.
    const propre = String(texte || '').replace(/ ([?!:;»])/g, ' $1').replace(/« /g, '« ');
    propre.split('*').forEach((morceau, i) => {
        morceau.split(' ').forEach(m => { if (m) mots.push({ t: m, or: i % 2 === 1 }); });
    });
    const lignes = []; let ligne = []; let largeur = 0;
    const espace = ctx.measureText(' ').width;
    mots.forEach(m => {
        const w = ctx.measureText(m.t).width;
        if (ligne.length && largeur + espace + w > largeurMax) { lignes.push(ligne); ligne = []; largeur = 0; }
        largeur += (ligne.length ? espace : 0) + w;
        ligne.push(m);
    });
    if (ligne.length) lignes.push(ligne);
    return lignes;
}

function dessinerLignes(ctx, lignes, cx, yPremiere, interligne) {
    const espace = ctx.measureText(' ').width;
    lignes.forEach((ligne, n) => {
        const total = ligne.reduce((s, m, i) => s + ctx.measureText(m.t).width + (i ? espace : 0), 0);
        let x = cx - total / 2;
        ligne.forEach((m, i) => {
            if (i) x += espace;
            ctx.fillStyle = m.or ? OR : '#ffffff';
            ctx.fillText(m.t, x, yPremiere + n * interligne);
            x += ctx.measureText(m.t).width;
        });
    });
}

function couvrir(ctx, img, x, y, w, h) {
    const e = Math.max(w / img.width, h / img.height);
    const dw = img.width * e, dh = img.height * e;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    ctx.restore();
}

function enTete(ctx, logo, index, total) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 16;
    ctx.drawImage(logo, MARGE_X, 56, 78, 78);
    ctx.restore();

    ctx.font = '26px MontserratXB';
    const idx = (index + 1) + '/' + total;
    const w = ctx.measureText(idx).width + 34;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.roundRect(W - MARGE_X - w, 70, w, 48, 999);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(idx, W - MARGE_X - w / 2, 95);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

function slideDuo(haut, bas, texteHaut, texteBas, logo, index, total) {
    const demi = H / 2;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    couvrir(ctx, haut, 0, 0, W, demi);
    couvrir(ctx, bas, 0, demi, W, demi);

    [0, demi].forEach(y0 => {
        const g = ctx.createLinearGradient(0, y0 + demi * 0.55, 0, y0 + demi);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.62)');
        ctx.fillStyle = g; ctx.fillRect(0, y0 + demi * 0.55, W, demi * 0.45);
    });
    const gh = ctx.createLinearGradient(0, 0, 0, 190);
    gh.addColorStop(0, 'rgba(0,0,0,0.45)'); gh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gh; ctx.fillRect(0, 0, W, 190);

    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, demi - 3, W, 6);

    enTete(ctx, logo, index, total);

    ctx.font = '60px MontserratXB';
    ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 3;
    [[texteHaut, demi], [texteBas, H]].forEach(([texte, basDeMoitie]) => {
        const lignes = decouper(ctx, texte, W - MARGE_X * 2).slice(0, 3);
        const interligne = 70;
        dessinerLignes(ctx, lignes, W / 2, basDeMoitie - 110 - (lignes.length - 1) * interligne, interligne);
    });
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    return canvas;
}

function slideFinale(fond, texte, logo, index, total) {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    couvrir(ctx, fond, 0, 0, W, H);
    const g = ctx.createLinearGradient(0, H * 0.42, 0, H);
    g.addColorStop(0, 'rgba(6,8,16,0)');
    g.addColorStop(0.45, 'rgba(6,8,16,0.82)');
    g.addColorStop(1, 'rgba(6,8,16,0.96)');
    ctx.fillStyle = g; ctx.fillRect(0, H * 0.42, W, H * 0.58);

    enTete(ctx, logo, index, total);

    ctx.font = '84px Anton';
    const lignes = decouper(ctx, String(texte || '').toUpperCase(), W - MARGE_X * 2).slice(0, 5);
    const interligne = 96;
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 18;
    dessinerLignes(ctx, lignes, W / 2, H - 330 - (lignes.length - 1) * interligne, interligne);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    ctx.font = '24px MontserratB';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'center';
    ctx.fillText('18+ · Jouer comporte des risques · 09 74 75 13 13', W / 2, H - 170);
    ctx.textAlign = 'left';
    return canvas;
}

export async function assembler(draft) {
    await chargerPolices();
    const logo = await loadImage(await fichierDuDepot('logo-dark.png'));

    // Regroupe les images par page : { haut, bas } ou { cta }.
    const pages = [];
    draft.slides.forEach(s => {
        let pg = pages.find(x => x.page === s.page);
        if (!pg) { pg = { page: s.page }; pages.push(pg); }
        pg[s.position] = s;
    });
    pages.sort((a, b) => a.page - b.page);

    const images = [];
    for (let i = 0; i < pages.length; i++) {
        const pg = pages[i];
        let canvas;
        if (pg.cta) {
            canvas = slideFinale(await imageDepuisUrl(pg.cta.image_url), pg.cta.texte, logo, i, pages.length);
        } else {
            if (!pg.haut || !pg.bas) throw new Error('Page ' + pg.page + ' incomplète (haut et bas requis)');
            canvas = slideDuo(await imageDepuisUrl(pg.haut.image_url), await imageDepuisUrl(pg.bas.image_url),
                pg.haut.texte, pg.bas.texte, logo, i, pages.length);
        }
        images.push(await canvas.encode('jpeg', 88));
    }
    return images;
}
