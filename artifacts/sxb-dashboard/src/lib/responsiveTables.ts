/**
 * Tableaux lisibles sur téléphone.
 *
 * Sur un écran étroit, chaque tableau du tableau de bord devenait une bande à
 * faire défiler horizontalement : jusqu'à 1 700 px de colonnes pour 350 px
 * d'écran, sans jamais voir une ligne entière. Sous 768 px, la feuille de style
 * (`index.css`, `[data-sxb-stack]`) présente donc chaque ligne comme une fiche
 * et chaque cellule comme « intitulé : valeur ».
 *
 * CSS ne sait pas lire l'en-tête d'une colonne depuis une cellule : ce module
 * recopie l'intitulé de chaque colonne dans `data-label` sur ses cellules, pour
 * tous les tableaux présents et à venir sous `root`. Il ne touche ni aux
 * données ni aux comportements, et un tableau peut s'en exclure avec
 * `data-stack="off"`.
 */

// Des attributs plutôt que des classes : React réécrit `className` à chaque
// rendu et effacerait une classe ajoutée ici, alors qu'il ne touche pas à un
// attribut qu'il ne gère pas.
const STACK = 'data-sxb-stack';

function headerLabels(table: HTMLTableElement): string[] {
  const rows = table.tHead?.rows;
  const row = rows && rows.length ? rows[rows.length - 1] : null;
  if (!row) return [];
  const labels: string[] = [];
  for (const cell of Array.from(row.cells)) {
    const text = (cell.textContent || cell.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    for (let span = 0; span < Math.max(1, cell.colSpan); span++) labels.push(text);
  }
  return labels;
}

function labelTable(table: HTMLTableElement): void {
  if (table.dataset.stack === 'off') return;
  const labels = headerLabels(table);
  if (!labels.length) return;
  if (table.getAttribute(STACK) !== 'table') table.setAttribute(STACK, 'table');
  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let column = 0;
      for (const cell of Array.from(row.cells)) {
        const label = cell.colSpan > 1 ? '' : (labels[column] ?? '');
        if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label);
        column += Math.max(1, cell.colSpan);
      }
    }
  }
  // Le cadre bordé qui entourait la bande défilante devient transparent : les
  // fiches portent déjà leur propre bordure, un cadre de plus ferait des
  // cartes dans une carte. Seules les enveloppes qui COMMENCENT par le
  // tableau sont concernées (au plus une pagination ou un pied à sa suite) :
  // un bloc qui porte d'abord un titre ou des filtres garde son apparence.
  let parent = table.parentElement;
  let child: Element = table;
  for (let depth = 0; parent && depth < 3; depth++, child = parent, parent = parent.parentElement) {
    if (parent.tagName === 'MAIN' || parent.firstElementChild !== child || parent.children.length > 3) break;
    if (parent.getAttribute(STACK) !== 'frame') parent.setAttribute(STACK, 'frame');
  }
}

/** Étiquette les tableaux sous `root` et suit ceux qui apparaissent ensuite. */
export function installResponsiveTables(root: HTMLElement): () => void {
  let scheduled = 0;
  const run = () => {
    scheduled = 0;
    root.querySelectorAll('table').forEach(table => labelTable(table as HTMLTableElement));
  };
  const schedule = () => {
    if (!scheduled) scheduled = window.requestAnimationFrame(run);
  };
  run();
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
    if (scheduled) window.cancelAnimationFrame(scheduled);
  };
}
