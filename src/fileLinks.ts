export interface LocalFileTarget {
  path: string;
  line?: number;
}

export function localFileTarget(href: string | undefined, cwd: string): LocalFileTarget | null {
  if (!href || href.startsWith("#")) return null;

  let rawPath: string;
  if (href.startsWith("file://")) {
    try {
      const url = new URL(href);
      rawPath = url.pathname;
      if (url.hash) rawPath += url.hash;
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return null;
  } else {
    rawPath = href;
  }

  try {
    rawPath = decodeURIComponent(rawPath);
  } catch {
    // Keep malformed percent escapes visible and copyable instead of hiding the link.
  }

  const reference = extractLineReference(rawPath);
  const absolutePath = reference.path.startsWith("/")
    ? normalizePath(reference.path)
    : normalizePath(`${cwd}/${reference.path}`);
  if (!absolutePath.startsWith("/")) return null;
  return { path: absolutePath, ...(reference.line ? { line: reference.line } : {}) };
}

function extractLineReference(path: string): LocalFileTarget {
  const hashMatch = path.match(/#L(\d+)(?:C\d+)?$/i);
  if (hashMatch) {
    return { path: path.slice(0, -hashMatch[0].length), line: Number(hashMatch[1]) };
  }
  const suffixMatch = path.match(/:(\d+)(?::\d+)?$/);
  if (suffixMatch) {
    return { path: path.slice(0, -suffixMatch[0].length), line: Number(suffixMatch[1]) };
  }
  return { path };
}

function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
