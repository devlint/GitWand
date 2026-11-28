/**
 * Conflict hunk explanations, es: one string per `explanationRef` key of
 * `@gitwand/core` (English comes from core's own `explanation`). Kept out
 * of the main locale file: loaded on demand, when an explanation is first shown;
 * typed so that a key core adds does not compile until it is translated.
 */
import type { ExplanationKey } from "@gitwand/core";

const explain: Record<ExplanationKey, string> = {
  sameChange: "Ambas ramas hicieron exactamente el mismo cambio.",
  whitespaceOnly: "Ambas ramas contienen el mismo código, salvo espacios en blanco.",
  nonOverlapping: "Las ramas modificaron zonas distintas del mismo bloque, así que es posible una fusión automática.",
  complex: "Un conflicto real que necesita una persona. Ambas ramas modificaron este bloque de forma distinta.",
  llmProposed: "Resolución propuesta por el recurso al LLM. El bloque se envía al endpoint LLM configurado para una resolución asistida, que se valida (árbol sintáctico y tsc/eslint) antes de poder aceptarse.",
  oneSideTheirs: "Solo la rama entrante (theirs) modificó este bloque. Resolución: tomar theirs.",
  oneSideOurs: "Solo la rama actual (ours) modificó este bloque. Resolución: tomar ours.",
  deleteOurs: "La rama actual (ours) eliminó este bloque y la otra no lo tocó. Resolución: eliminar.",
  deleteTheirs: "La rama entrante (theirs) eliminó este bloque y la otra no lo tocó. Resolución: eliminar.",
  deleteOursNoBase: "La rama actual (ours) eliminó este bloque. Sin base, la confianza es media. Resolución propuesta: eliminar.",
  deleteTheirsNoBase: "La rama entrante (theirs) eliminó este bloque. Sin base, la confianza es media. Resolución propuesta: eliminar.",
  insertion: "Ambas ramas solo añadieron líneas, sin modificar la base. Resolución: unión de los añadidos, ours primero.",
  insertionNoBase: "Ambas ramas parecen haber añadido solo líneas (heurística diff2). Resolución: unión, ours primero.",
  reorder: "Ambas ramas contienen las mismas líneas en otro orden. Resolución: tomar el orden de theirs, o el de ours cuando la base coincide con theirs.",
  reorderNoBase: "Ambas ramas contienen las mismas líneas en otro orden. Resolución: tomar el orden de theirs.",
  valueOnly: "Misma estructura con {0} valor(es) volátil(es) distinto(s) (hash, versión, marca de tiempo…). Resolución: la versión semver más alta cuando son comparables; si no, lo que diga la política de fusión.",
  valueOnlyFallback: "Valores volátiles distintos.",
  tokenMerge: "Fusión propuesta: {0} línea(s) resuelta(s) línea a línea, {1} línea(s) fusionada(s) token a token. Requiere confirmación antes de aplicarse.",
  tokenMergeFallback: "Fusión a nivel de tokens propuesta.",
  refactoringRenames: "Conflicto de refactorización: {0} renombrado(s) detectado(s) e invertido(s). Resuelto con el pipeline RefMerge (invertir, fusionar, reaplicar).",
  refactoringMoves: "Conflicto de refactorización: {0} movimiento(s) de método. Resuelto con el pipeline RefMerge (invertir, fusionar, reaplicar).",
  refactoringBoth: "Conflicto de refactorización: {0} renombrado(s) detectado(s) e invertido(s), {1} movimiento(s) de método. Resuelto con el pipeline RefMerge (invertir, fusionar, reaplicar).",
  refactoringDetected: "Conflicto de refactorización: refactorización detectada. Resuelto con el pipeline RefMerge (invertir, fusionar, reaplicar).",
  refactoringFallback: "Conflicto causado por una refactorización concurrente, resuelto con el pipeline RefMerge.",
  formatSemantic: "Bloque resuelto semánticamente por el resolvedor «{0}» (fusionado según la estructura del formato, no por líneas).",
  generatedFile: "Archivo generado ({0}). Este archivo se regenera, no se fusiona: resuelve su origen y vuelve a ejecutar la herramienta que lo produce (install/build).",
  structuralMerge: "Resuelto por una fusión estructural (AST de tree-sitter)",
};

export default explain;
