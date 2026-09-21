/**
 * Réexportations qui ne lient rien — verrou structurel.
 *
 * LE DÉFAUT QUE CE BANC INTERDIT, mesuré en production le 21/09/2026 :
 *
 *     // server/services/mobile-health.ts
 *     export { pseudonymizeMobileDevice } from "./mobile-pseudonym";   // l.81
 *     ...
 *     const pseudonym = pseudonymizeMobileDevice(userId, deviceId, secret);  // l.208
 *
 * `export { x } from "…"` réexporte sans introduire `x` dans la portée du
 * module. L'appel levait donc `ReferenceError` à chaque rapport de santé d'un
 * appareil activé, et le `catch` de la route le traduisait en
 * « 503 DB_UNAVAILABLE » : un message qui accusait la base alors qu'elle
 * répondait normalement.
 *
 * POURQUOI RIEN NE L'AVAIT VU, et pourquoi ce banc est nécessaire :
 *   - `tsconfig.json` porte `"files": []` : `server/` n'est type-vérifié par
 *     AUCUNE commande du dépôt, donc `TS2304` n'est jamais levé ;
 *   - esbuild transpile sans résoudre les identifiants — il a bundlé l'appel
 *     vers un nom qu'il ne déclare nulle part, exit 0, 911,5 ko ;
 *   - le test existant importait le symbole DEPUIS ce module : il exerçait la
 *     réexportation, qui fonctionne, et jamais l'appel interne, qui échoue.
 *
 * Le banc vise la CLASSE de défaut, pas l'occurrence : « aucune réexportation
 * d'un symbole que le fichier utilise lui-même ». Verrouiller l'occurrence se
 * périmerait au premier déplacement de fonction.
 *
 * LE CORRECTIF est toujours le même : importer (ce qui lie le nom), puis
 * réexporter la liaison.
 *
 *     import { x } from "./m";
 *     export { x };
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const racine = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fichiersTs(depuis) {
  const trouves = [];
  for (const entree of readdirSync(depuis)) {
    if (entree === "node_modules" || entree === "dist") continue;
    const chemin = join(depuis, entree);
    if (statSync(chemin).isDirectory()) trouves.push(...fichiersTs(chemin));
    else if (entree.endsWith(".ts") && !entree.endsWith(".d.ts")) trouves.push(chemin);
  }
  return trouves;
}

/** Retire les blocs de commentaires et les lignes `//`, jamais en milieu de
 *  ligne : couper à « // » mutilerait les URL « https:// ». */
function sansCommentaires(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

test("aucune réexportation ne masque un symbole utilisé localement", () => {
  const coupables = [];

  for (const chemin of fichiersTs(join(racine, "server"))) {
    const brut = readFileSync(chemin, "utf8").replace(/\r\n/g, "\n");
    const code = sansCommentaires(brut);

    // `export { a, b as c } from "./m";` — on ignore `export type { … }`,
    // effacé à la compilation et donc sans effet à l'exécution.
    const reexports = [...code.matchAll(/export\s+(?!type\s)\{([^}]*)\}\s*from\s*["'][^"']+["']/g)];
    if (reexports.length === 0) continue;

    // Le corps du fichier, privé de ses lignes de réexportation : c'est là
    // qu'un usage local trahit l'absence de liaison.
    const corps = code.replace(/export\s+(?!type\s)\{[^}]*\}\s*from\s*["'][^"']+["']\s*;?/g, "");

    for (const [, liste] of reexports) {
      for (const membre of liste.split(",")) {
        const nom = membre.trim().split(/\s+as\s+/)[0].trim();
        if (!nom || nom === "default" || nom.startsWith("type ")) continue;

        // Le symbole est-il aussi importé ? Alors il EST lié, tout va bien.
        const importe = new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${nom}\\b[^}]*\\}\\s*from`).test(code)
          || new RegExp(`import\\s+${nom}\\b`).test(code);
        if (importe) continue;

        if (new RegExp(`\\b${nom}\\s*\\(`).test(corps) || new RegExp(`(?<![.\\w"'\`])${nom}\\b(?!\\s*[:,}])`).test(corps)) {
          coupables.push(`${relative(racine, chemin).replace(/\\/g, "/")} — « ${nom} »`);
        }
      }
    }
  }

  assert.deepEqual(
    coupables,
    [],
    "Ces fichiers réexportent un symbole qu'ils utilisent eux-mêmes sans l'importer.\n" +
      "`export { x } from \"…\"` ne crée AUCUNE liaison locale : l'usage lèvera\n" +
      "`ReferenceError` à l'exécution, et ni tsc (qui ne couvre pas server/) ni\n" +
      "esbuild (qui ne résout pas les identifiants) ne le signaleront.\n" +
      "Corriger par : import { x } from \"./m\";  puis  export { x };\n\n" +
      coupables.map((c) => `  - ${c}`).join("\n")
  );
});

test("mobile-health lie bien le pseudonyme qu'il utilise", () => {
  const source = sansCommentaires(
    readFileSync(join(racine, "server", "services", "mobile-health.ts"), "utf8").replace(/\r\n/g, "\n")
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bpseudonymizeMobileDevice\b[^}]*\}\s*from\s*["']\.\/mobile-pseudonym["']/,
    "storeMobileHealthReport appelle pseudonymizeMobileDevice : le symbole doit être IMPORTÉ, " +
      "pas seulement réexporté, faute de quoi chaque rapport de santé d'un appareil activé " +
      "retombe en « 503 DB_UNAVAILABLE » alors que la base répond normalement."
  );
});
