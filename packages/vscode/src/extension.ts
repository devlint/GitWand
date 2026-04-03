/**
 * GitWand VS Code Extension
 *
 * TODO (Phase 3):
 * - Intégration avec le merge editor natif de VS Code
 * - Bouton "GitWand: Resolve" dans l'éditeur
 * - Diagnostics inline montrant les conflits résolvables
 * - Status bar avec le nombre de conflits résolvables
 * - CodeLens au-dessus de chaque conflit
 */

import * as vscode from "vscode";
import { resolve } from "@gitwand/core";

export function activate(context: vscode.ExtensionContext) {
  console.log("GitWand extension activated");

  // Commande : résoudre les conflits du fichier actif
  const resolveFile = vscode.commands.registerCommand(
    "gitwand.resolveFile",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("Aucun fichier ouvert.");
        return;
      }

      const document = editor.document;
      const content = document.getText();
      const config = vscode.workspace.getConfiguration("gitwand");

      const result = resolve(content, document.fileName, {
        resolveWhitespace: config.get("resolveWhitespace", true),
        minConfidence: config.get("minConfidence", "high"),
      });

      if (result.stats.totalConflicts === 0) {
        vscode.window.showInformationMessage("Aucun conflit dans ce fichier.");
        return;
      }

      if (result.stats.autoResolved === 0) {
        vscode.window.showWarningMessage(
          `${result.stats.totalConflicts} conflit(s) détecté(s), aucun résolvable automatiquement.`,
        );
        return;
      }

      if (result.mergedContent) {
        // Remplacer tout le contenu du fichier
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(content.length),
        );

        await editor.edit((editBuilder) => {
          editBuilder.replace(fullRange, result.mergedContent!);
        });
      }

      vscode.window.showInformationMessage(
        `✨ GitWand: ${result.stats.autoResolved}/${result.stats.totalConflicts} conflit(s) résolus automatiquement.`,
      );
    },
  );

  context.subscriptions.push(resolveFile);

  // TODO: resolveAll, status
}

export function deactivate() {}
