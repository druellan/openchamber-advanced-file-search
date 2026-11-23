import { connectHost } from "@openchamber/sdk";
import {
  applyHostReady,
  mountButton,
  mountCheckbox,
  mountEmpty,
  mountSearchField,
  mountSpinner,
} from "@openchamber/sdk/ui";

const searchFieldSlot = document.querySelector("#searchFieldSlot") as HTMLElement;
const searchBtnSlot = document.querySelector("#searchBtnSlot") as HTMLElement;
const stopBtnSlot = document.querySelector("#stopBtnSlot") as HTMLElement;
const clearBtnSlot = document.querySelector("#clearBtnSlot") as HTMLElement;
const regexSlot = document.querySelector("#regexSlot") as HTMLElement;
const caseSlot = document.querySelector("#caseSlot") as HTMLElement;
const patternInput = document.querySelector("#pattern") as HTMLInputElement;
const ignoreInput = document.querySelector("#ignore") as HTMLInputElement;
const resultsEl = document.querySelector("#results") as HTMLElement;
const statusEl = document.querySelector("#status") as HTMLElement;

const host = connectHost();
let stopped = false;
let projectAvailable = false;
let searchedFiles = 0;
let skippedFiles = 0;
let skippedDirectories = 0;
let matchCount = 0;
let mounted = false;
let regexValue = false;
let caseValue = false;
let queryValue = "";
let useGitignore = true;
let ignoreDotfiles = false;
let gitignorePatterns: string[] = [];


let searchHandle: { update: (props: { value: string }) => void; dispose: () => void } | null = null;
let regexHandle: { update: (props: { checked: boolean }) => void; dispose: () => void } | null = null;
let caseHandle: { update: (props: { checked: boolean }) => void; dispose: () => void } | null = null;
let gitignoreHandle: { update: (props: { checked: boolean }) => void; dispose: () => void } | null = null;
let dotfilesHandle: { update: (props: { checked: boolean }) => void; dispose: () => void } | null = null;
let stateHandle: { dispose: () => void } | null = null;
const rowButtonHandles = new Set<{ dispose: () => void }>();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string, pathMode: boolean): RegExp {
  let expression = "^";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      // ** matches any path depth
      expression += ".*";
      i += 2;
      // consume trailing slash after **
      if (pattern[i] === "/") i++;
    } else if (char === "*") {
      // single * matches within one path segment
      expression += pathMode ? "[^/]*" : ".*";
      i++;
    } else if (char === "?") {
      expression += pathMode ? "[^/]" : ".";
      i++;
    } else {
      expression += escapeRegExp(char);
      i++;
    }
  }
  return new RegExp(`${expression}$`);
}

function globMatch(pattern: string, name: string): boolean {
  return globToRegExp(pattern, false).test(name);
}

function matchesPattern(filename: string, patterns: string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => globMatch(pattern, filename));
}

function parseGitignore(content: string): string[] {
  const patterns: string[] = [];
  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Remove trailing slash (directory indicator) - we treat as pattern anyway
    if (line.endsWith("/")) line = line.slice(0, -1);
    // Negation patterns - skip for simplicity
    if (line.startsWith("!")) continue;
    // Remove leading slash (root-anchored) - treat as normal pattern
    if (line.startsWith("/")) line = line.slice(1);
    if (line) patterns.push(line);
  }
  return patterns;
}

async function loadGitignore(): Promise<void> {
  if (!useGitignore) {
    gitignorePatterns = [];
    return;
  }
  try {
    const { content } = await host.readFile(".gitignore");
    gitignorePatterns = parseGitignore(content);
  } catch {
    gitignorePatterns = [];
  }
}

function isIgnoredPath(relativePath: string, ignorePatterns: string[]): boolean {
  if (ignorePatterns.length === 0 && !useGitignore && !ignoreDotfiles) return false;

  const segments = relativePath.split("/");

  // Ignore all dotfiles and dotfolders
  if (ignoreDotfiles) {
    for (const segment of segments) {
      if (segment.startsWith(".") && segment !== "." && segment !== "..") return true;
    }
  }

  // Check gitignore patterns
  if (useGitignore) {
    for (const pattern of gitignorePatterns) {
      if (pattern.includes("/")) {
        if (globToRegExp(pattern, true).test(relativePath)) return true;
      } else {
        const basename = segments[segments.length - 1];
        if (globMatch(pattern, basename)) return true;
        // Also check if any segment matches (for directory patterns)
        for (const seg of segments) {
          if (globMatch(pattern, seg)) return true;
        }
      }
    }
  }

  // Check user ignore patterns against full relative path
  for (const pattern of ignorePatterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    // If pattern has a slash, match against full path; otherwise match basename
    if (trimmed.includes("/")) {
      if (globToRegExp(trimmed, true).test(relativePath)) return true;
    } else {
      const basename = segments[segments.length - 1];
      if (globMatch(trimmed, basename)) return true;
    }
  }
  return false;
}

