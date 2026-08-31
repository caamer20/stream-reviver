import assert from "node:assert/strict";
import ts from "typescript";

const NETWORK_GLOBALS = new Set(["fetch", "XMLHttpRequest", "EventSource", "WebSocket"]);
const URL_ELEMENT_KINDS = new Set(["img", "image", "script", "iframe", "link", "audio", "video", "source"]);
const URL_PROPERTIES = new Set(["src", "srcset", "href"]);
const FORM_PROPERTIES = new Set(["action", "formAction"]);
const LOCAL_SCHEMES = ["data:", "blob:", "chrome-extension:", "moz-extension:", "about:"];

/** Inspect generated JavaScript with the TypeScript parser, not text matching. */
export function inspectNoEgress(source, fileName = "generated.js", options = {}) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  assert.equal(parseDiagnostics.length, 0, `${fileName} must be valid JavaScript before no-egress inspection`);

  const aliases = new Map();
  const urlElements = new Map();
  const forms = new Set();
  const localUrls = new Set();
  const functionStack = [];
  const findings = [];

  collectBindings(sourceFile);
  visit(sourceFile);
  return findings;

  function collectBindings(node) {
    if (ts.isVariableDeclaration(node)) collectVariable(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      collectIdentifier(node.left.text, node.right);
    }
    ts.forEachChild(node, collectBindings);
  }

  function collectVariable(name, initializer) {
    if (!initializer) return;
    if (ts.isIdentifier(name)) {
      collectIdentifier(name.text, initializer);
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name)) continue;
      const property = element.propertyName && bindingText(element.propertyName) || element.name.text;
      if (NETWORK_GLOBALS.has(property) || property === "sendBeacon") aliases.set(element.name.text, property);
    }
  }

  function collectIdentifier(name, initializer) {
    const reference = referenceName(initializer);
    const terminal = reference?.split(".").at(-1);
    if (terminal && (NETWORK_GLOBALS.has(terminal) || terminal === "sendBeacon")) aliases.set(name, terminal);
    const elementKind = createdElementKind(initializer);
    if (elementKind && URL_ELEMENT_KINDS.has(elementKind)) urlElements.set(name, elementKind);
    if (elementKind === "form") forms.add(name);
    if (isImageConstructor(initializer)) urlElements.set(name, "img");
    if (isLocalUrlExpression(initializer)) localUrls.add(name);
  }

  function visit(node) {
    const functionName = functionLikeName(node);
    if (functionName !== null) functionStack.push(functionName);

    if (ts.isCallExpression(node)) inspectCall(node);
    else if (ts.isNewExpression(node)) inspectConstruction(node);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) inspectAssignment(node.left, node.right);

    ts.forEachChild(node, visit);
    if (functionName !== null) functionStack.pop();
  }

  function inspectCall(node) {
    const reference = referenceName(node.expression);
    const terminal = reference?.split(".").at(-1);
    const alias = ts.isIdentifier(node.expression) ? aliases.get(node.expression.text) : undefined;
    if (terminal === "fetch" || alias === "fetch") add(node, "fetch", "Direct network request API");
    if (terminal === "XMLHttpRequest" || alias === "XMLHttpRequest") add(node, "XMLHttpRequest", "Network request constructor called as a function");
    if (terminal === "EventSource" || alias === "EventSource") add(node, "EventSource", "Server-sent event connection");
    if (terminal === "WebSocket" || alias === "WebSocket") add(node, "WebSocket", "WebSocket connection");
    if (terminal === "sendBeacon" || alias === "sendBeacon") add(node, "sendBeacon", "Beacon network request");

    if (terminal === "submit" || terminal === "requestSubmit") add(node, "form-submit", "Programmatic form submission");
    if (["assign", "replace"].includes(terminal ?? "") && isLocationExpression(propertyReceiver(node.expression))) {
      if (!isAllowedUserNavigation(node.arguments[0])) add(node, "location-navigation", "Programmatic location navigation");
    }
    if (terminal === "open" && isWindowExpression(propertyReceiver(node.expression))) {
      add(node, "window-open", "Programmatic window navigation");
    }

    if (terminal === "setAttribute" && node.arguments.length >= 2) {
      const receiver = propertyReceiver(node.expression);
      const property = staticString(node.arguments[0]);
      if (property && URL_PROPERTIES.has(property.toLowerCase()) && isUrlElement(receiver)) {
        inspectUrlSink(node, "element-url", node.arguments[1]);
      }
      if (property && FORM_PROPERTIES.has(property) && isForm(receiver)) inspectUrlSink(node, "form-action", node.arguments[1]);
    }
  }

  function inspectConstruction(node) {
    const terminal = referenceName(node.expression)?.split(".").at(-1);
    const alias = ts.isIdentifier(node.expression) ? aliases.get(node.expression.text) : undefined;
    const kind = alias ?? terminal;
    if (kind === "XMLHttpRequest") add(node, "XMLHttpRequest", "Network request constructor");
    if (kind === "EventSource") add(node, "EventSource", "Server-sent event connection");
    if (kind === "WebSocket") add(node, "WebSocket", "WebSocket connection");
  }

  function inspectAssignment(left, right) {
    if (isLocationExpression(left) || isLocationProperty(left)) {
      if (!isAllowedUserNavigation(right)) inspectUrlSink(left, "location-navigation", right);
      return;
    }
    if (!isPropertyAccess(left)) return;
    const receiver = propertyReceiver(left);
    const property = propertyName(left);
    if (property && URL_PROPERTIES.has(property) && isUrlElement(receiver)) inspectUrlSink(left, "element-url", right);
    if (property && FORM_PROPERTIES.has(property) && isForm(receiver)) inspectUrlSink(left, "form-action", right);
  }

  function inspectUrlSink(node, kind, value) {
    if (isLocalUrlExpression(value)) return;
    if (isAllowedLocalImageParameter(value)) return;
    add(node, kind, "Dynamic or external URL assigned to a browser egress sink");
  }

  function isAllowedLocalImageParameter(node) {
    if (!ts.isIdentifier(node)) return false;
    const current = functionStack.at(-1);
    const allowed = options.localDataImageParameters?.[current] ?? [];
    return allowed.includes(node.text);
  }

  function isAllowedUserNavigation(node) {
    if (!ts.isIdentifier(node)) return false;
    const current = functionStack.at(-1);
    const allowed = options.userNavigationIdentifiers?.[current] ?? [];
    return allowed.includes(node.text);
  }

  function isLocalUrlExpression(node) {
    if (!node) return false;
    const literal = staticString(node);
    if (literal !== null) return LOCAL_SCHEMES.some((scheme) => literal.startsWith(scheme));
    if (ts.isIdentifier(node)) return localUrls.has(node.text);
    if (ts.isParenthesizedExpression(node)) return isLocalUrlExpression(node.expression);
    if (ts.isConditionalExpression(node)) return isLocalUrlExpression(node.whenTrue) && isLocalUrlExpression(node.whenFalse);
    if (ts.isCallExpression(node)) {
      const reference = referenceName(node.expression);
      return reference === "URL.createObjectURL" || reference?.endsWith(".runtime.getURL") === true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return isLocalUrlExpression(node.left);
    return false;
  }

  function isUrlElement(node) {
    if (!node) return false;
    if (ts.isIdentifier(node)) return urlElements.has(node.text);
    return isImageConstructor(node) || URL_ELEMENT_KINDS.has(createdElementKind(node) ?? "");
  }

  function isForm(node) {
    if (!node) return false;
    if (ts.isIdentifier(node)) return forms.has(node.text);
    return createdElementKind(node) === "form";
  }

  function add(node, kind, description) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({ file: fileName, line: position.line + 1, column: position.character + 1, kind, description });
  }
}

