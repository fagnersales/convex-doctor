import type { Issue, RunResult } from "./types.ts";

export function reportText(result: RunResult): string {
  const { issues, scannedFunctions } = result;
  if (issues.length === 0) {
    return `✓ ${scannedFunctions} function(s) scanned, no issues found.\n`;
  }

  const byFile = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!byFile.has(i.filePath)) byFile.set(i.filePath, []);
    byFile.get(i.filePath)!.push(i);
  }

  const lines: string[] = [];
  let errors = 0;
  let warns = 0;
  let infos = 0;

  for (const [file, fileIssues] of byFile) {
    lines.push(file);
    for (const i of fileIssues) {
      const tag = i.severity === "error" ? "ERROR" : i.severity === "warn" ? "WARN " : "INFO ";
      const where = `${i.line.toString().padStart(4)}:`;
      lines.push(`  ${tag} ${where} [${i.code}] ${i.function} — ${i.message}`);
      if (i.detail) lines.push(`        ↳ ${i.detail}`);
      if (i.severity === "error") errors++;
      else if (i.severity === "warn") warns++;
      else infos++;
    }
    lines.push("");
  }

  lines.push(
    `Scanned ${scannedFunctions} function(s). ${errors} error(s), ${warns} warning(s), ${infos} info.`,
  );
  return lines.join("\n");
}

export function reportJson(result: RunResult): string {
  return JSON.stringify(
    {
      scannedFunctions: result.scannedFunctions,
      issues: result.issues,
    },
    null,
    2,
  );
}

export function exitCode(result: RunResult, strict: boolean): number {
  const hasError = result.issues.some((i) => i.severity === "error");
  const hasWarn = result.issues.some((i) => i.severity === "warn");
  if (hasError) return 1;
  if (strict && hasWarn) return 1;
  return 0;
}
