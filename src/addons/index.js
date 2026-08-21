const config = require('../core/config');

/**
 * Registre d'addons.
 *
 * Un addon est une source AUTONOME: contrairement a src/sources/*, il ne passe pas par
 * Mainapi et n'a donc besoin ni de la cle VIP ni du domaine spoofe. Il apporte son propre
 * chemin de resolution (API tierce, scraping) et declare les en-tetes que ses CDN
 * exigent, que le proxy de flux se charge de rejouer.
 *
 * Contrat d'un module d'addon:
 *
 *   module.exports = {
 *     id: 'monsite',                       // stable, utilise dans ENABLED_ADDONS
 *     name: 'MonSite',                     // libelle affiche dans la liste des streams
 *     supports: { movie: true, series: false },
 *     available() { return true },         // false = mal configure, ignore avec un log
 *     async getStreams({ tmdbId, type, season, episode }) { return [ ...liens ] },
 *   };
 *
 * `getStreams` renvoie les memes objets que les sources Movix
 * ({url, direct, sourceName, quality, lang, player}), a ceci pres que `url` est deja
 * une URL de proxy quand la source en a besoin (voir kit.proxied).
 *
 * Champ supplementaire `variant`: le fournisseur d'ou vient CE lien, quand une source en
 * agrege plusieurs sous un meme nom. Il s'affiche dans la ligne de detail et sert de cle
 * a l'elagage des redondants, qui ne compare alors que des liens comparables.
 *
 * Ajouter une source = deposer un fichier ici et l'ajouter a MODULES. Rien d'autre.
 */
const MODULES = [require('./aether'), require('./obrigoz'), require('./cinejoy')];

function isEnabled(addon) {
  if (!config.ENABLED_ADDONS) return true;
  return config.ENABLED_ADDONS.some((name) => name.toLowerCase() === addon.id.toLowerCase());
}

const active = MODULES.filter((addon) => {
  if (!isEnabled(addon)) return false;
  if (typeof addon.available === 'function' && !addon.available()) {
    console.warn(`[addons] "${addon.id}" ignore: configuration incomplete`);
    return false;
  }
  return true;
});

if (active.length > 0) {
  console.log(`[addons] actifs: ${active.map((a) => a.name).join(', ')}`);

  // Les flux des addons ne sont jouables qu'a travers le proxy, dont l'URL est batie sur
  // PUBLIC_URL. Sans elle, les liens pointent sur 127.0.0.1: l'iPad ou la TV qui les
  // recoit ne joindra jamais cette adresse, et le stream echouera sans message clair.
  if (!config.PUBLIC_URL) {
    console.warn(
      '[addons] PUBLIC_URL absent -- les liens proxifies pointeront sur 127.0.0.1 et ne ' +
        'seront lisibles que depuis cette machine. Renseigne PUBLIC_URL (ex: http://100.x.x.x:8787).',
    );
  }
  if (!config.STREAM_PROXY_ENABLED) {
    console.warn('[addons] STREAM_PROXY_ENABLED=false -- les URLs sont servies brutes, la plupart des CDN les refuseront.');
  }
}

/**
 * Adapte les addons a la forme attendue par le streamBuilder ({name, getStreams}).
 * L'adaptateur porte deux garanties que chaque addon n'a alors plus a redire:
 * on n'interroge pas une source pour un type qu'elle ne gere pas, et une source qui
 * echoue rend une liste vide plutot que de faire tomber la collecte.
 */
function asSources() {
  return active.map((addon) => ({
    name: addon.name,
    async getStreams(query) {
      if (addon.supports && addon.supports[query.type] === false) return [];
      try {
        return (await addon.getStreams(query)) || [];
      } catch (err) {
        console.warn(`[addons] "${addon.id}" a echoue: ${err.message}`);
        return [];
      }
    },
  }));
}

/** Etat du registre, pour /health et /debug/addons. */
function describe() {
  return MODULES.map((addon) => ({
    id: addon.id,
    name: addon.name,
    supports: addon.supports,
    enabled: active.includes(addon),
    settings: typeof addon.settings === 'function' ? addon.settings() : undefined,
    reason: active.includes(addon)
      ? undefined
      : !isEnabled(addon)
        ? 'non liste dans ENABLED_ADDONS'
        : 'configuration incomplete',
  }));
}

module.exports = { asSources, describe, active };
