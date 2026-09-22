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

function decouperTexte(ctx, texte, largeurMax) {
    return decouper(ctx, texte, largeurMax).map(ligne => ligne.map(m => m.t).join(' '));
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

// ------------------------------------------------------------
// Story de la séquence du combiné (relances, résultat) : visuel 9:16 avec la
// mascotte en fond, pastille de contexte, texte en grand.
// Sans fond disponible, un dégradé aux couleurs de la marque prend le relais.
// ------------------------------------------------------------
// Rappel des rencontres : logos des deux équipes de part et d'autre du nom,
// heure du coup d'envoi dessous. Une ligne de date commune ferme le bloc.
async function dessinerMatchs(ctx, matchs, yDepart, dateTexte) {
    const hauteurLigne = 132;
    for (let i = 0; i < matchs.length; i++) {
        const m = matchs[i];
        const y = yDepart + i * hauteurLigne;
        ctx.font = '34px MontserratXB';
        const nom = (m.home || '') + '  -  ' + (m.away || '');
        let largeur = ctx.measureText(nom).width;
        const max = W - MARGE_X * 2 - 180;
        const echelle = largeur > max ? max / largeur : 1;
        if (echelle < 1) { ctx.font = Math.floor(34 * echelle) + 'px MontserratXB'; largeur = ctx.measureText(nom).width; }

        ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = 14;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(nom, W / 2, y);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        const taille = 62;
        const yLogo = y - taille + 12;
        for (const [url, x] of [[m.homeLogo, W / 2 - largeur / 2 - taille - 22], [m.awayLogo, W / 2 + largeur / 2 + 22]]) {
            if (!url) continue;
            try {
                const img = await imageDepuisUrl(url);
                ctx.drawImage(img, x, yLogo, taille, taille);
            } catch (e) { /* logo indisponible : on garde juste les noms */ }
        }

        if (m.heure) {
            ctx.font = '28px MontserratB';
            ctx.fillStyle = OR;
            ctx.fillText('Coup d\'envoi ' + String(m.heure).replace(':', 'h'), W / 2, y + 44);
        }
        ctx.textAlign = 'left';
    }
    if (dateTexte) {
        ctx.font = '26px MontserratB';
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.textAlign = 'center';
        ctx.fillText(dateTexte, W / 2, yDepart + matchs.length * hauteurLigne - 6);
        ctx.textAlign = 'left';
    }
}

export async function composerStory({ fondUrl, badge, texte, lignes: lignesSup, matchs, dateTexte }) {
    await chargerPolices();
    // Les polices du serveur n'ont pas d'émojis : ils sortaient en carrés vides.
    badge = sansEmoji(badge);
    texte = sansEmoji(texte);
    if (Array.isArray(lignesSup)) lignesSup = lignesSup.map(sansEmoji);
    const logo = await loadImage(await fichierDuDepot('logo-dark.png'));
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    let fond = null;
    if (fondUrl) { try { fond = await imageDepuisUrl(fondUrl); } catch (e) { fond = null; } }
    if (fond) {
        couvrir(ctx, fond, 0, 0, W, H);
    } else {
        const d = ctx.createLinearGradient(0, 0, W, H);
        d.addColorStop(0, '#1b1530'); d.addColorStop(1, '#0a0e1a');
        ctx.fillStyle = d; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(logo, W / 2 - 200, H * 0.18, 400, 400);
    }
    const hautVoile = (Array.isArray(matchs) && matchs.length) ? H * 0.30 : H * 0.38;
    const g = ctx.createLinearGradient(0, hautVoile, 0, H);
    g.addColorStop(0, 'rgba(6,8,16,0)');
    g.addColorStop(0.4, 'rgba(6,8,16,0.84)');
    g.addColorStop(1, 'rgba(6,8,16,0.96)');
    ctx.fillStyle = g; ctx.fillRect(0, hautVoile, W, H - hautVoile);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 16;
    ctx.drawImage(logo, MARGE_X, 150, 90, 90);
    ctx.restore();

    ctx.font = '84px Anton';
    const lignes = decouper(ctx, String(texte || '').toUpperCase(), W - MARGE_X * 2).slice(0, 5);
    const interligne = 96;
    // Lignes complémentaires (ex. matchs du combiné) : le titre remonte d'autant.
    const sup = Array.isArray(lignesSup) ? lignesSup.slice(0, 4) : [];
    const rencontres = Array.isArray(matchs) ? matchs.slice(0, 2) : [];
    const hauteurSup = rencontres.length
        ? rencontres.length * 132 + (dateTexte ? 40 : 0)
        : (sup.length ? sup.length * 58 + 30 : 0);
    const yPremiere = H - 420 - hauteurSup - (lignes.length - 1) * interligne;

    if (badge) {
        ctx.font = '30px MontserratXB';
        const lb = ctx.measureText(badge).width + 44;
        ctx.fillStyle = OR;
        ctx.beginPath();
        ctx.roundRect(W / 2 - lb / 2, yPremiere - 150, lb, 56, 999);
        ctx.fill();
        ctx.fillStyle = '#141821';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(badge, W / 2, yPremiere - 121);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    ctx.font = '84px Anton';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 18;
    dessinerLignes(ctx, lignes, W / 2, yPremiere, interligne);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

    if (rencontres.length) {
        await dessinerMatchs(ctx, rencontres, yPremiere + (lignes.length - 1) * interligne + 130, dateTexte);
    } else if (sup.length) {
        ctx.font = '36px MontserratB';
        ctx.textAlign = 'center';
        ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 10;
        sup.forEach((l, i) => {
            ctx.fillStyle = '#ffffff';
            ctx.fillText(l, W / 2, yPremiere + (lignes.length - 1) * interligne + 90 + i * 58, W - MARGE_X * 2);
        });
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        ctx.textAlign = 'left';
    }

    return canvas.encode('jpeg', 88);
}

// ------------------------------------------------------------
// Affiche « ticket honoré » : reprend le visuel composé jusqu'ici dans le
// navigateur (compositeVictoryStory de index.html) pour que les publications
// de victoire portent les infos des matchs — écussons, score, répartition des
// probabilités — au lieu d'une simple image générée.
// ------------------------------------------------------------
const NAVY = '#0a0e1a';
const CREME = '#f5f5f2';
const GRIS = '#a9b0c4';
const VERT = '#3ecf8e';

function texteEnCercle(ctx, texte, cx, cy, rayon, police, couleur, espacement) {
    ctx.save();
    ctx.font = police;
    ctx.fillStyle = couleur;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const largeurs = [];
    let angleTotal = 0;
    for (const lettre of texte) {
        const l = ctx.measureText(lettre).width + espacement;
        largeurs.push(l);
        angleTotal += l / rayon;
    }
    let angle = -Math.PI / 2 - angleTotal / 2;
    [...texte].forEach((lettre, i) => {
        const demi = (largeurs[i] / rayon) / 2;
        angle += demi;
        ctx.save();
        ctx.translate(cx + rayon * Math.cos(angle), cy + rayon * Math.sin(angle));
        ctx.rotate(angle + Math.PI / 2);
        ctx.fillText(lettre, 0, 0);
        ctx.restore();
        angle += demi;
    });
    ctx.restore();
}

function barreProbabilites(ctx, x, y, w, h, dom, nul, ext) {
    let curseur = x;
    ctx.fillStyle = '#8ab4f8'; ctx.fillRect(curseur, y, w * dom / 100, h); curseur += w * dom / 100;
    ctx.fillStyle = '#e8b84b'; ctx.fillRect(curseur, y, w * nul / 100, h); curseur += w * nul / 100;
    ctx.fillStyle = '#f43f5e'; ctx.fillRect(curseur, y, w * ext / 100, h);
}

// format : 'story' (1080x1920) ou 'post' (1080x1350, feed Instagram/Telegram).
export async function composerTicket({ matchs, accroche, fiabilite, format, fondUrl }) {
    await chargerPolices();
    const logo = await loadImage(await fichierDuDepot('logo-dark.png'));
    const estPost = format === 'post';
    const w = 1080, h = estPost ? 1350 : 1920;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');

    // Le gabarit est pensé en 1920 de haut : en 4:5, tout est réduit d'un
    // même facteur calculé sur la hauteur réellement occupée par le contenu.
    let echelle = 1;
    if (estPost) {
        ctx.font = '30px MontserratXB';
        const lignesAccroche = decouperTexte(ctx, accroche || '', w - (w * 0.09) * 2).length;
        const hauteurNaturelle = 380 + matchs.length * 248 + lignesAccroche * 38 + 416;
        echelle = Math.max(0.55, Math.min(1, (h - 150) / hauteurNaturelle));
    }
    const S = px => Math.round(px * echelle);

    ctx.fillStyle = NAVY;
    ctx.fillRect(0, 0, w, h);

    // Sceau : texte en cercle autour du logo
    const sceauY = S(150), rayon = S(92);
    texteEnCercle(ctx, 'SCORE MASTER • TICKET HONORÉ • ', w / 2, sceauY, rayon, S(22) + 'px MontserratXB', CREME, S(5));
    const tailleLogo = S(74);
    ctx.drawImage(logo, w / 2 - tailleLogo / 2, sceauY - tailleLogo / 2, tailleLogo, tailleLogo);

    const margeX = w * 0.09;
    const largeurInterne = w - margeX * 2;
    let y = S(230) + sceauY;
    const tailleEcusson = S(84);

    for (const m of matchs) {
        const ligneY = y;

        ctx.font = S(68) + 'px Anton';
        ctx.fillStyle = '#e8b84b';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(m.score || '').replace('-', ' – '), w / 2, ligneY + tailleEcusson / 2);

        for (const [url, x] of [[m.homeLogo, margeX], [m.awayLogo, w - margeX - tailleEcusson]]) {
            if (!url) continue;
            try {
                const img = await imageDepuisUrl(url);
                ctx.drawImage(img, x, ligneY, tailleEcusson, tailleEcusson);
            } catch (e) { /* écusson indisponible : le nom suffit */ }
        }

        ctx.font = S(24) + 'px MontserratXB';
        ctx.fillStyle = CREME;
        const ecart = S(16);
        const largeurNom = w / 2 - margeX - tailleEcusson - ecart - S(95);
        const interligne = S(28);
        const milieu = ligneY + tailleEcusson / 2;
        const nom = (texte, align, x) => {
            const lignes = decouperTexte(ctx, texte || '', largeurNom).slice(0, 2);
            ctx.textAlign = align;
            lignes.forEach((l, i) => ctx.fillText(l, x, milieu - (lignes.length - 1) * interligne / 2 + i * interligne));
        };
        nom(m.home, 'left', margeX + tailleEcusson + ecart);
        nom(m.away, 'right', w - margeX - tailleEcusson - ecart);

        const barreY = ligneY + tailleEcusson + S(34);
        barreProbabilites(ctx, margeX, barreY, largeurInterne, S(12), m.probDom, m.probNul, m.probExt);

        ctx.font = S(18) + 'px MontserratB';
        ctx.fillStyle = GRIS;
        ctx.textAlign = 'left';
        ctx.fillText(m.probDom + '% ' + m.home, margeX, barreY + S(34));
        ctx.textAlign = 'right';
        ctx.fillStyle = m.vainqueur === 'ext' ? '#e8b84b' : GRIS;
        ctx.fillText(m.probExt + '% ' + m.away, w - margeX, barreY + S(34));
        ctx.textAlign = 'center';
        ctx.fillStyle = GRIS;
        ctx.fillText(m.probNul + '% Nul', w / 2, barreY + S(34));
        ctx.textAlign = 'left';

        y = barreY + S(130);
    }

    // Accroche
    ctx.font = S(30) + 'px MontserratXB';
    ctx.fillStyle = CREME;
    ctx.textAlign = 'center';
    const lignesAccroche = decouperTexte(ctx, accroche || '', largeurInterne);
    lignesAccroche.forEach((l, i) => ctx.fillText(l, w / 2, y + i * S(38)));
    y += lignesAccroche.length * S(38) + S(50);

    // Ruban légèrement incliné
    ctx.save();
    ctx.translate(w / 2, y + S(30));
    ctx.rotate(-3 * Math.PI / 180);
    ctx.font = S(30) + 'px Anton';
    const ruban = 'TICKET HONORÉ';
    const largeurRuban = ctx.measureText(ruban).width + S(60);
    ctx.fillStyle = '#e8b84b';
    ctx.beginPath(); ctx.roundRect(-largeurRuban / 2, -S(30), largeurRuban, S(60), S(8)); ctx.fill();
    ctx.fillStyle = '#0e1220';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ruban, 0, 2);
    ctx.restore();
    y += S(150);

    // Fiabilité annoncée
    const hauteurBloc = S(96);
    ctx.fillStyle = 'rgba(62,207,142,0.14)';
    ctx.strokeStyle = 'rgba(62,207,142,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(margeX, y, largeurInterne, hauteurBloc, S(14));
    ctx.fill(); ctx.stroke();

    ctx.font = S(24) + 'px MontserratB';
    ctx.fillStyle = '#eafaf1';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('Fiabilité IA annoncée', margeX + S(28), y + hauteurBloc / 2);
    ctx.font = S(40) + 'px Anton';
    ctx.fillStyle = VERT;
    ctx.textAlign = 'right';
    ctx.fillText(fiabilite + '%', w - margeX - S(28), y + hauteurBloc / 2 + 2);
    ctx.textAlign = 'left';
    y += hauteurBloc + S(60);

    ctx.font = S(26) + 'px MontserratB';
    ctx.fillStyle = '#d4d7e2';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('scoremaster.fr   ·   @ScoreMasterOfficiel', w / 2, y);
    y += S(60);

    // Bandeau décoratif en bas, collé au bord : la photo n'habille plus que
    // cette bande, jamais le contenu lisible.
    const hauteurPhoto = Math.min(h - y - 20, S(340));
    if (fondUrl && hauteurPhoto > 100) {
        try {
            const fond = await imageDepuisUrl(fondUrl);
            const photoY = h - hauteurPhoto;
            ctx.save();
            ctx.beginPath(); ctx.rect(0, photoY, w, hauteurPhoto); ctx.clip();
            couvrir(ctx, fond, 0, photoY, w, hauteurPhoto);
            ctx.fillStyle = 'rgba(6,8,16,0.5)';
            ctx.fillRect(0, photoY, w, hauteurPhoto);
            ctx.restore();
            const couture = Math.min(S(90), hauteurPhoto * 0.5);
            const degrade = ctx.createLinearGradient(0, photoY, 0, photoY + couture);
            degrade.addColorStop(0, NAVY);
            degrade.addColorStop(1, 'rgba(10,14,26,0)');
            ctx.fillStyle = degrade; ctx.fillRect(0, photoY, w, couture);
        } catch (e) { /* pas de bandeau : l'aplat suffit */ }
    }

    return canvas.toBuffer('image/jpeg', 92);
}

