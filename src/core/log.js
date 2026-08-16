// Logging volontairement verbeux -- ce service est un outil perso a un seul utilisateur,
// pas d'API publique, donc la stdout du process est le seul endroit ou deboguer "aucun stream".

function ok(sourceName, tmdbId, message) {
  console.log(`[${sourceName}] tmdbId=${tmdbId} ${message}`);
}

function fail(sourceName, tmdbId, err) {
  const status = err.response?.status;
  const body = err.response?.data;
  const bodyPreview = body ? ` body=${JSON.stringify(body).slice(0, 300)}` : '';
  console.warn(`[${sourceName}] ECHEC tmdbId=${tmdbId} status=${status ?? 'n/a'} msg=${err.message}${bodyPreview}`);
}

module.exports = { ok, fail };
