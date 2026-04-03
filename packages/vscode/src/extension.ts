/**
 * GitWand VS Code Extension
 *
 * Features:
 * - Diagnostics inline (warnings sur chaque conflit avec type + résolvabilité)
 * - CodeLens au-dessus de chaque conflit (action rapide)
 * - Status bar avec compteur de conflits
 * - Commandes resolveFile et resolveAll
 */

import * as vscode from "vscode";
import {
  resolve,
  parseConflictMarkers,
  classifyConflict,
  type ConflictType,
} from "@gitwand/core";

// ─── Constants ──────────────────────────────────────────────────
const MARKER_OURS = /^<{7}\s/;
const DIAGNOSTIC_SOURCE = "GitWand";
const WAND = "\u2728";

// ─── Shared state ───────────────────────────────────────────────
let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;

// ─── Helpers ────────────────────────────────────────────────────

function getConfig() {
  const config = vscode.workspace.getConfiguration("gitwand");
  return {
    resolveWhitespace: config.get<boolean>("resolveWhitespace", true),
    minConfidence: config.get<string>("minConfidence", "high") as
      | "certain"
      | "high"
      | "medium"
      | "low",
  };
}

/** Labels lisibles pour chaque type de conflit */
const TYPE_LABELS: Record<ConflictType, string> = {
  same_change: "Same change on both sides",
  one_side_change: "Only one side changed",
  delete_no_change: "Deleted by one side",
  whitespace_only: "Whitespace difference only",
  non_overlapping: "Non-overlapping changes",
  generated_file: "Auto-generated file (lockfile, build output…)",
  value_only_change: "Only volatile values differ (hashes, versions…)",
  complex: "Complex conflict",
};

/** Icônes par type */
const TYPE_ICONS: Record<ConflictType, string> = {
  same_change: "\u2713",
  one_side_change: "\u2713",
  delete_no_change: "\u2713",
  whitespace_only: "\u2713",
  non_overlapping: "\u2713",
  generated_file: "\u2713",
  value_only_change: "\u2713",
  complex: "\u2717",
};

// ─── Diagnostics Provider ───────────────────────────────────────

function updateDiagnostics(document: vscode.TextDocument) {
  if (document.uri.scheme !== "file") {
    return;
  }

  const content = document.getText();
  const { segments } = parseConflictMarkers(content);

  const diagnostics: vscode.Diagnostic[] = [];
  let lineOffset = 0;

  for (const segment of segments) {
    if (segment.type === "text") {
      lineOffset += segment.lines.length;
    } else {
      const conflict = segment.conflict;
      const classification = classifyConflict(conflict);
      const isResolvable = classification.type !== "complex";

      // Trouver la ligne du marqueur <<<<<<< dans le document
      const startLine = findMarkerLine(document, lineOffset);
      if (startLine === -1) {
        lineOffset +=
          conflict.oursLines.length +
          conflict.baseLines.length +
          conflict.theirsLines.length +
          4; // markers
        continue;
      }

      // Trouver la ligne du marqueur >>>>>>>
      const endLine = findEndMarkerLine(document, startLine);
      const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);

      const severity = isResolvable
        ? vscode.DiagnosticSeverity.Information
        : vscode.DiagnosticSeverity.Warning;

      const icon = TYPE_ICONS[classification.type];
      const label = TYPE_LABELS[classification.type];
      const message = isResolvable
        ? `${icon} GitWand can auto-resolve: ${label}`
        : `${icon} Manual resolution needed: ${label}`;

      const diagnostic = new vscode.Diagnostic(range, message, severity);
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = classification.type;
      diagnostics.push(diagnostic);

      lineOffset = endLine + 1;
    }
  }

  diagnosticCollection.set(document.uri, diagnostics);
  updateStatusBar();
}

function findMarkerLine(
  document: vscode.TextDocument,
  fromLine: number,
): number {
  for (let i = fromLine; i < document.lineCount; i++) {
    if (MARKER_OURS.test(document.lineAt(i).text)) {
      return i;
    }
  }
  return -1;
}

function findEndMarkerLine(
  document: vscode.TextDocument,
  fromLine: number,
): number {
  for (let i = fromLine + 1; i < document.lineCount; i++) {
    if (/^>{7}\s/.test(document.lineAt(i).text)) {
      return i;
    }
  }
  return fromLine;
}

// ─── CodeLens Provider ──────────────────────────────────────────

class GitWandCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  refresh() {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const content = document.getText();
    const { segments } = parseConflictMarkers(content);
    const lenses: vscode.CodeLens[] = [];