// ------------------------------------------------------------
// Affiche « sélections validées » : une vraie affiche publicitaire plutôt
// qu'une liste de cotes. Les polices du serveur n'ont pas d'émojis (ils
// sortaient en carrés vides) : les coches sont dessinées à la main.
// ------------------------------------------------------------
function sansEmoji(texte) {
    return String(texte || '')
        .replace(/[←-⯿☀-➿️‍]/g, '')
        .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function coche(ctx, x, y, taille, couleur) {
    ctx.save();
    ctx.strokeStyle = couleur;
    ctx.lineWidth = Math.max(3, taille * 0.16);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + taille * 0.34, y + taille * 0.34);
    ctx.lineTo(x + taille, y - taille * 0.42);
    ctx.stroke();
    ctx.restore();
}

export async function composerAffiche({ fondUrl, badge, titreHaut, titreBas, paris, resume, accroche, cta, dateTexte }) {
    await chargerPolices();
    const logo = await loadImage(await fichierDuDepot('logo-dark.png'));
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    let fond = null;
    if (fondUrl) { try { fond = await imageDepuisUrl(fondUrl); } catch (e) { fond = null; } }
    if (fond) {
        couvrir(ctx, fond, 0, 0, W, H);
    } else {
        const d = ctx.createLinearGradient(0, 0, W, H);
        d.addColorStop(0, '#1b1530'); d.addColorStop(1, '#0a0e1a');
        ctx.fillStyle = d; ctx.fillRect(0, 0, W, H);
    }

    // Voile bas : tout le bloc marketing reste lisible quelle que soit la photo.
    const hautVoile = H * 0.34;
    const voile = ctx.createLinearGradient(0, hautVoile, 0, H);
    voile.addColorStop(0, 'rgba(6,8,16,0)');
    voile.addColorStop(0.32, 'rgba(6,8,16,0.88)');
    voile.addColorStop(1, 'rgba(6,8,16,0.97)');
    ctx.fillStyle = voile; ctx.fillRect(0, hautVoile, W, H - hautVoile);

    ctx.drawImage(logo, 54, 54, 108, 108);

    const marge = 92;
    const largeur = W - marge * 2;
    // Le bloc est construit du bas vers le haut : la liste des cotes grandit
    // vers le haut sans jamais pousser le pied de l'affiche hors cadre.
    let y = H - 150;

    if (cta) {
        ctx.font = '34px MontserratB';
        ctx.fillStyle = '#c9cede';
        ctx.textAlign = 'center';
        ctx.fillText(sansEmoji(cta), W / 2, y);
        y -= 74;
    }

    if (accroche) {
        ctx.font = '40px MontserratXB';
        ctx.fillStyle = OR;
        ctx.textAlign = 'center';
        const lignes = decouperTexte(ctx, sansEmoji(accroche), largeur);
        lignes.reverse().forEach((l, i) => ctx.fillText(l, W / 2, y - i * 50));
        y -= lignes.length * 50 + 34;
    }

    if (resume) {
        const hBloc = 104;
        y -= hBloc;
        ctx.fillStyle = 'rgba(244,197,66,0.12)';
        ctx.strokeStyle = 'rgba(244,197,66,0.45)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(marge, y, largeur, hBloc, 16); ctx.fill(); ctx.stroke();
        ctx.font = '40px MontserratXB';
        ctx.fillStyle = OR;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(sansEmoji(resume), W / 2, y + hBloc / 2);
        ctx.textBaseline = 'alphabetic';
        y -= 46;
    }

    // Cotes : une ligne par pari, cote en gros, libellé à côté, coche dessinée.
    const lignesParis = (paris || []).slice(0, 5);
    const hLigne = 92;
    y -= lignesParis.length * hLigne;
    const yListe = y;
    lignesParis.forEach((pari, i) => {
        const ly = yListe + i * hLigne;
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath(); ctx.roundRect(marge, ly, largeur, hLigne - 16, 14); ctx.fill();

        ctx.font = '46px Anton';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(Number(pari.cote).toFixed(2), marge + 30, ly + (hLigne - 16) / 2);

        if (pari.libelle) {
            ctx.font = '28px MontserratB';
            ctx.fillStyle = '#c9cede';
            const dispo = largeur - 260;
            const [texte] = decouperTexte(ctx, sansEmoji(pari.libelle), dispo);
            ctx.fillText(texte || '', marge + 170, ly + (hLigne - 16) / 2 + 2);
        }

        if (pari.perdu) {
            ctx.font = '40px MontserratXB';
            ctx.fillStyle = '#f43f5e';
            ctx.textAlign = 'right';
            ctx.fillText('X', W - marge - 34, ly + (hLigne - 16) / 2 + 2);
        } else {
            coche(ctx, W - marge - 74, ly + (hLigne - 16) / 2, 40, '#3ecf8e');
        }
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    });
    y -= 40;

    // Titre en deux temps, la seconde moitié en doré
    ctx.textAlign = 'center';
    if (titreBas) {
        ctx.font = '86px Anton';
        ctx.fillStyle = OR;
        ctx.fillText(sansEmoji(titreBas).toUpperCase(), W / 2, y);
        y -= 92;
    }
    if (titreHaut) {
        ctx.font = '86px Anton';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(sansEmoji(titreHaut).toUpperCase(), W / 2, y);
        y -= 122;
    }

    if (badge) {
        ctx.font = '30px MontserratXB';
        const lb = ctx.measureText(badge).width + 48;
        ctx.fillStyle = OR;
        ctx.beginPath(); ctx.roundRect(W / 2 - lb / 2, y - 58, lb, 58, 999); ctx.fill();
        ctx.fillStyle = '#141821';
        ctx.textBaseline = 'middle';
        ctx.fillText(badge, W / 2, y - 28);
        ctx.textBaseline = 'alphabetic';
        y -= 108;
    }

    if (dateTexte) {
        ctx.font = '28px MontserratB';
        ctx.fillStyle = 'rgba(255,255,255,0.72)';
        ctx.fillText(sansEmoji(dateTexte), W / 2, y);
    }
    ctx.textAlign = 'left';

    return canvas.toBuffer('image/jpeg', 92);
}