function renderStatus(text: string): void {
  statusEl.textContent = text;
}

function renderEmpty(message: string): void {
  for (const h of rowButtonHandles) h.dispose();
  rowButtonHandles.clear();
  resultsEl.className = "results empty";
  resultsEl.replaceChildren();
  stateHandle?.dispose();
  stateHandle = mountEmpty(resultsEl, { title: message });
}

function ensureResultsTable(): HTMLTableSectionElement {
  let body = resultsEl.querySelector("tbody");
  if (body) return body;

  resultsEl.className = "results";
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const [title, width] of [["Actions", "70px"], ["File", "220px"], ["Line", "40px"], ["Match", ""]]) {
    const header = document.createElement("th");
    header.textContent = title;
    if (width) header.style.width = width;
    headerRow.append(header);
  }
  head.append(headerRow);
  body = document.createElement("tbody");
  table.append(head, body);
  resultsEl.replaceChildren(table);
  return body;
}

function mountIconButton(root: HTMLElement, svgHtml: string, title: string, onClick: () => void): { dispose: () => void } {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.title = title;
  btn.className = "icon-btn";
  btn.innerHTML = svgHtml;
  btn.addEventListener("click", onClick);
  root.appendChild(btn);
  return {
    dispose: () => {
      btn.removeEventListener("click", onClick);
      btn.remove();
    },
  };
}

function addResultRow(filePath: string, lineNumber: number, lineText: string, start: number, length: number, query: string): void {
  const trimmedLine = lineText.trimStart();
  const leadingWhitespace = lineText.length - trimmedLine.length;
  // Adjust match position relative to the trimmed line
  const adjustedStart = Math.max(0, start - leadingWhitespace);
  const adjustedLength = Math.min(length, trimmedLine.length - adjustedStart);

  // Keep very long matches from making a result row unwieldy.
  const maxMatchPreview = 160;
  const displayedMatchLength = Math.min(adjustedLength, maxMatchPreview);
  const matchTruncated = adjustedLength > maxMatchPreview;

  // Limit context window around the displayed match: max 128 chars before, 256 after.
  const beforeMax = 128;
  const afterMax = 256;
  const windowStart = Math.max(0, adjustedStart - beforeMax);
  const afterMatchStart = adjustedStart + adjustedLength;
  const windowEnd = Math.min(trimmedLine.length, afterMatchStart + afterMax);
  const beforeText = trimmedLine.slice(windowStart, adjustedStart);
  const afterText = trimmedLine.slice(afterMatchStart, windowEnd);

  const row = document.createElement("tr");
  const pathCell = document.createElement("td");
  pathCell.className = "file-path";
  pathCell.title = filePath;
  const fileName = filePath.split("/").pop() || filePath;
  const nameLine = document.createElement("div");
  nameLine.textContent = fileName;
  const pathLine = document.createElement("div");
  pathLine.textContent = filePath;
  pathLine.style.fontFamily = "var(--oc-mono, monospace)";
  pathLine.style.fontSize = "11px";
  pathLine.style.opacity = "0.7";
  pathCell.appendChild(nameLine);
  pathCell.appendChild(pathLine);

  const lineCell = document.createElement("td");
  lineCell.className = "line-num";
  lineCell.textContent = String(lineNumber);

  const matchCell = document.createElement("td");
  const matchLine = document.createElement("div");
  matchLine.className = "match-line";
  if (windowStart > 0) matchLine.append(document.createTextNode("…"));
  matchLine.append(document.createTextNode(beforeText));
  const highlight = document.createElement("span");
  highlight.className = "highlight";
  highlight.textContent = trimmedLine.slice(adjustedStart, adjustedStart + displayedMatchLength);
  matchLine.append(highlight);
  if (matchTruncated) {
    const truncatedMarker = document.createElement("span");
    truncatedMarker.className = "match-truncated";
    truncatedMarker.textContent = "… [match truncated]";
    truncatedMarker.title = `Full match is ${adjustedLength} characters long`;
    matchLine.append(truncatedMarker);
  }
  matchLine.append(document.createTextNode(afterText));
  if (windowEnd < trimmedLine.length) matchLine.append(document.createTextNode("…"));
  matchCell.append(matchLine);

  const actionsCell = document.createElement("td");
  actionsCell.style.width = "70px";
  actionsCell.style.padding = "2px 4px";


  const addBtn = mountIconButton(actionsCell,
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    "Add to context",
    async () => {
      try {
        const contextText = `[${query}] found in ${filePath}:${lineNumber}`;
        await host.compose({ text: contextText, mode: "append" });
        await host.toast({ kind: "success", message: "Added to context" });
      } catch (err) {
        await host.toast({ kind: "error", message: `Failed to add to context: ${(err as Error).message}` });
      }
    },
  );
  rowButtonHandles.add(addBtn);

  // Button 2: Copy file path to clipboard (no open-file API exists in SDK)
  const copyBtn = mountIconButton(actionsCell,
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z"/></svg>',
    "Copy path",
    async () => {
      try {
        await host.writeClipboard(filePath);
        await host.toast({ kind: "success", message: `Copied ${filePath}` });
      } catch (err) {
        await host.toast({ kind: "error", message: `Failed to copy: ${(err as Error).message}` });
      }
    },
  );
  rowButtonHandles.add(copyBtn);

  row.append(actionsCell, pathCell, lineCell, matchCell);
  ensureResultsTable().append(row);

  matchCount++;
}