export function assertNoEgressInSource(source, fileName = "generated.js", options = {}) {
  const findings = inspectNoEgress(source, fileName, options);
  assert.equal(
    findings.length,
    0,
    `${fileName} contains forbidden outbound-network/navigation capability:\n${findings.map(formatFinding).join("\n")}`
  );
}

export function inspectHtmlEgress(source, fileName = "generated.html") {
  const findings = [];
  const patterns = [
    [/<form\b[^>]*\baction\s*=\s*["']?\s*(?:https?:)?\/\//gi, "form-action"],
    [/<(?:img|iframe|script|link)\b[^>]*(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//gi, "remote-resource"],
    [/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\burl\s*=\s*(?:https?:)?\/\//gi, "meta-refresh"]
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(0, match.index);
      const line = before.split("\n").length;
      findings.push({ file: fileName, line, column: match.index - before.lastIndexOf("\n"), kind, description: "Remote HTML egress sink" });
    }
  }
  return findings;
}

export function assertNoEgressInHtml(source, fileName = "generated.html") {
  const findings = inspectHtmlEgress(source, fileName);
  assert.equal(findings.length, 0, `${fileName} contains remote HTML egress:\n${findings.map(formatFinding).join("\n")}`);
}

function createdElementKind(node) {
  if (!ts.isCallExpression(node) || referenceName(node.expression)?.split(".").at(-1) !== "createElement") return null;
  return staticString(node.arguments[0])?.toLowerCase() ?? null;
}

function isImageConstructor(node) {
  return ts.isNewExpression(node) && referenceName(node.expression)?.split(".").at(-1) === "Image";
}

function referenceName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const left = referenceName(node.expression);
    return left ? `${left}.${node.name.text}` : node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    const left = referenceName(node.expression);
    const right = staticString(node.argumentExpression);
    return left && right ? `${left}.${right}` : null;
  }
  if (ts.isParenthesizedExpression(node)) return referenceName(node.expression);
  return null;
}

function isPropertyAccess(node) {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function propertyReceiver(node) {
  return isPropertyAccess(node) ? node.expression : null;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return staticString(node.argumentExpression);
  return null;
}

function isLocationExpression(node) {
  const name = referenceName(node);
  return name === "location" || name === "window.location" || name === "document.location" || name === "top.location" || name === "self.location";
}

function isLocationProperty(node) {
  if (!isPropertyAccess(node) || propertyName(node) !== "href") return false;
  return isLocationExpression(propertyReceiver(node));
}

function isWindowExpression(node) {
  const name = referenceName(node);
  return name === "window" || name === "globalThis" || name === "self";
}

function staticString(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function bindingText(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : null;
}

function functionLikeName(node) {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "<anonymous>";
  if (ts.isMethodDeclaration(node)) return bindingText(node.name) ?? "<anonymous>";
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return null;
}

function formatFinding(finding) {
  return `- ${finding.file}:${finding.line}:${finding.column} [${finding.kind}] ${finding.description}`;
}