    let lineOffset = 0;

    for (const segment of segments) {
      if (segment.type === "text") {
        lineOffset += segment.lines.length;
      } else {
        const conflict = segment.conflict;
        const classification = classifyConflict(conflict);
        const isResolvable = classification.type !== "complex";

        const markerLine = findMarkerLine(document, lineOffset);
        if (markerLine === -1) {
          lineOffset +=
            conflict.oursLines.length +
            conflict.baseLines.length +
            conflict.theirsLines.length +
            4;
          continue;
        }

        const endLine = findEndMarkerLine(document, markerLine);
        const range = new vscode.Range(markerLine, 0, markerLine, 0);

        if (isResolvable) {
          // Lens : résoudre ce conflit
          lenses.push(
            new vscode.CodeLens(range, {
              title: `${WAND} Resolve (${TYPE_LABELS[classification.type]})`,
              command: "gitwand.resolveFile",
              tooltip: classification.explanation,
            }),
          );
        } else {
          // Lens informatif
          lenses.push(
            new vscode.CodeLens(range, {
              title: `\u26A0 ${TYPE_LABELS[classification.type]} — manual resolution needed`,
              command: "",
              tooltip: classification.explanation,
            }),
          );
        }

        lineOffset = endLine + 1;
      }
    }

    return lenses;
  }
}

// ─── Status Bar ─────────────────────────────────────────────────

function updateStatusBar() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    statusBarItem.hide();
    return;
  }

  const diagnostics = diagnosticCollection.get(editor.document.uri);
  if (!diagnostics || diagnostics.length === 0) {
    statusBarItem.hide();
    return;
  }

  const total = diagnostics.length;
  const resolvable = diagnostics.filter(
    (d) => d.severity === vscode.DiagnosticSeverity.Information,
  ).length;

  statusBarItem.text = `${WAND} ${resolvable}/${total} resolvable`;
  statusBarItem.tooltip = `GitWand: ${resolvable} conflict(s) can be auto-resolved out of ${total}. Click to resolve.`;
  statusBarItem.command = "gitwand.resolveFile";
  statusBarItem.show();
}

// ─── Commands ───────────────────────────────────────────────────

async function cmdResolveFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active file.");
    return;
  }

  const document = editor.document;
  const content = document.getText();
  const config = getConfig();

  const result = resolve(content, document.fileName, {
    resolveWhitespace: config.resolveWhitespace,
    minConfidence: config.minConfidence,
  });

  if (result.stats.totalConflicts === 0) {
    vscode.window.showInformationMessage("No conflicts in this file.");
    return;
  }

  if (result.stats.autoResolved === 0) {
    vscode.window.showWarningMessage(
      `${result.stats.totalConflicts} conflict(s) found, none auto-resolvable.`,
    );
    return;
  }

  // Reconstruire le contenu avec les résolutions appliquées
  const { segments } = parseConflictMarkers(content);
  const outputParts: string[] = [];

  for (const segment of segments) {
    if (segment.type === "text") {
      outputParts.push(segment.lines.join("\n"));
    } else {
      const singleResult = resolve(
        // Recréer le marqueur pour un seul conflit
        `<<<<<<< ours\n${segment.conflict.oursLines.join("\n")}\n${
          segment.conflict.baseLines.length > 0
            ? `||||||| base\n${segment.conflict.baseLines.join("\n")}\n`
            : ""
        }=======\n${segment.conflict.theirsLines.join("\n")}\n>>>>>>> theirs`,
        document.fileName,
        { resolveWhitespace: config.resolveWhitespace, minConfidence: config.minConfidence },
      );

      if (singleResult.mergedContent) {
        outputParts.push(singleResult.mergedContent);
      } else {
        // Garder les marqueurs pour les conflits non résolus
        const lines = [`<<<<<<< ours`, ...segment.conflict.oursLines];
        if (segment.conflict.baseLines.length > 0) {
          lines.push(`||||||| base`, ...segment.conflict.baseLines);
        }
        lines.push(`=======`, ...segment.conflict.theirsLines, `>>>>>>> theirs`);
        outputParts.push(lines.join("\n"));
      }
    }
  }

  const newContent = outputParts.join("\n");

  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(content.length),
  );

  await editor.edit((editBuilder) => {
    editBuilder.replace(fullRange, newContent);
  });

  vscode.window.showInformationMessage(
    `${WAND} GitWand: ${result.stats.autoResolved}/${result.stats.totalConflicts} conflict(s) auto-resolved.`,
  );
}