function progressText(): string {
  const skipped = skippedFiles + skippedDirectories;
  return `Scanning ${searchedFiles} files… ${matchCount} matches${skipped ? `; ${skipped} skipped` : ""}`;
}

async function searchFile(filePath: string, expression: RegExp): Promise<void> {
  try {
    const { content } = await host.readFile(filePath);
    searchedFiles++;

    const lines = content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (stopped) return;
      const line = lines[lineIndex];
      expression.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = expression.exec(line)) !== null) {
        addResultRow(filePath, lineIndex + 1, line, match.index, match[0].length, queryValue);
        if (match[0].length === 0) expression.lastIndex++;
      }
    }
  } catch {
    skippedFiles++;
  }
}

async function walkDirectory(
  directory: string,
  patterns: string[],
  ignorePatterns: string[],
  expression: RegExp,
): Promise<void> {
  if (stopped) return;

  let entries: { name: string; kind: string }[];
  try {
    ({ entries } = await host.listDir(directory));
  } catch {
    skippedDirectories++;
    return;
  }

  for (const entry of entries) {
    if (stopped) return;
    const relativePath = directory === "." ? entry.name : `${directory}/${entry.name}`;

    if (isIgnoredPath(relativePath, ignorePatterns)) continue;

    if (entry.kind === "directory") {
      await walkDirectory(relativePath, patterns, ignorePatterns, expression);
    } else if (entry.kind === "file" && matchesPattern(entry.name, patterns)) {
      await searchFile(relativePath, expression);
      if (searchedFiles % 10 === 0) renderStatus(progressText());
    }
  }
}

function setSearchControls(searching: boolean): void {
  searchBtn?.update({ loading: searching, disabled: searching });
  stopBtn?.update({ disabled: !searching });
  clearBtn?.update({ disabled: searching });
}

let searchBtn: { update: (props: { loading?: boolean; disabled?: boolean }) => void; dispose: () => void } | null = null;
let stopBtn: { update: (props: { disabled?: boolean }) => void; dispose: () => void } | null = null;
let clearBtn: { update: (props: { disabled?: boolean }) => void; dispose: () => void } | null = null;

