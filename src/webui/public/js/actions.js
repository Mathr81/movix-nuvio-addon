import { html, useState, useEffect } from '../vendor/preact-htm.js';
import { api, formatDuration } from './lib.js';
import { Modal, Button, JsonView, Callout, CopyButton, Icon, toast } from './ui.js';

/**
 * Execution des actions (push, cycle du hub, autorisations...).
 *
 * Les actions qui ecrivent dans un compte distant passent par une confirmation; celles qui
 * acceptent une simulation la proposent d'abord. Le resultat s'affiche dans une modale:
 * c'est le JSON exact que rendrait la route POST equivalente.
 */
export function useActions({ onDone } = {}) {
  const [running, setRunning] = useState({});
  const [dialog, setDialog] = useState(null);

  async function execute(action, { dryRun = false, params = {} } = {}) {
    const key = `${action.name}${dryRun ? ':dry' : ''}`;
    setRunning((r) => ({ ...r, [key]: true }));
    setDialog(null);
    try {
      const result = await api(`actions/${action.name}`, { method: 'POST', query: { dryRun: dryRun ? 1 : undefined }, body: params });
      if (result && result.code && result.url) {
        setDialog({ kind: 'code', action, result });
      } else {
        const failed = result && result.ok === false;
        toast(failed ? 'Terminé avec des erreurs' : dryRun ? 'Simulation terminée' : 'Terminé', {
          tone: failed ? 'warn' : 'ok',
          title: action.label,
        });
        setDialog({ kind: 'result', action, result, dryRun });
      }
    } catch (error) {
      toast(error.message, { tone: 'error', title: action.label });
      setDialog({ kind: 'result', action, result: error.data || { error: error.message }, failed: true });
    } finally {
      setRunning((r) => ({ ...r, [key]: false }));
      onDone?.();
    }
  }

  function run(action, options = {}) {
    if (action.writes && !options.dryRun) setDialog({ kind: 'confirm', action, options });
    else execute(action, options);
  }

  const isRunning = (name, dryRun = false) => !!running[`${name}${dryRun ? ':dry' : ''}`];

  let modal = null;
  if (dialog?.kind === 'confirm') {
    const { action, options } = dialog;
    modal = html`<${Modal} title=${action.label} icon="alert" onClose=${() => setDialog(null)}
      footer=${html`
        <${Button} variant="ghost" onClick=${() => setDialog(null)}>Annuler</${Button}>
        ${action.dryRun && html`<${Button} icon="flask" onClick=${() => execute(action, { ...options, dryRun: true })}>Simuler d'abord</${Button}>`}
        <${Button} variant="primary" icon="play" onClick=${() => execute(action, options)}>Exécuter</${Button}>`}>
      <p>Cette action <strong>écrit dans un compte distant</strong>. ${
        action.dryRun ? 'La simulation montre exactement ce qui serait envoyé, sans rien modifier.' : 'Elle ne peut pas être simulée.'
      }</p>
      ${options.confirmText && html`<${Callout} tone="warn">${options.confirmText}</${Callout}>`}
    </${Modal}>`;
  } else if (dialog?.kind === 'result') {
    const { action, result, dryRun, failed } = dialog;
    modal = html`<${Modal} wide title=${`${action.label}${dryRun ? ' — simulation' : ''}`}
      icon=${failed || result?.ok === false ? 'alert' : 'check'} onClose=${() => setDialog(null)}
      footer=${html`<${Button} onClick=${() => setDialog(null)}>Fermer</${Button}>`}>
      ${failed && html`<${Callout} tone="error" title="Échec">${result?.error || 'erreur inconnue'}</${Callout}>`}
      ${!failed && result?.ok === false && html`<${Callout} tone="warn" title="Terminé avec des erreurs">Détail ci-dessous.</${Callout}>`}
      <${JsonView} data=${result} label="Résultat" open />
    </${Modal}>`;
  } else if (dialog?.kind === 'code') {
    modal = html`<${AuthCodeDialog} action=${dialog.action} result=${dialog.result} onClose=${() => setDialog(null)} />`;
  }

  return { run, isRunning, modal };
}

function AuthCodeDialog({ action, result, onClose }) {
  const [left, setLeft] = useState(result.expiresInSeconds || 0);
  useEffect(() => {
    const timer = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  return html`<${Modal} title=${action.label} icon="key" onClose=${onClose}
    footer=${html`<${Button} onClick=${onClose}>Fermer</${Button}>`}>
    <p>Ouvre la page ci-dessous et saisis ce code. L'addon attend la validation en arrière-plan.</p>
    <div class="auth-code">
      <span>${result.code}</span>
      <${CopyButton} text=${result.code} label="Copier" />
    </div>
    <a class="btn btn-primary btn-block" href=${result.url} target="_blank" rel="noopener">
      <${Icon} name="external" size=${15} /><span>Ouvrir ${new URL(result.url).host}</span>
    </a>
    <p class="muted center">${left > 0 ? `Expire dans ${formatDuration(left)}` : 'Code expiré — relance la connexion.'}</p>
    ${result.hint && html`<${Callout}>${result.hint}</${Callout}>`}
  </${Modal}>`;
}
