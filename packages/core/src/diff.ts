/**
 * GitWand — Shim de rétro-compat pour `src/diff.ts`
 *
 * Depuis v2.1 le moteur diff vit dans `src/diff/`. Ce fichier re-exporte tout
 * pour que les imports `from "../diff.js"` continuent de marcher sans churn
 * dans les patterns et résolveurs. Sera supprimé en v2.2 — d'ici là, ne pas
 * ajouter de nouvelle logique ici.
 */

export * from "./diff/index.js";
