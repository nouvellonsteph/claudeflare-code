/** Map file extension to a display label and Tailwind text color */
export function getFileIconInfo(filename: string): {
  label: string;
  colorClass: string;
} {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, { label: string; colorClass: string }> = {
    ts: { label: "TS", colorClass: "text-blue-400" },
    tsx: { label: "TX", colorClass: "text-blue-400" },
    js: { label: "JS", colorClass: "text-yellow-400" },
    jsx: { label: "JX", colorClass: "text-yellow-400" },
    json: { label: "{}", colorClass: "text-kumo-subtle" },
    jsonc: { label: "{}", colorClass: "text-kumo-subtle" },
    md: { label: "#", colorClass: "text-blue-300" },
    py: { label: "PY", colorClass: "text-green-400" },
    rs: { label: "RS", colorClass: "text-orange-400" },
    go: { label: "GO", colorClass: "text-cyan-400" },
    html: { label: "<>", colorClass: "text-orange-500" },
    css: { label: "##", colorClass: "text-purple-400" },
    sh: { label: "$ ", colorClass: "text-green-300" },
    bash: { label: "$ ", colorClass: "text-green-300" },
    yml: { label: "Y ", colorClass: "text-pink-300" },
    yaml: { label: "Y ", colorClass: "text-pink-300" },
    toml: { label: "TL", colorClass: "text-kumo-subtle" },
    sql: { label: "SQ", colorClass: "text-blue-200" },
    mjs: { label: "MJ", colorClass: "text-yellow-400" },
    cjs: { label: "CJ", colorClass: "text-yellow-400" },
    svg: { label: "SV", colorClass: "text-yellow-200" },
    xml: { label: "XM", colorClass: "text-orange-300" },
    lock: { label: "LK", colorClass: "text-kumo-subtle" },
  };
  return map[ext] || { label: "  ", colorClass: "text-kumo-subtle" };
}

export function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    json: "json",
    jsonc: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    sh: "bash",
    bash: "bash",
    toml: "toml",
    sql: "sql",
    xml: "xml",
  };
  return map[ext] || "plaintext";
}