async function runSearch(): Promise<void> {
  if (!projectAvailable) {
    renderStatus("No project directory open.");
    return;
  }

  const query = queryValue;
  if (!query.trim()) {
    renderStatus("Enter a search term.");
    return;
  }

  const patterns = patternInput.value.split(",").map((pattern) => pattern.trim()).filter(Boolean);
  const ignorePatterns = ignoreInput.value.split(",").map((pattern) => pattern.trim()).filter(Boolean);
  const flags = caseValue ? "g" : "gi";
  let expression: RegExp;
  try {
    expression = new RegExp(regexValue ? query : escapeRegExp(query), flags);
  } catch {
    renderStatus("Invalid regular expression.");
    return;
  }

  stopped = false;
  searchedFiles = 0;
  skippedFiles = 0;
  skippedDirectories = 0;
  matchCount = 0;
  resultsEl.className = "results empty";
  resultsEl.replaceChildren();
  stateHandle?.dispose();
  stateHandle = mountSpinner(resultsEl, { label: "Searching files" });
  setSearchControls(true);

  await loadGitignore();
  await walkDirectory(".", patterns, ignorePatterns, expression);

  stateHandle?.dispose();
  stateHandle = null;

  if (stopped) {
    renderStatus(`Stopped. ${matchCount} matches in ${searchedFiles} files; ${skippedFiles + skippedDirectories} skipped.`);
  } else if (matchCount === 0) {
    renderEmpty("No matches found.");
    renderStatus(`No matches. ${searchedFiles} files scanned; ${skippedFiles + skippedDirectories} skipped.`);
  } else {
    renderStatus(`${matchCount} matches in ${searchedFiles} files scanned; ${skippedFiles + skippedDirectories} skipped.`);
  }

  setSearchControls(false);
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);

  if (mounted) {
    projectAvailable = context.directory !== null;
    renderStatus(projectAvailable ? "Ready to search this project." : "No project open. Open a folder to search.");
    return;
  }
  mounted = true;

  projectAvailable = context.directory !== null;



  // Search field
  searchHandle = mountSearchField(searchFieldSlot, {
    value: queryValue,
    placeholder: "Search for string or regex",
    onChange: (next) => {
      queryValue = next;
      searchHandle?.update({ value: next });
    },
  });

  // Buttons
  searchBtn = mountButton(searchBtnSlot, {
    label: "Search",
    variant: "default",
    onClick: () => void runSearch(),
  });
  stopBtn = mountButton(stopBtnSlot, {
    label: "Stop",
    variant: "destructive",
    disabled: true,
    onClick: () => {
      stopped = true;
      stopBtn?.update({ disabled: true });
      renderStatus("Stopping…");
    },
  });
  clearBtn = mountButton(clearBtnSlot, {
    label: "Clear",
    variant: "ghost",
    onClick: () => {
      renderEmpty("No results yet. Enter a search term and click Search.");
      matchCount = 0;
      searchedFiles = 0;
      renderStatus("Cleared.");
    },
  });

  // Toggles
  regexHandle = mountCheckbox(regexSlot, {
    label: "Regex",
    checked: regexValue,
    onChange: (next) => {
      regexValue = next;
      regexHandle?.update({ checked: next });
    },
  });

  caseHandle = mountCheckbox(caseSlot, {
    label: "Case sensitive",
    checked: caseValue,
    onChange: (next) => {
      caseValue = next;
      caseHandle?.update({ checked: next });
    },
  });

  // Gitignore and dotfiles toggles
  const gitignoreSlot = document.querySelector("#gitignoreSlot") as HTMLElement;
  const dotfilesSlot = document.querySelector("#dotfilesSlot") as HTMLElement;

  gitignoreHandle = mountCheckbox(gitignoreSlot, {
    label: "Use .gitignore",
    checked: useGitignore,
    onChange: (next) => {
      useGitignore = next;
      gitignoreHandle?.update({ checked: next });
    },
  });

  dotfilesHandle = mountCheckbox(dotfilesSlot, {
    label: "Ignore dotfiles",
    checked: ignoreDotfiles,
    onChange: (next) => {
      ignoreDotfiles = next;
      dotfilesHandle?.update({ checked: next });
    },
  });

  renderStatus(projectAvailable ? "Ready to search this project." : "No project open. Open a folder to search.");
});

host.onDirectory((directory) => {
  if (searchBtnSlot.querySelector("button")?.disabled) stopped = true;
  projectAvailable = directory !== null;
  renderStatus(projectAvailable ? "Ready to search this project." : "No project open.");
});

const onEnter = (event: KeyboardEvent) => {
  if (event.key === "Enter") void runSearch();
};
patternInput.addEventListener("keydown", onEnter);
ignoreInput.addEventListener("keydown", onEnter);
searchFieldSlot.addEventListener("keydown", onEnter);












