/**
 * Conflict hunk explanations, zh-CN: one string per `explanationRef` key of
 * `@gitwand/core` (English comes from core's own `explanation`). Kept out
 * of the main locale file: loaded on demand, when an explanation is first shown;
 * typed so that a key core adds does not compile until it is translated.
 */
import type { ExplanationKey } from "@gitwand/core";

const explain: Record<ExplanationKey, string> = {
  sameChange: "两个分支做了完全相同的修改。",
  whitespaceOnly: "两个分支的代码相同，只有空白不同。",
  nonOverlapping: "两个分支修改了同一块中的不同区域，可以自动合并。",
  complex: "真正的冲突，需要人工处理。两个分支以不同方式修改了这一块。",
  llmProposed: "由 LLM 兜底方案提出的解决方式。该块会发送到已配置的 LLM 端点进行辅助解决，在接受前会经过校验（语法树以及 tsc/eslint）。",
  oneSideTheirs: "只有传入分支（theirs）修改了这一块。解决方式：采用 theirs。",
  oneSideOurs: "只有当前分支（ours）修改了这一块。解决方式：采用 ours。",
  deleteOurs: "当前分支（ours）删除了这一块，另一分支未改动。解决方式：删除。",
  deleteTheirs: "传入分支（theirs）删除了这一块，另一分支未改动。解决方式：删除。",
  deleteOursNoBase: "当前分支（ours）删除了这一块。没有共同祖先，置信度为中等。建议的解决方式：删除。",
  deleteTheirsNoBase: "传入分支（theirs）删除了这一块。没有共同祖先，置信度为中等。建议的解决方式：删除。",
  insertion: "两个分支都只新增了行，未修改共同祖先。解决方式：合并双方新增内容，ours 在前。",
  insertionNoBase: "两个分支似乎都只新增了行（diff2 推断）。解决方式：合并，ours 在前。",
  reorder: "两个分支包含相同的行，但顺序不同。解决方式：采用 theirs 的顺序；若共同祖先与 theirs 一致，则采用 ours 的顺序。",
  reorderNoBase: "两个分支包含相同的行，但顺序不同。解决方式：采用 theirs 的顺序。",
  valueOnly: "结构相同，有 {0} 个易变值不同（哈希、版本、时间戳…）。解决方式：可比较时取较高的 semver 版本，否则按合并策略处理。",
  valueOnlyFallback: "易变值不同。",
  tokenMerge: "建议的合并：{0} 行按行解决，{1} 行按 token 合并。应用前需要确认。",
  tokenMergeFallback: "建议进行 token 级合并。",
  refactoringRenames: "重构冲突：检测到并反转了 {0} 处重命名。通过 RefMerge 流程解决（反转、合并、重放）。",
  refactoringMoves: "重构冲突：{0} 处方法移动。通过 RefMerge 流程解决（反转、合并、重放）。",
  refactoringBoth: "重构冲突：检测到并反转了 {0} 处重命名，{1} 处方法移动。通过 RefMerge 流程解决（反转、合并、重放）。",
  refactoringDetected: "重构冲突：检测到重构。通过 RefMerge 流程解决（反转、合并、重放）。",
  refactoringFallback: "由并发重构引起的冲突，已通过 RefMerge 流程解决。",
  formatSemantic: "该块由“{0}”解析器按语义解决（依据格式结构合并，而非按行）。",
  generatedFile: "生成的文件（{0}）。此文件应重新生成而不是合并：请解决其源文件，然后重新运行生成它的工具（install/build）。",
  structuralMerge: "通过结构化合并解决（tree-sitter AST）",
};

export default explain;
