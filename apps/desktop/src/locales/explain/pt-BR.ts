/**
 * Conflict hunk explanations, pt-BR: one string per `explanationRef` key of
 * `@gitwand/core` (English comes from core's own `explanation`). Kept out
 * of the main locale file: loaded on demand, when an explanation is first shown;
 * typed so that a key core adds does not compile until it is translated.
 */
import type { ExplanationKey } from "@gitwand/core";

const explain: Record<ExplanationKey, string> = {
  sameChange: "As duas branches fizeram exatamente a mesma alteração.",
  whitespaceOnly: "As duas branches têm o mesmo código, diferindo apenas em espaços em branco.",
  nonOverlapping: "As branches modificaram regiões diferentes do mesmo bloco, então é possível uma mesclagem automática.",
  complex: "Um conflito real, que precisa de uma pessoa. As duas branches modificaram este bloco de formas diferentes.",
  llmProposed: "Resolução proposta pelo recurso ao LLM. O bloco é enviado ao endpoint LLM configurado para uma resolução assistida, validada (árvore sintática e tsc/eslint) antes de poder ser aceita.",
  oneSideTheirs: "Só a branch de entrada (theirs) modificou este bloco. Resolução: usar theirs.",
  oneSideOurs: "Só a branch atual (ours) modificou este bloco. Resolução: usar ours.",
  deleteOurs: "A branch atual (ours) excluiu este bloco e a outra não o alterou. Resolução: excluir.",
  deleteTheirs: "A branch de entrada (theirs) excluiu este bloco e a outra não o alterou. Resolução: excluir.",
  deleteOursNoBase: "A branch atual (ours) excluiu este bloco. Sem base, a confiança é média. Resolução proposta: excluir.",
  deleteTheirsNoBase: "A branch de entrada (theirs) excluiu este bloco. Sem base, a confiança é média. Resolução proposta: excluir.",
  insertion: "As duas branches só adicionaram linhas, sem alterar a base. Resolução: união das inserções, ours primeiro.",
  insertionNoBase: "As duas branches parecem ter só adicionado linhas (heurística diff2). Resolução: união, ours primeiro.",
  reorder: "As duas branches têm as mesmas linhas em outra ordem. Resolução: usar a ordem de theirs, ou a de ours quando a base coincide com theirs.",
  reorderNoBase: "As duas branches têm as mesmas linhas em outra ordem. Resolução: usar a ordem de theirs.",
  valueOnly: "Mesma estrutura, com {0} valor(es) volátil(eis) diferente(s) (hash, versão, timestamp…). Resolução: a versão semver mais alta quando comparáveis; senão, o que a política de mesclagem definir.",
  valueOnlyFallback: "Valores voláteis diferentes.",
  tokenMerge: "Mesclagem proposta: {0} linha(s) resolvida(s) linha a linha, {1} linha(s) mesclada(s) token a token. Confirmação necessária antes de aplicar.",
  tokenMergeFallback: "Mesclagem por tokens proposta.",
  refactoringRenames: "Conflito de refatoração: {0} renomeação(ões) detectada(s) e invertida(s). Resolvido pelo pipeline RefMerge (inverter, mesclar, reaplicar).",
  refactoringMoves: "Conflito de refatoração: {0} movimentação(ões) de método. Resolvido pelo pipeline RefMerge (inverter, mesclar, reaplicar).",
  refactoringBoth: "Conflito de refatoração: {0} renomeação(ões) detectada(s) e invertida(s), {1} movimentação(ões) de método. Resolvido pelo pipeline RefMerge (inverter, mesclar, reaplicar).",
  refactoringDetected: "Conflito de refatoração: refatoração detectada. Resolvido pelo pipeline RefMerge (inverter, mesclar, reaplicar).",
  refactoringFallback: "Conflito causado por uma refatoração concorrente, resolvido pelo pipeline RefMerge.",
  formatSemantic: "Bloco resolvido semanticamente pelo resolvedor \"{0}\" (mesclado pela estrutura do formato, não por linhas).",
  generatedFile: "Arquivo gerado ({0}). Este arquivo é regenerado, não mesclado: resolva a origem dele e rode de novo a ferramenta que o produz (install/build).",
  structuralMerge: "Resolvido por uma mesclagem estrutural (AST do tree-sitter)",
};

export default explain;