async function cmdResolveAll() {
  const config = getConfig();

  // Trouver tous les fichiers avec des diagnostics GitWand
  let totalResolved = 0;
  let totalConflicts = 0;
  let filesProcessed = 0;

  diagnosticCollection.forEach((uri, diagnostics) => {
    if (diagnostics.length > 0) {
      filesProcessed++;
    }
  });

  if (filesProcessed === 0) {
    vscode.window.showInformationMessage("No conflicted files detected.");
    return;
  }

  // Parcourir tous les fichiers ouverts avec des conflits
  for (const document of vscode.workspace.textDocuments) {
    const diags = diagnosticCollection.get(document.uri);
    if (!diags || diags.length === 0) continue;

    const content = document.getText();
    const result = resolve(content, document.fileName, {
      resolveWhitespace: config.resolveWhitespace,
      minConfidence: config.minConfidence,
    });

    if (result.stats.autoResolved > 0 && result.mergedContent) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(content.length),
      );
      edit.replace(document.uri, fullRange, result.mergedContent);
      await vscode.workspace.applyEdit(edit);
    }

    totalResolved += result.stats.autoResolved;
    totalConflicts += result.stats.totalConflicts;
  }

  vscode.window.showInformationMessage(
    `${WAND} GitWand: ${totalResolved}/${totalConflicts} conflict(s) resolved across ${filesProcessed} file(s).`,
  );
}

async function cmdStatus() {
  // Gather stats from all open documents
  const fileStats: Array<{
    name: string;
    total: number;
    resolvable: number;
  }> = [];

  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== "file") continue;

    const content = document.getText();
    const { segments } = parseConflictMarkers(content);
    const conflicts = segments.filter((s) => s.type === "conflict");
    if (conflicts.length === 0) continue;

    let resolvable = 0;
    for (const seg of conflicts) {
      const classification = classifyConflict(seg.conflict);
      if (classification.type !== "complex") resolvable++;
    }

    const name = vscode.workspace.asRelativePath(document.uri);
    fileStats.push({ name, total: conflicts.length, resolvable });
  }

  if (fileStats.length === 0) {
    vscode.window.showInformationMessage(
      `${WAND} GitWand: No conflicted files open.`,
    );
    return;
  }

  // Build a readable report
  const totalConflicts = fileStats.reduce((sum, f) => sum + f.total, 0);
  const totalResolvable = fileStats.reduce((sum, f) => sum + f.resolvable, 0);

  const lines = fileStats.map((f) => {
    const icon = f.resolvable === f.total ? "\u2713" : f.resolvable > 0 ? "\u25D0" : "\u25CB";
    return `${icon} ${f.name} — ${f.resolvable}/${f.total} resolvable`;
  });

  const header = `${WAND} GitWand Status: ${totalResolvable}/${totalConflicts} conflict(s) auto-resolvable across ${fileStats.length} file(s)`;

  // Show in an output channel for a nicer view
  const channel = vscode.window.createOutputChannel("GitWand");
  channel.clear();
  channel.appendLine(header);
  channel.appendLine("");
  for (const line of lines) {
    channel.appendLine(`  ${line}`);
  }
  channel.appendLine("");
  if (totalResolvable > 0) {
    channel.appendLine(
      `Run "GitWand: Resolve All Trivial Conflicts" to auto-resolve.`,
    );
  }
  channel.show(true);
}

// ─── Activation ─────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Diagnostics
  diagnosticCollection =
    vscode.languages.createDiagnosticCollection("gitwand");
  context.subscriptions.push(diagnosticCollection);

  // Status bar (priorité basse, à droite)
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50,
  );
  context.subscriptions.push(statusBarItem);

  // CodeLens
  const codeLensProvider = new GitWandCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("gitwand.resolveFile", cmdResolveFile),
    vscode.commands.registerCommand("gitwand.resolveAll", cmdResolveAll),
    vscode.commands.registerCommand("gitwand.status", cmdStatus),
  );

  // Mettre à jour les diagnostics quand un fichier change ou est ouvert
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      updateDiagnostics(e.document);
      codeLensProvider.refresh();
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      updateDiagnostics(doc);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        updateDiagnostics(editor.document);
      }
      updateStatusBar();
    }),
  );

  // Analyser les fichiers déjà ouverts
  if (vscode.window.activeTextEditor) {
    updateDiagnostics(vscode.window.activeTextEditor.document);
  }
}

export function deactivate() {
  diagnosticCollection?.dispose();
  statusBarItem?.dispose();
}
